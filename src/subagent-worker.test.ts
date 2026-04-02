import test from "node:test";
import assert from "node:assert/strict";
import { buildInitialTaskInput } from "./subagent/worker.js";

test("buildInitialTaskInput tells the sub-agent where the shared workspace is", () => {
  const input = buildInitialTaskInput("Inspect the repository and leave a summary file.");

  assert.match(input, /\/workspace\/share/);
  assert.match(input, /shared workspace is mounted/);
  assert.match(input, /leave a summary file\./);
});
