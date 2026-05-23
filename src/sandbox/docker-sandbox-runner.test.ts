import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { DockerSandboxRunner } from "./docker-sandbox-runner.js";
import { TaskBundleLauncherImpl, type TaskBundleLauncherOptions } from "./task-bundle-launcher.js";
import { TaskBundlePoolImpl } from "./task-bundle-pool.js";
import { SANDY_MANAGED_CONTAINER_LABEL } from "./container-label.js";
import type { ChannelFormatting, HostCommand, SubAgentEvent, WorkerStartConfig } from "../types.js";

const testFormatting: ChannelFormatting = {
  channelId: "telegram",
  markup: "telegram_html",
  allowedTags: ["b", "i", "code", "pre"],
  instructions: "Use simple Telegram HTML.",
};

const defaultWorkerStartConfig: WorkerStartConfig = {
  openAiApiKey: null,
  codexModel: null,
  channelFormatting: testFormatting,
  httpTokens: [],
  httpProxyWrapper: null,
  chatgptExternalTokens: null,
};

class FakeStdin {
  public readonly writes: string[] = [];
  public failNextWrite = false;
  public holdWrites = false;
  public endCalls = 0;
  private readonly pendingCallbacks: Array<(error?: Error | null) => void> = [];

  write(chunk: Buffer | string, callback: (error?: Error | null) => void): boolean {
    this.writes.push(String(chunk));
    if (this.holdWrites) {
      this.pendingCallbacks.push(callback);
      return true;
    }
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

  releaseNextWrite(error: Error | null = null): void {
    const callback = this.pendingCallbacks.shift();
    callback?.(error);
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

function createRunner(
  runnerOptions: ConstructorParameters<typeof DockerSandboxRunner>[0],
  launcherOptions: TaskBundleLauncherOptions,
): DockerSandboxRunner {
  const launcher = new TaskBundleLauncherImpl(launcherOptions);
  const pool = new TaskBundlePoolImpl(launcher);
  return new DockerSandboxRunner(runnerOptions, pool);
}

async function launchRunnerWithChild(
  taskChild: FakeChildProcess,
  onEvent: (event: SubAgentEvent) => Promise<void>,
  options?: {
    handshakeTimeoutMs?: number;
    shareRoot?: string;
    builtWorkerCodexConfigToml?: string | null;
    skillsDirectory?: string | null;
    workerCodexBinaryPath?: string | null;
    workerNetworkName?: string | null;
    resolveWorkerImage?: () => string;
    workerStartConfig?: Partial<WorkerStartConfig>;
  },
) {
  const timers = createTimerController();
  const harness = createSpawnHarness(taskChild);

  const launcherOptions: TaskBundleLauncherOptions = {
    workerImage: "sandy-subagent:latest",
    resolveWorkerImage: options?.resolveWorkerImage,
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: options?.shareRoot ?? "/tmp/sandy-test-shares",
    codexAuthFile: null,
    skillsDirectory: options?.skillsDirectory ?? null,
    workerCodexBinaryPath: options?.workerCodexBinaryPath,
    workerNetworkName: options?.workerNetworkName,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    httpProxyCaCertPath: null,
    httpProxyConfDirPath: null,
    httpProxyImage: null,
    resolveHttpProxyRequest: undefined,
    handshakeTimeoutMs: options?.handshakeTimeoutMs ?? 10_000,
    spawnImpl: harness.spawnImpl,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  };

  const runnerOptions: ConstructorParameters<typeof DockerSandboxRunner>[0] = {
    workerImage: "sandy-subagent:latest",
    resolveWorkerImage: options?.resolveWorkerImage,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: options?.builtWorkerCodexConfigToml ?? null,
      environment: {},
    }),
    handshakeTimeoutMs: options?.handshakeTimeoutMs ?? 10_000,
    spawnImpl: harness.spawnImpl,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  };

  const runner = createRunner(runnerOptions, launcherOptions);

  const handle = await runner.launchTask(
    {
      chatId: "chat-1",
      taskId: "task-1",
      taskName: "test-task",
      taskLanguage: "English",
      taskBrief: "Inspect the environment.",
      channelFormatting: testFormatting,
      initialInput: { text: "Inspect the environment.", images: [] },
      workerStartConfig: {
        ...defaultWorkerStartConfig,
        ...options?.workerStartConfig,
      },
    },
    onEvent,
  );

  return {
    handle,
    runner,
    timers,
    invocations: harness.invocations,
  };
}

function flushEvents(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function parseFirstStartTaskWrite(taskChild: FakeChildProcess): Extract<HostCommand, { type: "start_task" }> {
  const firstWrite = taskChild.stdin.writes[0];
  assert.ok(firstWrite);
  return JSON.parse(firstWrite) as Extract<HostCommand, { type: "start_task" }>;
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

test("DockerSandboxRunner passes channel formatting in the start_task payload", async () => {
  const taskChild = new FakeChildProcess();

  await launchRunnerWithChild(taskChild, async () => {});

  taskChild.stdout.write('{"type":"worker_connected"}\n');
  await flushEvents();

  assert.deepEqual(parseFirstStartTaskWrite(taskChild).config.channelFormatting, testFormatting);
});

test("DockerSandboxRunner passes the configured Codex model in the start_task payload", async () => {
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

  const launcherOptions: TaskBundleLauncherOptions = {
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: "/tmp/sandy-test-shares",
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    httpProxyCaCertPath: null,
    httpProxyConfDirPath: null,
    httpProxyImage: null,
    resolveHttpProxyRequest: undefined,
    spawnImpl,
  };
  const runner = createRunner({
    workerImage: "sandy-subagent:latest",
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
    spawnImpl,
  }, launcherOptions);

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-1",
    taskName: "test-task",
    taskLanguage: "English",
    taskBrief: "Inspect the environment.",
    channelFormatting: testFormatting,
    initialInput: { text: "Inspect the environment.", images: [] },
    workerStartConfig: {
      ...defaultWorkerStartConfig,
      codexModel: "gpt-5.4-mini",
    },
  }, async () => {});

  taskChild.stdout.write('{"type":"worker_connected"}\n');
  await flushEvents();

  assert.equal(parseFirstStartTaskWrite(taskChild).config.codexModel, "gpt-5.4-mini");
  assert.ok(invocationsWithModel.some((invocation) => invocation.args[0] === "run"));
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
  await handle.sendUserMessage({ text: "hello", images: [] });
  await flushEvents();

  assert.deepEqual(events, [
    { type: "worker_connected" },
    {
      type: "worker_disconnected",
      message: "Sub-agent control channel write failed: broken pipe",
    },
  ]);
});

test("DockerSandboxRunner waits for start_task delivery before sending follow-up user messages", async () => {
  const taskChild = new FakeChildProcess();
  taskChild.stdin.holdWrites = true;
  const events: SubAgentEvent[] = [];
  const { handle } = await launchRunnerWithChild(taskChild, async (event) => {
    events.push(event);
  });

  taskChild.stdout.write('{"type":"worker_connected"}\n');
  await flushEvents();

  const sendPromise = handle.sendUserMessage({ text: "hello", images: [] });
  await flushEvents();

  assert.deepEqual(events, [{ type: "worker_connected" }]);
  assert.equal(taskChild.stdin.writes.length, 1);
  assert.match(taskChild.stdin.writes[0] ?? "", /"type":"start_task"/);

  taskChild.stdin.holdWrites = false;
  taskChild.stdin.releaseNextWrite();
  await flushEvents();
  await sendPromise;

  assert.equal(taskChild.stdin.writes.length, 2);
  assert.match(taskChild.stdin.writes[1] ?? "", /"type":"user_message"/);
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

  const launcherOptions: TaskBundleLauncherOptions = {
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: "/tmp/sandy-test-shares",
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    httpProxyCaCertPath: null,
    httpProxyConfDirPath: null,
    httpProxyImage: null,
    resolveHttpProxyRequest: undefined,
    spawnImpl,
  };
  const runner = createRunner({
    workerImage: "sandy-subagent:latest",
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
    spawnImpl,
  }, launcherOptions);

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-1",
    taskName: "test-task",
    taskLanguage: "English",
    taskBrief: "Inspect the environment.",
    channelFormatting: testFormatting,
    initialInput: { text: "Inspect the environment.", images: [] },
    workerStartConfig: defaultWorkerStartConfig,
  }, async () => {});

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-2",
    taskName: "test-task-2",
    taskLanguage: "English",
    taskBrief: "Inspect the environment again.",
    channelFormatting: testFormatting,
    initialInput: { text: "Inspect the environment again.", images: [] },
    workerStartConfig: defaultWorkerStartConfig,
  }, async () => {});

  await runner.shutdown();
  await flushEvents();

  assert.deepEqual(firstTaskChild.killSignals, ["SIGTERM"]);
  assert.deepEqual(secondTaskChild.killSignals, ["SIGTERM"]);
  assert.equal(invocations.filter((invocation) => invocation.args[0] === "rm").length, 2);
});

