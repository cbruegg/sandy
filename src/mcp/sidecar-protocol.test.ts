import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseHostToMcpSidecarMessage } from "./sidecar-protocol.js";

test("parseHostToMcpSidecarMessage accepts task release requests", () => {
  assert.deepEqual(parseHostToMcpSidecarMessage(JSON.stringify({
    type: "release_task",
    taskId: "task-1",
  })), {
    type: "release_task",
    taskId: "task-1",
  });
});
