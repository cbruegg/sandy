import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { DockerSandboxRunner } from "./sandbox/docker-sandbox-runner.js";
import type { ChannelFormatting, SubAgentEvent } from "./types.js";

const testFormatting: ChannelFormatting = {
  channelId: "telegram",
  markup: "telegram_html",
  allowedTags: ["b", "i", "code", "pre"],
  instructions: "Use simple Telegram HTML.",
};

class FakeStdin {
  public readonly writes: string[] = [];
  public failNextWrite = false;
  public endCalls = 0;

  write(chunk: Buffer | string, callback: (error?: Error | null) => void): boolean {
    this.writes.push(String(chunk));
    if (this.failNextWrite) {
      this.failNextWrite = false;
      callback(new Error("broken pipe"));
      return false;
    }
    callback(null);
    return true;
  }

  end(): void {
    this.endCalls += 1;
  }
}

class FakeChildProcess extends EventEmitter {
  public readonly stdin = new FakeStdin();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly killSignals: Array<NodeJS.Signals | number> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal ?? "SIGTERM");
    return true;
  }
}

type FakeTimer = {
  cleared: boolean;
  fn: () => void;
};

function createTimerController() {
  const timers: FakeTimer[] = [];

  return {
    setTimeoutImpl: ((fn: () => void) => {
      const timer: FakeTimer = {
        cleared: false,
        fn,
      };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimeoutImpl: ((timer: NodeJS.Timeout) => {
      (timer as unknown as FakeTimer).cleared = true;
    }) as typeof clearTimeout,
    triggerAll: () => {
      for (const timer of timers) {
        if (!timer.cleared) {
          timer.fn();
        }
      }
    },
  };
}

function createSpawnHarness(taskChild: FakeChildProcess) {
  const invocations: Array<{ command: string; args: string[] }> = [];

  const spawnImpl = ((command: string, args: readonly string[]) => {
    invocations.push({ command, args: [...args] });
    if (args[0] === "run") {
      return taskChild as unknown as ChildProcessWithoutNullStreams;
    }

    const cleanupChild = new FakeChildProcess();
    queueMicrotask(() => {
      cleanupChild.emit("exit", 0, null);
    });
    return cleanupChild as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  return {
    invocations,
    spawnImpl,
  };
}

async function launchRunnerWithChild(
  taskChild: FakeChildProcess,
  onEvent: (event: SubAgentEvent) => Promise<void>,
  options?: {
    handshakeTimeoutMs?: number;
    shareRoot?: string;
    builtWorkerCodexConfigToml?: string | null;
    codexModel?: string | null;
    skillsDirectory?: string | null;
    workerCodexBinaryPath?: string | null;
    workerNetworkName?: string | null;
    resolveWorkerImage?: () => string;
  },
) {
  const timers = createTimerController();
  const harness = createSpawnHarness(taskChild);
  const runner = new DockerSandboxRunner({
    workerImage: "sandy-subagent:latest",
    resolveWorkerImage: options?.resolveWorkerImage,
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: options?.shareRoot ?? "/tmp/sandy-test-shares",
    codexModel: options?.codexModel,
    openAiApiKey: null,
    codexAuthFile: null,
    skillsDirectory: options?.skillsDirectory ?? null,
    workerCodexBinaryPath: options?.workerCodexBinaryPath,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: options?.builtWorkerCodexConfigToml ?? null,
      environment: {},
    }),
    workerNetworkName: options?.workerNetworkName,
    handshakeTimeoutMs: options?.handshakeTimeoutMs ?? 10_000,
    spawnImpl: harness.spawnImpl,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  const handle = await runner.launchTask(
    {
      chatId: "chat-1",
      taskId: "task-1",
      taskName: "test-task",
      taskLanguage: "English",
      taskBrief: "Inspect the environment.",
      channelFormatting: testFormatting,
    },
    onEvent,
  );

  return {
    handle,
    timers,
    invocations: harness.invocations,
  };
}

function flushEvents(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function waitFor(check: () => Promise<void>, attempts = 10): Promise<void> {
  let lastError: unknown = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      await check();
      return;
    } catch (error) {
      lastError = error;
      await flushEvents();
    }
  }
  throw lastError;
}

test("DockerSandboxRunner waits for an explicit worker_connected handshake", async () => {
  const taskChild = new FakeChildProcess();
  const events: SubAgentEvent[] = [];

  const { invocations } = await launchRunnerWithChild(taskChild, async (event) => {
    events.push(event);
  });

  assert.deepEqual(events, []);
  assert.ok(invocations.some((invocation) => invocation.args[0] === "run" && invocation.args.includes("-i")));

  taskChild.stdout.write('{"type":"worker_connected"}\n');
  await flushEvents();

  assert.deepEqual(events, [{ type: "worker_connected" }]);
});

test("DockerSandboxRunner passes channel formatting as a docker environment variable", async () => {
  const taskChild = new FakeChildProcess();

  const { invocations } = await launchRunnerWithChild(taskChild, async () => {});

  const dockerRunInvocation = invocations.find((invocation) => invocation.args[0] === "run");
  assert.ok(dockerRunInvocation);
  const taskLanguageIndex = dockerRunInvocation.args.findIndex((arg) =>
    arg.startsWith("SANDY_TASK_LANGUAGE="));
  assert.notEqual(taskLanguageIndex, -1);
  assert.equal(dockerRunInvocation.args[taskLanguageIndex - 1], "-e");
  const channelFormattingIndex = dockerRunInvocation.args.findIndex((arg) =>
    arg.startsWith("SANDY_CHANNEL_FORMATTING="));
  assert.notEqual(channelFormattingIndex, -1);
  assert.equal(dockerRunInvocation.args[channelFormattingIndex - 1], "-e");
});

test("DockerSandboxRunner passes the configured Codex model into the worker container", async () => {
  const taskChild = new FakeChildProcess();
  const invocationsWithModel: Array<{ command: string; args: string[] }> = [];
  const spawnImpl = ((command: string, args: readonly string[]) => {
    invocationsWithModel.push({ command, args: [...args] });
    if (args[0] === "run") {
      return taskChild as unknown as ChildProcessWithoutNullStreams;
    }
    const cleanupChild = new FakeChildProcess();
    queueMicrotask(() => {
      cleanupChild.emit("exit", 0, null);
    });
    return cleanupChild as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const runner = new DockerSandboxRunner({
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: "/tmp/sandy-test-shares",
    codexModel: "gpt-5.4-mini",
    openAiApiKey: null,
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
    spawnImpl,
  });

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-1",
    taskName: "test-task",
    taskLanguage: "English",
    taskBrief: "Inspect the environment.",
    channelFormatting: testFormatting,
  }, async () => {});

  const dockerRunInvocation = invocationsWithModel.find((invocation) => invocation.args[0] === "run");
  assert.ok(dockerRunInvocation);
  assert.ok(dockerRunInvocation.args.includes("SANDY_CODEX_MODEL=gpt-5.4-mini"));
});

test("DockerSandboxRunner reports a disconnect when the handshake times out", async () => {
  const taskChild = new FakeChildProcess();
  const events: SubAgentEvent[] = [];
  const { timers, invocations } = await launchRunnerWithChild(taskChild, async (event) => {
    events.push(event);
  }, { handshakeTimeoutMs: 5 });

  timers.triggerAll();
  await flushEvents();

  assert.deepEqual(events, [{
    type: "worker_disconnected",
    message: "Sub-agent worker did not complete startup handshake in time.",
  }]);
  assert.deepEqual(taskChild.killSignals, ["SIGTERM"]);
  assert.ok(invocations.some((invocation) => invocation.args[0] === "rm"));
});

test("DockerSandboxRunner does not report a disconnect after a clean terminal event and exit", async () => {
  const taskChild = new FakeChildProcess();
  const events: SubAgentEvent[] = [];

  await launchRunnerWithChild(taskChild, async (event) => {
    events.push(event);
  });

  taskChild.stdout.write('{"type":"worker_connected"}\n');
  taskChild.stdout.write('{"type":"task_done"}\n');
  await flushEvents();

  taskChild.emit("exit", 0, null);
  await flushEvents();

  assert.deepEqual(events, [
    { type: "worker_connected" },
    { type: "task_done" },
  ]);
});

test("DockerSandboxRunner reports a disconnect when the container exits before a terminal event", async () => {
  const taskChild = new FakeChildProcess();
  const events: SubAgentEvent[] = [];

  await launchRunnerWithChild(taskChild, async (event) => {
    events.push(event);
  });

  taskChild.stdout.write('{"type":"worker_connected"}\n');
  await flushEvents();

  taskChild.emit("exit", 1, null);
  await flushEvents();

  assert.deepEqual(events, [
    { type: "worker_connected" },
    {
      type: "worker_disconnected",
      message: "Sub-agent container exited before task completion (code=1, signal=null).",
    },
  ]);
});

test("DockerSandboxRunner reports a disconnect when writing to the worker stdin fails", async () => {
  const taskChild = new FakeChildProcess();
  const events: SubAgentEvent[] = [];
  const { handle } = await launchRunnerWithChild(taskChild, async (event) => {
    events.push(event);
  });

  taskChild.stdout.write('{"type":"worker_connected"}\n');
  await flushEvents();

  taskChild.stdin.failNextWrite = true;
  await handle.sendUserMessage("hello");
  await flushEvents();

  assert.deepEqual(events, [
    { type: "worker_connected" },
    {
      type: "worker_disconnected",
      message: "Sub-agent control channel write failed: broken pipe",
    },
  ]);
});

test("DockerSandboxRunner terminates the container if event delivery rejects", async () => {
  const taskChild = new FakeChildProcess();
  const events: SubAgentEvent[] = [];
  const { invocations } = await launchRunnerWithChild(taskChild, async (event) => {
    events.push(event);
    if (event.type === "progress") {
      throw new Error("event handler failed");
    }
  });

  taskChild.stdout.write('{"type":"worker_connected"}\n');
  await flushEvents();

  taskChild.stderr.write("background warning\n");
  await flushEvents();

  assert.deepEqual(events, [{ type: "worker_connected" }]);
  assert.deepEqual(taskChild.killSignals, []);
  assert.ok(!invocations.some((invocation) => invocation.args[0] === "rm"));
});

test("DockerSandboxRunner does not forward Docker pull stderr as progress", async () => {
  const taskChild = new FakeChildProcess();
  const events: SubAgentEvent[] = [];

  await launchRunnerWithChild(taskChild, async (event) => {
    events.push(event);
  });

  taskChild.stderr.write("Unable to find image 'ghcr.io/example/sandy-subagent:sha-abc' locally\n");
  taskChild.stderr.write("sha-abc: Pulling from example/sandy-subagent\n");
  taskChild.stderr.write("e94e463cb186: Pulling fs layer\nf429832b271f: Waiting\n");
  taskChild.stderr.write("f429832b271f: Verifying Checksum\nf429832b271f: Download complete\n");
  await flushEvents();

  assert.deepEqual(events, []);
});

test("DockerSandboxRunner does not forward non-Docker stderr as progress", async () => {
  const taskChild = new FakeChildProcess();
  const events: SubAgentEvent[] = [];

  await launchRunnerWithChild(taskChild, async (event) => {
    events.push(event);
  });

  taskChild.stderr.write("background warning\n");
  await flushEvents();

  assert.deepEqual(events, []);
});

test("DockerSandboxRunner cancellation does not emit a spurious disconnect", async () => {
  const taskChild = new FakeChildProcess();
  const events: SubAgentEvent[] = [];
  const { handle } = await launchRunnerWithChild(taskChild, async (event) => {
    events.push(event);
  });

  taskChild.stdout.write('{"type":"worker_connected"}\n');
  await flushEvents();

  await handle.cancel("cancelled by test");
  taskChild.emit("exit", null, "SIGTERM");
  await flushEvents();

  assert.deepEqual(events, [{ type: "worker_connected" }]);
});

test("DockerSandboxRunner close shuts down the worker stdin without reporting a disconnect", async () => {
  const taskChild = new FakeChildProcess();
  const events: SubAgentEvent[] = [];
  const { handle } = await launchRunnerWithChild(taskChild, async (event) => {
    events.push(event);
  });

  taskChild.stdout.write('{"type":"worker_connected"}\n');
  await flushEvents();

  await handle.close();
  taskChild.emit("exit", 0, null);
  await flushEvents();

  assert.equal(taskChild.stdin.endCalls, 1);
  assert.deepEqual(events, [{ type: "worker_connected" }]);
});

test("DockerSandboxRunner shutdown terminates every active container it started", async () => {
  const firstTaskChild = new FakeChildProcess();
  const secondTaskChild = new FakeChildProcess();
  const invocations: Array<{ command: string; args: string[] }> = [];
  const taskChildren = [firstTaskChild, secondTaskChild];

  const spawnImpl = ((command: string, args: readonly string[]) => {
    invocations.push({ command, args: [...args] });
    if (args[0] === "run") {
      const taskChild = taskChildren.shift();
      assert.ok(taskChild, "Expected a task child for docker run.");
      return taskChild as unknown as ChildProcessWithoutNullStreams;
    }

    const cleanupChild = new FakeChildProcess();
    queueMicrotask(() => {
      cleanupChild.emit("exit", 0, null);
    });
    return cleanupChild as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const runner = new DockerSandboxRunner({
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: "/tmp/sandy-test-shares",
    openAiApiKey: null,
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
    spawnImpl,
  });

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-1",
    taskName: "test-task-1",
    taskLanguage: "English",
    taskBrief: "Inspect the environment.",
    channelFormatting: testFormatting,
  }, async () => {});

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-2",
    taskName: "test-task-2",
    taskLanguage: "English",
    taskBrief: "Inspect the environment again.",
    channelFormatting: testFormatting,
  }, async () => {});

  await runner.shutdown();
  await flushEvents();

  assert.deepEqual(firstTaskChild.killSignals, ["SIGTERM"]);
  assert.deepEqual(secondTaskChild.killSignals, ["SIGTERM"]);
  assert.equal(invocations.filter((invocation) => invocation.args[0] === "rm").length, 2);
});

test("DockerSandboxRunner inspects and deletes task shares on the host", async () => {
  const shareRoot = mkdtempSync(join(tmpdir(), "sandy-share-test-"));
  const runner = new DockerSandboxRunner({
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot,
    openAiApiKey: null,
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
  });

  const taskShare = join(shareRoot, "task-1");
  await mkdir(join(taskShare, "logs"), { recursive: true });
  await writeFile(join(taskShare, "report.txt"), "ok\n");
  await writeFile(join(taskShare, "logs", "latest.log"), "done\n");

  const inspection = await runner.inspectTaskShare("task-1");
  assert.equal(inspection.isEmpty, false);
  assert.match(inspection.summary ?? "", /report\.txt/);
  assert.match(inspection.summary ?? "", /logs\//);
  assert.match(inspection.summary ?? "", /latest\.log/);

  await runner.deleteTaskShare("task-1");
  await assert.rejects(access(taskShare));
  await rm(shareRoot, { recursive: true, force: true });
});

test("DockerSandboxRunner mounts a writable worker Codex home from a temp path outside the task share", async () => {
  const shareRoot = mkdtempSync(join(tmpdir(), "sandy-share-config-"));
  const taskChild = new FakeChildProcess();

  const { invocations } = await launchRunnerWithChild(taskChild, async () => {}, {
    shareRoot,
    builtWorkerCodexConfigToml: "model = \"gpt-5\"\n",
  });

  const taskShare = join(shareRoot, "task-1");
  assert.deepEqual(await readdir(taskShare), []);

  const dockerRunInvocation = invocations.find((invocation) => invocation.args[0] === "run");
  assert.ok(dockerRunInvocation);
  const codexMountArg = dockerRunInvocation.args.find((arg) => arg.endsWith(":/run/sandy-codex-seed:ro"));
  assert.ok(codexMountArg);
  assert.doesNotMatch(codexMountArg, /\/task-1\/.*:\/run\/sandy-codex-seed:ro/);

  const codexHomeHostPath = codexMountArg.slice(0, codexMountArg.indexOf(":/run/sandy-codex-seed:ro"));
  assert.match(codexHomeHostPath, /sandy-worker-codex-home-/);
  const configHostPath = join(codexHomeHostPath, "config.toml");
  assert.equal(await readFile(configHostPath, "utf8"), "model = \"gpt-5\"\n");
  assert.equal(dockerRunInvocation.args.at(-1), "sandy-subagent:latest");
  assert.ok(!dockerRunInvocation.args.includes("--entrypoint"));
  assert.ok(!dockerRunInvocation.args.includes("--user"));

  taskChild.emit("exit", 0, null);
  await waitFor(() => assert.rejects(access(codexHomeHostPath)));
  await rm(shareRoot, { recursive: true, force: true });
});

test("DockerSandboxRunner mounts configured skills read-only into the worker", async () => {
  const taskChild = new FakeChildProcess();
  const skillsDirectory = "/tmp/sandy-config/skills";

  const { invocations } = await launchRunnerWithChild(taskChild, async () => {}, {
    skillsDirectory,
  });

  const dockerRunInvocation = invocations.find((invocation) => invocation.args[0] === "run");
  assert.ok(dockerRunInvocation);
  assert.ok(dockerRunInvocation.args.includes(`${skillsDirectory}:/root/.agents/skills:ro`));
});

test("DockerSandboxRunner does not mount skills when no skills directory is configured", async () => {
  const taskChild = new FakeChildProcess();

  const { invocations } = await launchRunnerWithChild(taskChild, async () => {}, {
    skillsDirectory: null,
  });

  const dockerRunInvocation = invocations.find((invocation) => invocation.args[0] === "run");
  assert.ok(dockerRunInvocation);
  assert.ok(!dockerRunInvocation.args.includes("/root/.agents/skills:ro"));
});

test("DockerSandboxRunner mounts the host-managed worker Codex binary read-only", async () => {
  const taskChild = new FakeChildProcess();
  const workerCodexBinaryPath = "/tmp/sandy-codex/linux/codex";

  const { invocations } = await launchRunnerWithChild(taskChild, async () => {}, {
    workerCodexBinaryPath,
  });

  const dockerRunInvocation = invocations.find((invocation) => invocation.args[0] === "run");
  assert.ok(dockerRunInvocation);
  assert.ok(dockerRunInvocation.args.includes("SANDY_CODEX_PATH=/usr/local/bin/codex"));
  assert.ok(dockerRunInvocation.args.includes(`${workerCodexBinaryPath}:/usr/local/bin/codex:ro`));
});

test("DockerSandboxRunner joins the configured worker network when provided", async () => {
  const taskChild = new FakeChildProcess();
  const { invocations } = await launchRunnerWithChild(taskChild, async () => {}, {
    workerNetworkName: "sandy-mcp-net",
  });

  const dockerRunInvocation = invocations.find((invocation) => invocation.args[0] === "run");
  assert.ok(dockerRunInvocation);
  assert.ok(dockerRunInvocation.args.includes("--network"));
  assert.ok(dockerRunInvocation.args.includes("sandy-mcp-net"));
  assert.ok(!dockerRunInvocation.args.includes("host.docker.internal:host-gateway"));
});

test("DockerSandboxRunner launches a network guard and shares its network namespace in restricted mode", async () => {
  const guardChild = new FakeChildProcess();
  const taskChild = new FakeChildProcess();
  const invocations: Array<{ command: string; args: string[] }> = [];
  let runCount = 0;

  const spawnImpl = ((command: string, args: readonly string[]) => {
    invocations.push({ command, args: [...args] });
    if (args[0] === "run") {
      runCount += 1;
      if (runCount === 1) {
        queueMicrotask(() => {
          guardChild.stdout.write("ready\n");
        });
        return guardChild as unknown as ChildProcessWithoutNullStreams;
      }
      return taskChild as unknown as ChildProcessWithoutNullStreams;
    }

    const cleanupChild = new FakeChildProcess();
    queueMicrotask(() => {
      cleanupChild.emit("exit", 0, null);
    });
    return cleanupChild as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const runner = new DockerSandboxRunner({
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: "/tmp/sandy-test-shares",
    openAiApiKey: null,
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "public_internet_only",
      allowLocalCidrs: ["192.168.178.0/24", "fd00::/8"],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
    workerNetworkName: "sandy-mcp-net",
    spawnImpl,
  });

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-1",
    taskName: "test-task",
    taskLanguage: "English",
    taskBrief: "Inspect the environment.",
    channelFormatting: testFormatting,
  }, async () => {});

  const guardRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.at(-1) === "sandy-network-guard:latest");
  assert.ok(guardRunInvocation);
  assert.ok(guardRunInvocation.args.includes("--cap-add"));
  assert.ok(guardRunInvocation.args.includes("NET_ADMIN"));
  assert.ok(guardRunInvocation.args.includes("--network"));
  assert.ok(guardRunInvocation.args.includes("sandy-mcp-net"));
  assert.ok(guardRunInvocation.args.includes("SANDY_NETWORK_GUARD_ALLOWED_LOCAL_CIDRS=192.168.178.0/24,fd00::/8"));
  assert.ok(guardRunInvocation.args.includes(`SANDY_NETWORK_GUARD_ALLOWED_HOSTS=${"sandy-mcp-proxy"}`));

  const workerRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.at(-1) === "sandy-subagent:latest");
  assert.ok(workerRunInvocation);
  assert.ok(workerRunInvocation.args.includes("--network"));
  assert.ok(workerRunInvocation.args.includes("container:sandy-netguard-task-1"));
  assert.ok(workerRunInvocation.args.includes("--cap-drop"));
  assert.ok(workerRunInvocation.args.includes("NET_RAW"));
  assert.ok(!workerRunInvocation.args.includes("sandy-mcp-net"));
});