test("DockerSandboxRunner inspects and deletes task shares on the host", async () => {
  const shareRoot = mkdtempSync(join(tmpdir(), "sandy-share-test-"));
  const launcherOptions: TaskBundleLauncherOptions = {
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot,
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    httpProxyCaCertPath: null,
    httpProxyConfDirPath: null,
    httpProxyImage: null,
    resolveHttpProxyRequest: undefined,
  };
  const runner = createRunner({
    workerImage: "sandy-subagent:latest",
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
  }, launcherOptions);

  const taskShare = join(shareRoot, "task-1");
  (runner as unknown as { taskSharePaths: Map<string, string> }).taskSharePaths.set("task-1", taskShare);
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

test("DockerSandboxRunner falls back to a root Docker container when host rm fails due to permissions", async () => {
  const shareRoot = mkdtempSync(join(tmpdir(), "sandy-share-perm-test-"));
  const taskShare = join(shareRoot, "task-1");
  const innerDir = join(taskShare, "inner");
  await mkdir(innerDir, { recursive: true });
  await writeFile(join(innerDir, "file.txt"), "data\n");
  await chmod(innerDir, 0o000);

  const invocations: Array<{ command: string; args: string[] }> = [];
  const spawnImpl = ((command: string, args: readonly string[]) => {
    invocations.push({ command, args: [...args] });
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      child.emit("exit", 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const launcherOptions: TaskBundleLauncherOptions = {
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot,
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    httpProxyCaCertPath: null,
    httpProxyConfDirPath: null,
    httpProxyImage: null,
    resolveHttpProxyRequest: undefined,
    spawnImpl,
  };
  const runner = createRunner({
    workerImage: "sandy-subagent:latest",
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
    spawnImpl,
  }, launcherOptions);

  (runner as unknown as { taskSharePaths: Map<string, string> }).taskSharePaths.set("task-1", taskShare);

  try {
    await runner.deleteTaskShare("task-1");
  } finally {
    await chmod(innerDir, 0o755);
    await rm(shareRoot, { recursive: true, force: true });
  }

  const dockerRun = invocations.find((inv) => inv.command === "docker" && inv.args[0] === "run");
  assert.ok(dockerRun, "Expected a docker run invocation for permission fallback cleanup");
  assert.ok(dockerRun.args.includes("--rm"));
  assert.ok(dockerRun.args.includes("--entrypoint"));
  assert.ok(dockerRun.args.includes("sh"));
  assert.ok(dockerRun.args.includes(`${taskShare}:/target`));
  assert.ok(dockerRun.args.includes("-lc"));
  assert.ok(dockerRun.args.includes("rm -rf /target/* /target/.[!.]* /target/..?*"));
});

test("DockerSandboxRunner sends codex config TOML in start_task instead of mounting it", async () => {
  const shareRoot = mkdtempSync(join(tmpdir(), "sandy-share-config-"));
  const taskChild = new FakeChildProcess();

  const { runner, invocations } = await launchRunnerWithChild(taskChild, async () => {}, {
    shareRoot,
    builtWorkerCodexConfigToml: "model = \"gpt-5\"\n",
  });

  const taskShare = runner.getTaskSharePath("task-1");
  assert.ok(taskShare.includes("bundle-"));
  assert.deepEqual(await readdir(taskShare), []);

  const dockerRunInvocation = invocations.find((invocation) => invocation.args[0] === "run" && invocation.args.at(-1) === "sandy-subagent:latest");
  assert.ok(dockerRunInvocation);
  assert.ok(!dockerRunInvocation.args.some((arg) => arg.endsWith(":/run/sandy-codex-seed:ro")));
  assert.equal(dockerRunInvocation.args.at(-1), "sandy-subagent:latest");
  assert.ok(!dockerRunInvocation.args.includes("--entrypoint"));
  assert.ok(!dockerRunInvocation.args.includes("--user"));

  taskChild.stdout.write('{"type":"worker_connected"}\n');
  await flushEvents();

  const startTask = parseFirstStartTaskWrite(taskChild);
  assert.equal(startTask.codexConfigToml, "model = \"gpt-5\"\n");

  taskChild.emit("exit", 0, null);
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

  const launcherOptions: TaskBundleLauncherOptions = {
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: "/tmp/sandy-test-shares",
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetworkName: "sandy-mcp-net",
    workerNetwork: {
      mode: "public_internet_only",
      allowLocalCidrs: ["192.168.178.0/24", "fd00::/8"],
    },
    httpProxyCaCertPath: null,
    httpProxyConfDirPath: null,
    httpProxyImage: null,
    resolveHttpProxyRequest: undefined,
    spawnImpl,
  };
  const runner = createRunner({
    workerImage: "sandy-subagent:latest",
    workerNetwork: {
      mode: "public_internet_only",
      allowLocalCidrs: ["192.168.178.0/24", "fd00::/8"],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
    spawnImpl,
  }, launcherOptions);

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-1",
    taskName: "test-task",
    taskLanguage: "English",
    taskBrief: "Inspect the environment.",
    channelFormatting: testFormatting,
    initialInput: { text: "Inspect the environment.", images: [] },
    workerStartConfig: defaultWorkerStartConfig,
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

  const guardContainerName = guardRunInvocation.args.find((arg) => arg.startsWith("sandy-netguard-"));
  assert.ok(guardContainerName);

  const workerRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.at(-1) === "sandy-subagent:latest");
  assert.ok(workerRunInvocation);
  assert.ok(workerRunInvocation.args.includes("--network"));
  assert.ok(workerRunInvocation.args.includes(`container:${guardContainerName}`));
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

  const launcherOptions: TaskBundleLauncherOptions = {
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: "/tmp/sandy-test-shares",
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "public_internet_only",
      allowLocalCidrs: [],
    },
    httpProxyCaCertPath: null,
    httpProxyConfDirPath: null,
    httpProxyImage: null,
    resolveHttpProxyRequest: undefined,
    spawnImpl,
  };
  const runner = createRunner({
    workerImage: "sandy-subagent:latest",
    workerNetwork: {
      mode: "public_internet_only",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
    spawnImpl,
  }, launcherOptions);

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-1",
    taskName: "test-task",
    taskLanguage: "English",
    taskBrief: "Inspect the environment.",
    channelFormatting: testFormatting,
    initialInput: { text: "Inspect the environment.", images: [] },
    workerStartConfig: defaultWorkerStartConfig,
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

test("DockerSandboxRunner rejects share inspection for unknown tasks", async () => {
  const shareRoot = mkdtempSync(join(tmpdir(), "sandy-share-escape-"));
  const launcherOptions: TaskBundleLauncherOptions = {
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot,
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    httpProxyCaCertPath: null,
    httpProxyConfDirPath: null,
    httpProxyImage: null,
    resolveHttpProxyRequest: undefined,
  };
  const runner = createRunner({
    workerImage: "sandy-subagent:latest",
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
  }, launcherOptions);

  await assert.rejects(
    runner.inspectTaskShare("task-unknown"),
    /No tracked share path is registered/,
  );
  await rm(shareRoot, { recursive: true, force: true });
});

test("DockerSandboxRunner rejects share deletion for unknown tasks", async () => {
  const shareRoot = mkdtempSync(join(tmpdir(), "sandy-share-delete-"));
  const launcherOptions: TaskBundleLauncherOptions = {
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot,
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    httpProxyCaCertPath: null,
    httpProxyConfDirPath: null,
    httpProxyImage: null,
    resolveHttpProxyRequest: undefined,
  };
  const runner = createRunner({
    workerImage: "sandy-subagent:latest",
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
  }, launcherOptions);

  await assert.rejects(
    runner.deleteTaskShare("task-unknown"),
    /No tracked share path is registered/,
  );
  await rm(shareRoot, { recursive: true, force: true });
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

  const launcherOptions: TaskBundleLauncherOptions = {
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: "/tmp/sandy-test-shares",
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetworkName: "sandy-mcp-net",
    workerNetwork: {
      mode: "public_internet_only",
      allowLocalCidrs: [],
    },
    httpProxyImage: "sandy-http-proxy:latest",
    httpProxyCaCertPath: "/tmp/sandy-ca.pem",
    httpProxyConfDirPath: "/tmp/sandy-mitmproxy-conf",
    resolveHttpProxyRequest: async (request) => ({
      type: "auth_response",
      requestId: request.requestId,
      outcome: "approved",
      headers: request.headers,
    }),
    spawnImpl,
  };
  const runner = createRunner({
    workerImage: "sandy-subagent:latest",
    workerNetwork: {
      mode: "public_internet_only",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
    httpProxyUrlFactory: () => "http://Bearer:token@sandy-http-proxy:8081",
    spawnImpl,
  }, launcherOptions);

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-1",
    taskName: "test-task",
    taskLanguage: "English",
    taskBrief: "Inspect the environment.",
    channelFormatting: testFormatting,
    initialInput: { text: "Inspect the environment.", images: [] },
    workerStartConfig: {
      ...defaultWorkerStartConfig,
      httpTokens: [{ tokenId: "vid2text", description: "Token for the video transcription API." }],
      httpProxyWrapper: "/usr/local/bin/sandy-http-proxy-exec",
    },
  }, async () => {});

  const guardRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.at(-1) === "sandy-network-guard:latest");
  assert.ok(guardRunInvocation);
  const guardContainerName = guardRunInvocation.args.find((arg) => arg.startsWith("sandy-netguard-"));
  assert.ok(guardContainerName);

  const proxyRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.some((arg) => arg.startsWith("sandy-http-proxy-")));
  assert.ok(proxyRunInvocation);
  assert.ok(proxyRunInvocation.args.includes("--network"));
  assert.ok(proxyRunInvocation.args.includes(`container:${guardContainerName}`));
  assert.ok(proxyRunInvocation.args.includes("--cap-drop"));
  assert.ok(proxyRunInvocation.args.includes("NET_ADMIN"));
  assert.ok(proxyRunInvocation.args.includes("sandy-http-proxy:latest"));
  assert.ok(proxyRunInvocation.args.includes("/tmp/sandy-mitmproxy-conf:/run/sandy-mitmproxy-conf:ro"));
  assert.ok(proxyRunInvocation.args.includes("MITMPROXY_CONFDIR=/run/sandy-mitmproxy-conf"));

  const workerRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.at(-1) === "sandy-subagent:latest");
  assert.ok(workerRunInvocation);
  assert.ok(!workerRunInvocation.args.includes("--add-host"));
  assert.ok(!workerRunInvocation.args.includes("SANDY_HTTP_PROXY_URL=http://Bearer:token@sandy-http-proxy:8081"));
  assert.ok(!workerRunInvocation.args.includes("SANDY_HTTP_PROXY_WRAPPER=/usr/local/bin/sandy-http-proxy-exec"));
  assert.ok(!workerRunInvocation.args.some((arg) =>
    arg.endsWith(":/run/sandy-http-token-descriptions.json:ro")));
  assert.ok(workerRunInvocation.args.includes("/tmp/sandy-ca.pem:/etc/pki/trust/anchors/sandy-ca.pem:ro"));

  taskChild.stdout.write('{"type":"worker_connected"}\n');
  await flushEvents();

  const startTask = parseFirstStartTaskWrite(taskChild);
  assert.deepEqual(startTask.config.httpTokens, [
    { tokenId: "vid2text", description: "Token for the video transcription API." },
  ]);
  assert.equal(startTask.config.httpProxyWrapper, "/usr/local/bin/sandy-http-proxy-exec");
  assert.equal(startTask.httpProxyUrl, "http://Bearer:token@sandy-http-proxy:8081");
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

  const launcherOptions: TaskBundleLauncherOptions = {
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: "/tmp/sandy-test-shares",
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    httpProxyImage: "sandy-http-proxy:latest",
    httpProxyCaCertPath: "/tmp/sandy-ca.pem",
    httpProxyConfDirPath: "/tmp/sandy-mitmproxy-conf",
    resolveHttpProxyRequest: async (request) => ({
      type: "auth_response",
      requestId: request.requestId,
      outcome: "approved",
      headers: request.headers,
    }),
    spawnImpl,
  };
  const runner = createRunner({
    workerImage: "sandy-subagent:latest",
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
    httpProxyUrlFactory: () => "http://Bearer:token@sandy-http-proxy:8081",
    spawnImpl,
  }, launcherOptions);

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-1",
    taskName: "test-task",
    taskLanguage: "English",
    taskBrief: "Inspect the environment.",
    channelFormatting: testFormatting,
    initialInput: { text: "Inspect the environment.", images: [] },
    workerStartConfig: {
      ...defaultWorkerStartConfig,
      httpTokens: [{ tokenId: "vid2text", description: "Token for the video transcription API." }],
      httpProxyWrapper: "/usr/local/bin/sandy-http-proxy-exec",
    },
  }, async () => {});

  const guardRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.at(-1) === "sandy-network-guard:latest");
  assert.ok(guardRunInvocation);
  assert.ok(!guardRunInvocation.args.includes("--network"));
  const guardContainerName = guardRunInvocation.args.find((arg) => arg.startsWith("sandy-netguard-"));
  assert.ok(guardContainerName);

  const proxyRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.some((arg) => arg.startsWith("sandy-http-proxy-")));
  assert.ok(proxyRunInvocation);
  assert.ok(proxyRunInvocation.args.includes(`container:${guardContainerName}`));

  const workerRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.at(-1) === "sandy-subagent:latest");
  assert.ok(workerRunInvocation);
  assert.ok(workerRunInvocation.args.includes(`container:${guardContainerName}`));
});

