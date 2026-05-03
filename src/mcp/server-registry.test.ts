import { test } from "bun:test";
import assert from "node:assert/strict";
import { McpServerRegistryImpl } from "./server-registry.js";

test("McpServerRegistryImpl reuses stdio servers across tasks", async () => {
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
  const reusedServer = await registry.getServer("task-2", "spotify");
  assert.strictEqual(reusedServer, firstServer);
});
