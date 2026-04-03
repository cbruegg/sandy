import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { DockerSandboxRunner } from "./sandbox/docker-sandbox-runner.js";
import type { ChannelFormatting, SubAgentEvent } from "./types.js";

const testFormatting: ChannelFormatting = {
  channel: "telegram",
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

async function launchRunnerWithChild(taskChild: FakeChildProcess, onEvent: (event: SubAgentEvent) => Promise<void>, handshakeTimeoutMs = 10_000) {
  const timers = createTimerController();
  const harness = createSpawnHarness(taskChild);
  const runner = new DockerSandboxRunner({
    workerImage: "sandy-subagent:latest",
    shareRoot: "/tmp/sandy-test-shares",
    openAiApiKey: null,
    codexAuthFile: null,
    handshakeTimeoutMs,
    spawnImpl: harness.spawnImpl,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  const handle = await runner.launchTask(
    {
      chatId: "chat-1",
      taskId: "task-1",
      taskName: "test-task",
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

test("DockerSandboxRunner reports a disconnect when the handshake times out", async () => {
  const taskChild = new FakeChildProcess();
  const events: SubAgentEvent[] = [];
  const { timers, invocations } = await launchRunnerWithChild(taskChild, async (event) => {
    events.push(event);
  }, 5);

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

  assert.deepEqual(events, [
    { type: "worker_connected" },
    { type: "progress", message: "background warning" },
  ]);
  assert.deepEqual(taskChild.killSignals, ["SIGTERM"]);
  assert.ok(invocations.some((invocation) => invocation.args[0] === "rm"));
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

test("DockerSandboxRunner inspects and deletes task shares on the host", async () => {
  const shareRoot = mkdtempSync(join(tmpdir(), "sandy-share-test-"));
  const runner = new DockerSandboxRunner({
    workerImage: "sandy-subagent:latest",
    shareRoot,
    openAiApiKey: null,
    codexAuthFile: null,
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

test("DockerSandboxRunner rejects share inspection outside the configured share root", async () => {
  const baseRoot = mkdtempSync(join(tmpdir(), "sandy-share-escape-"));
  const shareRoot = join(baseRoot, "shares");
  const outsidePath = join(baseRoot, "outside");
  const runner = new DockerSandboxRunner({
    workerImage: "sandy-subagent:latest",
    shareRoot,
    openAiApiKey: null,
    codexAuthFile: null,
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
    shareRoot,
    openAiApiKey: null,
    codexAuthFile: null,
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
