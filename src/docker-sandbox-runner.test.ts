import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { DockerSandboxRunner } from "./sandbox/docker-sandbox-runner.js";
import type { SubAgentEvent } from "./types.js";

class FakeStdin {
  public readonly writes: string[] = [];
  public failNextWrite = false;

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
      transcript: [],
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

  await launchRunnerWithChild(taskChild, async (event) => {
    events.push(event);
  });

  assert.deepEqual(events, []);

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