test("DockerSandboxRunner reports a disconnect when the network guard exits mid-task", async () => {
  const guardChild = new FakeChildProcess();
  const taskChild = new FakeChildProcess();
  const events: SubAgentEvent[] = [];
  const invocations: Array<{ command: string; args: string[] }> = [];
  let runCount = 0;

  const spawnImpl = ((command: string, args: readonly string[]) => {
    invocations.push({ command, args: [...args] });
    if (args[0] === "run") {
      runCount += 1;
      if (runCount === 1) {
        queueMicrotask(() => {
          guardChild.stdout.write("ready\n");
        });
        return guardChild as unknown as ChildProcessWithoutNullStreams;
      }
      return taskChild as unknown as ChildProcessWithoutNullStreams;
    }

    const cleanupChild = new FakeChildProcess();
    queueMicrotask(() => {
      cleanupChild.emit("exit", 0, null);
    });
    return cleanupChild as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const runner = new DockerSandboxRunner({
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: "/tmp/sandy-test-shares",
    openAiApiKey: null,
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "public_internet_only",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
    spawnImpl,
  });

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-1",
    taskName: "test-task",
    taskLanguage: "English",
    taskBrief: "Inspect the environment.",
    channelFormatting: testFormatting,
  }, async (event) => {
    events.push(event);
  });

  taskChild.stdout.write('{"type":"worker_connected"}\n');
  await flushEvents();

  guardChild.emit("exit", 1, null);
  await flushEvents();

  assert.deepEqual(events, [
    { type: "worker_connected" },
    {
      type: "worker_disconnected",
      message: "Task network guard exited before task completion (code=1, signal=null).",
    },
  ]);
  assert.deepEqual(taskChild.killSignals, ["SIGTERM"]);
  assert.equal(invocations.filter((invocation) => invocation.args[0] === "rm").length, 2);
});