test("DockerSandboxRunner adds managed label to worker, guard and proxy containers", async () => {
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

  const launcherOptions: TaskBundleLauncherOptions = {
    workerImage: "sandy-subagent:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: "/tmp/sandy-test-shares",
    codexAuthFile: null,
    skillsDirectory: null,
    workerCodexBinaryPath: null,
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    httpProxyImage: "sandy-http-proxy:latest",
    httpProxyCaCertPath: "/tmp/sandy-ca.pem",
    httpProxyConfDirPath: "/tmp/sandy-mitmproxy-conf",
    resolveHttpProxyRequest: async (request) => ({
      type: "auth_response",
      requestId: request.requestId,
      outcome: "approved",
      headers: request.headers,
    }),
    spawnImpl,
  };
  const runner = createRunner({
    workerImage: "sandy-subagent:latest",
    workerNetwork: {
      mode: "unrestricted",
      allowLocalCidrs: [],
    },
    workerCodexConfigBuilder: () => ({
      codexConfigToml: null,
      environment: {},
    }),
    httpProxyUrlFactory: () => "http://Bearer:token@sandy-http-proxy:8081",
    spawnImpl,
  }, launcherOptions);

  await runner.launchTask({
    chatId: "chat-1",
    taskId: "task-1",
    taskName: "test-task",
    taskLanguage: "English",
    taskBrief: "Inspect the environment.",
    channelFormatting: testFormatting,
    initialInput: { text: "Inspect the environment.", images: [] },
    workerStartConfig: {
      ...defaultWorkerStartConfig,
      httpTokens: [],
      httpProxyWrapper: "/usr/local/bin/sandy-http-proxy-exec",
    },
  }, async () => {});

  const guardRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.at(-1) === "sandy-network-guard:latest");
  assert.ok(guardRunInvocation);
  assert.ok(guardRunInvocation.args.includes("--label"));
  assert.ok(guardRunInvocation.args.includes(SANDY_MANAGED_CONTAINER_LABEL));

  const proxyRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.some((arg) => arg.startsWith("sandy-http-proxy-")));
  assert.ok(proxyRunInvocation);
  assert.ok(proxyRunInvocation.args.includes("--label"));
  assert.ok(proxyRunInvocation.args.includes(SANDY_MANAGED_CONTAINER_LABEL));

  const workerRunInvocation = invocations.find((invocation) =>
    invocation.args[0] === "run" && invocation.args.at(-1) === "sandy-subagent:latest");
  assert.ok(workerRunInvocation);
  assert.ok(workerRunInvocation.args.includes("--label"));
  assert.ok(workerRunInvocation.args.includes(SANDY_MANAGED_CONTAINER_LABEL));
});
