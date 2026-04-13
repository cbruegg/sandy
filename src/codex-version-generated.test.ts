import { test } from "bun:test";
import assert from "node:assert/strict";
import { embeddedCodexVersion } from "./codex-version.generated.js";
import { resolveCodexVersion } from "./codex-client.js";

test("embedded Codex version stays in sync with the installed SDK dependency", () => {
  assert.equal(embeddedCodexVersion, resolveCodexVersion());
});
