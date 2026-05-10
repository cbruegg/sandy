import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { cleanupStaleContainers } from "./stale-container-janitor.js";
import { SANDY_MANAGED_CONTAINER_LABEL } from "./container-label.js";

class FakeChildProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();

  kill(): boolean {
    return true;
  }
}

function createSpawnHarness(responses: Array<{ exitCode?: number; stdout?: string }>) {
  const invocations: Array<{ command: string; args: string[] }> = [];
  let callIndex = 0;

  const spawnImpl = ((_command: string, args: readonly string[]) => {
    invocations.push({ command: _command, args: [...args] });
    const response = responses[callIndex] ?? { exitCode: 0, stdout: "" };
    callIndex += 1;
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      if (response.stdout) {
        child.stdout.write(response.stdout);
      }
      child.emit("exit", response.exitCode ?? 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  return { invocations, spawnImpl };
}

test("cleanupStaleContainers removes containers with the managed label", async () => {
  const { invocations, spawnImpl } = createSpawnHarness([
    { exitCode: 0, stdout: "abc123\ndef456\n" },
    { exitCode: 0 },
    { exitCode: 0 },
  ]);

  await cleanupStaleContainers(spawnImpl);

  assert.equal(invocations.length, 3);
  const psInvocation = invocations[0];
  const rm1Invocation = invocations[1];
  const rm2Invocation = invocations[2];
  assert.ok(psInvocation);
  assert.ok(rm1Invocation);
  assert.ok(rm2Invocation);
  assert.deepEqual(psInvocation.args, ["ps", "-a", "--filter", `label=${SANDY_MANAGED_CONTAINER_LABEL}`, "--format", "{{.ID}}"]);
  assert.deepEqual(rm1Invocation.args, ["rm", "-f", "abc123"]);
  assert.deepEqual(rm2Invocation.args, ["rm", "-f", "def456"]);
});

test("cleanupStaleContainers does nothing when no stale containers exist", async () => {
  const { invocations, spawnImpl } = createSpawnHarness([
    { exitCode: 0, stdout: "\n" },
  ]);

  await cleanupStaleContainers(spawnImpl);

  assert.equal(invocations.length, 1);
  const psInvocation = invocations[0];
  assert.ok(psInvocation);
  assert.deepEqual(psInvocation.args, ["ps", "-a", "--filter", `label=${SANDY_MANAGED_CONTAINER_LABEL}`, "--format", "{{.ID}}"]);
});

test("cleanupStaleContainers handles docker ps failure gracefully", async () => {
  const { invocations, spawnImpl } = createSpawnHarness([
    { exitCode: 1, stdout: "error" },
  ]);

  await assert.rejects(() => cleanupStaleContainers(spawnImpl), /docker ps failed/);
  assert.equal(invocations.length, 1);
});

test("cleanupStaleContainers tolerates individual rm failures", async () => {
  const { invocations, spawnImpl } = createSpawnHarness([
    { exitCode: 0, stdout: "abc123\n" },
    { exitCode: 1 },
  ]);

  await cleanupStaleContainers(spawnImpl);

  assert.equal(invocations.length, 2);
  const rmInvocation = invocations[1];
  assert.ok(rmInvocation);
  assert.deepEqual(rmInvocation.args, ["rm", "-f", "abc123"]);
});
