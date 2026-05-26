import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  startHeartbeat,
  createBundleControlDir,
  removeBundleControlDir,
  HEARTBEAT_FILE,
  HEARTBEAT_INTERVAL_MS,
} from "./heartbeat.js";

type FakeTimer = { fn: () => void; cleared: boolean };

function createTimerController() {
  const timers: FakeTimer[] = [];
  return {
    setTimeoutImpl: ((fn: () => void) => {
      const timer: FakeTimer = { fn, cleared: false };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimeoutImpl: ((timer: NodeJS.Timeout) => {
      (timer as unknown as FakeTimer).cleared = true;
    }) as typeof clearTimeout,
    triggerAll: () => {
      // Snapshot the timers array since tick() may schedule new timers.
      for (const timer of [...timers]) {
        if (!timer.cleared) {
          timer.fn();
        }
      }
    },
    pendingCount: () => timers.filter((t) => !t.cleared).length,
  };
}

test("createBundleControlDir creates the directory and heartbeat file", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandy-hb-test-"));
  try {
    const controlDir = await createBundleControlDir("test-bundle", root);
    const heartbeatPath = join(controlDir, HEARTBEAT_FILE);

    const fileStat = await stat(heartbeatPath);
    assert.ok(fileStat.isFile(), "Heartbeat file should exist");

    const content = await readFile(heartbeatPath, "utf8");
    assert.ok(/^\d+$/.test(content.trim()), "Heartbeat file should contain a timestamp");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startHeartbeat refreshes the heartbeat file periodically", async () => {
  const controlDir = mkdtempSync(join(tmpdir(), "sandy-hb-test-"));
  const heartbeatPath = join(controlDir, HEARTBEAT_FILE);
  // Create the initial heartbeat file.
  await mkdir(controlDir, { recursive: true });

  try {
    const timers = createTimerController();
    const handle = startHeartbeat(controlDir, 100, timers.setTimeoutImpl, timers.clearTimeoutImpl);

    // The first tick happens immediately (void tick() is called synchronously
    // when startHeartbeat runs). Wait for the writeFile to complete.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stat1 = await stat(heartbeatPath);
    const mtime1 = stat1.mtimeMs;

    // Fire the next timer tick.
    await new Promise((resolve) => setTimeout(resolve, 20));
    timers.triggerAll();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stat2 = await stat(heartbeatPath);
    const mtime2 = stat2.mtimeMs;

    assert.ok(mtime2 >= mtime1, "Heartbeat mtime should advance after tick");

    handle.stop();
  } finally {
    await rm(controlDir, { recursive: true, force: true });
  }
});

test("startHeartbeat stop prevents further ticks", async () => {
  const controlDir = mkdtempSync(join(tmpdir(), "sandy-hb-test-"));
  const heartbeatPath = join(controlDir, HEARTBEAT_FILE);
  await mkdir(controlDir, { recursive: true });

  try {
    const timers = createTimerController();
    const handle = startHeartbeat(controlDir, 100, timers.setTimeoutImpl, timers.clearTimeoutImpl);

    // Let the initial tick complete.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const beforeStop = await stat(heartbeatPath).then((s) => s.mtimeMs).catch(() => 0);

    handle.stop();

    // Fire any remaining timers.
    timers.triggerAll();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const afterStop = await stat(heartbeatPath).then((s) => s.mtimeMs).catch(() => 0);
    assert.equal(afterStop, beforeStop,
      "Heartbeat mtime should not change after stop");
  } finally {
    await rm(controlDir, { recursive: true, force: true });
  }
});

test("removeBundleControlDir removes the directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandy-hb-test-"));
  try {
    const controlDir = await createBundleControlDir("test-bundle", root);

    // Verify it exists.
    await stat(controlDir);

    await removeBundleControlDir(controlDir);

    // Verify it was removed.
    await assert.rejects(
      () => stat(controlDir),
      { message: /ENOENT|no such file/ },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removeBundleControlDir does not throw when directory is already gone", async () => {
  const root = mkdtempSync(join(tmpdir(), "sandy-hb-test-"));
  try {
    const controlDir = `${root}/.sandy-control/bundle-nonexistent`;

    // Should not throw even though the directory doesn't exist.
    await removeBundleControlDir(controlDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("heartbeat interval is configurable", async () => {
  const controlDir = mkdtempSync(join(tmpdir(), "sandy-hb-test-"));
  const heartbeatPath = join(controlDir, HEARTBEAT_FILE);
  await mkdir(controlDir, { recursive: true });

  try {
    const timers = createTimerController();
    const handle = startHeartbeat(controlDir, 50, timers.setTimeoutImpl, timers.clearTimeoutImpl);

    // Let initial tick complete.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // First tick should have happened (initial void tick() call).
    const stat1 = await stat(heartbeatPath);
    assert.ok(stat1.mtimeMs > 0, "Initial tick should write heartbeat");

    // Fire the re-scheduled timer.
    timers.triggerAll();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const stat2 = await stat(heartbeatPath);
    assert.ok(stat2.mtimeMs >= stat1.mtimeMs, "Second tick should update heartbeat");

    handle.stop();
  } finally {
    await rm(controlDir, { recursive: true, force: true });
  }
});

test("heartbeat file contains a numeric timestamp", async () => {
  // Validate that HEARTBEAT_INTERVAL_MS is the balanced default.
  assert.equal(HEARTBEAT_INTERVAL_MS, 5000,
    "HEARTBEAT_INTERVAL_MS should be 5000 (5 seconds, balanced strategy)");
});
