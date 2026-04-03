import test from "node:test";
import assert from "node:assert/strict";
import { resolveTaskShareHostPath, toSharedWorkspacePath } from "./shared-workspace.js";

test("shared workspace helpers map between host and worker paths", () => {
  assert.equal(
    resolveTaskShareHostPath("/tmp/task-1", "/workspace/share/results/output.txt", "path"),
    "/tmp/task-1/results/output.txt",
  );

  assert.equal(
    toSharedWorkspacePath("/tmp/task-1", "/tmp/task-1/inbox/msg-1/1-input.txt", "hostPath"),
    "/workspace/share/inbox/msg-1/1-input.txt",
  );
});

test("shared workspace helpers reject path escapes", () => {
  assert.throws(
    () => resolveTaskShareHostPath("/tmp/task-1", "/tmp/not-shared.txt", "path"),
    /must stay within \/workspace\/share/,
  );

  assert.throws(
    () => toSharedWorkspacePath("/tmp/task-1", "/tmp/other-task/file.txt", "hostPath"),
    /must stay within the task share/,
  );
});
