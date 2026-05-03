import { test } from "bun:test";
import assert from "node:assert/strict";
import { parseHostToMcpSidecarMessage } from "./sidecar-protocol.js";

test("parseHostToMcpSidecarMessage accepts shutdown requests", () => {
  assert.deepEqual(parseHostToMcpSidecarMessage(JSON.stringify({
    type: "shutdown",
  })), {
    type: "shutdown",
  });
});
