import { test } from "bun:test";
import assert from "node:assert/strict";
import { McpServerRegistryImpl } from "./server-registry.js";

test("McpServerRegistryImpl releases task-scoped stdio servers when a task ends", async () => {
  const registry = new McpServerRegistryImpl(
    "/tmp/sandy-oauth",
    {
      spotify: {
        transport: "stdio",
        command: "node",
        args: ["build/index.js"],
        workingDirectory: null,
        env: {},
      },
    },
    async () => ({}),
  );

  const firstServer = await registry.getServer("task-1", "spotify");
  const reusedServer = await registry.getServer("task-1", "spotify");
  assert.strictEqual(reusedServer, firstServer);

  await registry.releaseTask("task-1");

  const recreatedServer = await registry.getServer("task-1", "spotify");
  assert.notStrictEqual(recreatedServer, firstServer);
});
