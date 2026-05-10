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

test("worker Dockerfile installs the login shell profile", async () => {
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");

  assert.match(dockerfile, /ENV PATH="\$\{BUN_INSTALL\}\/bin:\/usr\/local\/bin:\/home\/linuxbrew\/\.linuxbrew\/bin:\/home\/linuxbrew\/\.linuxbrew\/sbin:\$\{PATH\}"/);
  assert.match(dockerfile, /printf '#!\/bin\/sh\\nexport PATH="%s"\\n' "\$PATH" > \/etc\/profile\.local/);
  assert.match(dockerfile, /chmod 0755 .*\/etc\/profile\.local/);
});