test("DockerSandboxRunner resolves the worker image at launch time", async () => {
  const taskChild = new FakeChildProcess();
  const { invocations } = await launchRunnerWithChild(taskChild, async () => {}, {
    resolveWorkerImage: () => "sandy-worker-overlay:test",
  });

  const dockerRunInvocation = invocations.find((invocation) => invocation.args[0] === "run");
  assert.ok(dockerRunInvocation);
  assert.equal(dockerRunInvocation.args.at(-1), "sandy-worker-overlay:test");
});

test("DockerSandboxRunner rejects share inspection outside the configured share root", async () => {
  const baseRoot = mkdtempSync(join(tmpdir(), "sandy-share-escape-"));
  const shareRoot = join(baseRoot, "shares");
  const outsidePath = join(baseRoot, "outside");
  const runner = new DockerSandboxRunner({
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot,
    openAiApiKey: null,
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
  });

  await mkdir(shareRoot, { recursive: true });
  await mkdir(outsidePath, { recursive: true });
  await writeFile(join(outsidePath, "keep.txt"), "safe\n");

  await assert.rejects(
    runner.inspectTaskShare("../outside"),
    /escapes the configured share root/,
  );

  await assert.doesNotReject(access(join(outsidePath, "keep.txt")));
  await rm(baseRoot, { recursive: true, force: true });
});

