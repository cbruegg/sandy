import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildStdioEnvironment } from "./host-server-registry.js";

test("buildStdioEnvironment keeps a minimal base environment", () => {
  assert.deepEqual(buildStdioEnvironment({
    SPOTIFY_CLIENT_ID: "client-id",
  }, {
    PATH: "/usr/local/bin",
    HOME: "/home/sandy",
  }), {
    HOME: "/home/sandy",
    PATH: "/usr/local/bin",
    SPOTIFY_CLIENT_ID: "client-id",
  });
});
