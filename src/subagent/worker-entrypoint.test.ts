import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("worker entrypoint exports Bun and Linuxbrew on PATH before launching Bun", async () => {
  const entrypoint = await readFile(new URL("../../scripts/worker-entrypoint.sh", import.meta.url), "utf8");

  assert.match(
    entrypoint,
    /export PATH="\$\{BUN_INSTALL:-\/root\/\.bun\}\/bin:\/usr\/local\/bin:\/home\/linuxbrew\/\.linuxbrew\/bin:\/home\/linuxbrew\/\.linuxbrew\/sbin:\$\{PATH\}"/,
  );
  assert.match(entrypoint, /exec bun dist\/entrypoint-worker\.js/);
});