test("DockerSandboxRunner rejects share deletion outside the configured share root", async () => {
  const baseRoot = mkdtempSync(join(tmpdir(), "sandy-share-delete-"));
  const shareRoot = join(baseRoot, "shares");
  const outsidePath = join(baseRoot, "outside");
  const runner = new DockerSandboxRunner({
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot,
    openAiApiKey: null,
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
  });

  await mkdir(shareRoot, { recursive: true });
  await mkdir(outsidePath, { recursive: true });
  await writeFile(join(outsidePath, "keep.txt"), "safe\n");

  await assert.rejects(
    runner.deleteTaskShare("../outside"),
    /escapes the configured share root/,
  );

  await assert.doesNotReject(access(join(outsidePath, "keep.txt")));
  await rm(baseRoot, { recursive: true, force: true });
});

test("DockerSandboxRunner launches HTTP proxy container alongside worker", async () => {
  const guardChild = new FakeChildProcess();
  const proxyChild = new FakeChildProcess();
  const taskChild = new FakeChildProcess();
  const invocations: Array<{ command: string; args: string[] }> = [];
  let runCount = 0;

  const spawnImpl = ((command: string, args: readonly string[]) => {
    invocations.push({ command, args: [...args] });
    if (args[0] === "run") {
      runCount += 1;
      if (runCount === 1) {
        queueMicrotask(() => {
          guardChild.stdout.write("ready\n");
        });
        return guardChild as unknown as ChildProcessWithoutNullStreams;
      }
      if (runCount === 2) {
        queueMicrotask(() => {
          proxyChild.stdout.write('{"type":"ready"}\n');
        });
        return proxyChild as unknown as ChildProcessWithoutNullStreams;
      }
      return taskChild as unknown as ChildProcessWithoutNullStreams;
    }

    const cleanupChild = new FakeChildProcess();
    queueMicrotask(() => {
      cleanupChild.emit("exit", 0, null);
    });
    return cleanupChild as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const runner = new DockerSandboxRunner({
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: "/tmp/sandy-test-shares",
    openAiApiKey: null,
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "public_internet_only",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
    httpProxyUrlFactory: () => "http://Bearer:token@sandy-http-proxy:8081",
    workerNetworkName: "sandy-mcp-net",
    httpProxyImage: "sandy-http-proxy:latest",
    httpProxyAuthSocketPath: "/tmp/sandy-proxy-auth.sock",
    httpProxyCaCertPath: "/tmp/sandy-ca.pem",
    httpTokens: { api_key: { value: "secret" } },
    mcpProxyAccessSharedSecret: "shared-secret",
    caCert: "cert",
    caKey: "key",
    spawnImpl,
  });

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-1",
    taskName: "test-task",
    taskLanguage: "English",
    taskBrief: "Inspect the environment.",
    channelFormatting: testFormatting,
  }, async () => {});

  const proxyRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.includes("sandy-http-proxy-task-1"));
  assert.ok(proxyRunInvocation);
  assert.ok(proxyRunInvocation.args.includes("--network"));
  assert.ok(proxyRunInvocation.args.includes("container:sandy-netguard-task-1"));
  assert.ok(proxyRunInvocation.args.includes("--cap-drop"));
  assert.ok(proxyRunInvocation.args.includes("NET_ADMIN"));
  assert.ok(proxyRunInvocation.args.includes("sandy-http-proxy:latest"));

  const workerRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.at(-1) === "sandy-subagent:latest");
  assert.ok(workerRunInvocation);
  assert.ok(workerRunInvocation.args.includes("--add-host"));
  assert.ok(workerRunInvocation.args.includes("sandy-http-proxy:127.0.0.1"));
  assert.ok(workerRunInvocation.args.includes("NO_PROXY=sandy-mcp-proxy"));
  assert.ok(!workerRunInvocation.args.includes("NO_PROXY=sandy-mcp-proxy,sandy-http-proxy"));
  assert.ok(workerRunInvocation.args.includes("/tmp/sandy-ca.pem:/run/sandy-ca.pem:ro"));
  assert.ok(workerRunInvocation.args.includes("SSL_CERT_FILE=/run/sandy-ca.pem"));

  const guardRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.at(-1) === "sandy-network-guard:latest");
  assert.ok(guardRunInvocation);
  assert.ok(!guardRunInvocation.args.includes("sandy-http-proxy"));
});

test("DockerSandboxRunner launches a namespace holder for unrestricted workers when HTTP proxying is enabled", async () => {
  const guardChild = new FakeChildProcess();
  const proxyChild = new FakeChildProcess();
  const taskChild = new FakeChildProcess();
  const invocations: Array<{ command: string; args: string[] }> = [];
  let runCount = 0;

  const spawnImpl = ((command: string, args: readonly string[]) => {
    invocations.push({ command, args: [...args] });
    if (args[0] === "run") {
      runCount += 1;
      if (runCount === 1) {
        queueMicrotask(() => {
          guardChild.stdout.write("ready\n");
        });
        return guardChild as unknown as ChildProcessWithoutNullStreams;
      }
      if (runCount === 2) {
        queueMicrotask(() => {
          proxyChild.stdout.write('{"type":"ready"}\n');
        });
        return proxyChild as unknown as ChildProcessWithoutNullStreams;
      }
      return taskChild as unknown as ChildProcessWithoutNullStreams;
    }

    const cleanupChild = new FakeChildProcess();
    queueMicrotask(() => {
      cleanupChild.emit("exit", 0, null);
    });
    return cleanupChild as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const runner = new DockerSandboxRunner({
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: "/tmp/sandy-test-shares",
    openAiApiKey: null,
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
    httpProxyUrlFactory: () => "http://Bearer:token@sandy-http-proxy:8081",
    httpProxyImage: "sandy-http-proxy:latest",
    httpProxyAuthSocketPath: "/tmp/sandy-proxy-auth.sock",
    httpProxyCaCertPath: "/tmp/sandy-ca.pem",
    httpTokens: { api_key: { value: "secret" } },
    mcpProxyAccessSharedSecret: "shared-secret",
    caCert: "cert",
    caKey: "key",
    spawnImpl,
  });

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-1",
    taskName: "test-task",
    taskLanguage: "English",
    taskBrief: "Inspect the environment.",
    channelFormatting: testFormatting,
  }, async () => {});

  const guardRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.at(-1) === "sandy-network-guard:latest");
  assert.ok(guardRunInvocation);
  assert.ok(!guardRunInvocation.args.includes("--network"));

  const proxyRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.includes("sandy-http-proxy-task-1"));
  assert.ok(proxyRunInvocation);
  assert.ok(proxyRunInvocation.args.includes("container:sandy-netguard-task-1"));

  const workerRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.at(-1) === "sandy-subagent:latest");
  assert.ok(workerRunInvocation);
  assert.ok(workerRunInvocation.args.includes("container:sandy-netguard-task-1"));
});
