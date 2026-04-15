import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureManagedCodexPath,
  resolveCodexCacheRoot,
  resolveManagedCodexCacheRoot,
  resolveCodexPathOverride,
  resolveCodexTargetTriple,
  resolveCodexVersion,
  resolveManagedCodexAsset,
} from "./codex-client.js";

test("resolveCodexPathOverride uses SANDY_CODEX_PATH when configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-codex-path-"));
  const codexPath = join(root, process.platform === "win32" ? "codex.exe" : "codex");

  try {
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n");
    await chmod(codexPath, 0o755);

    assert.equal(resolveCodexPathOverride({
      SANDY_CODEX_PATH: codexPath,
    }), codexPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveCodexPathOverride rejects a non-executable SANDY_CODEX_PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-codex-path-"));
  const codexPath = join(root, process.platform === "win32" ? "codex.exe" : "codex");

  try {
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n");
    await chmod(codexPath, 0o644);

    assert.throws(() => resolveCodexPathOverride({
      SANDY_CODEX_PATH: codexPath,
    }), /SANDY_CODEX_PATH path is not executable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveManagedCodexAsset maps supported platforms to official release assets", () => {
  assert.deepEqual(resolveManagedCodexAsset("linux", "arm64"), {
    assetName: "codex-aarch64-unknown-linux-musl.tar.gz",
    archive: "tar.gz",
    extractedBinaryName: "codex-aarch64-unknown-linux-musl",
  });
  assert.deepEqual(resolveManagedCodexAsset("win32", "x64"), {
    assetName: "codex-x86_64-pc-windows-msvc.exe",
    archive: "raw",
    extractedBinaryName: "codex-x86_64-pc-windows-msvc.exe",
  });
  assert.equal(resolveManagedCodexAsset("freebsd", "x64"), null);
});

test("resolveCodexTargetTriple maps supported targets", () => {
  assert.equal(resolveCodexTargetTriple("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(resolveCodexTargetTriple("linux", "x64"), "x86_64-unknown-linux-musl");
  assert.equal(resolveCodexTargetTriple("freebsd", "x64"), null);
});

test("resolveCodexVersion reads the installed Codex package version", () => {
  assert.match(resolveCodexVersion(), /^\d+\.\d+\.\d+$/);
});

test("resolveCodexCacheRoot uses the Sandy data directory", () => {
  const root = resolveCodexCacheRoot({
    HOME: "/home/tester",
  });
  assert.equal(root, "/home/tester/.local/share/sandy/codex");
});

test("resolveManagedCodexCacheRoot stores each managed Codex binary under its target triple", () => {
  const root = resolveManagedCodexCacheRoot({
    HOME: "/home/tester",
  }, "darwin", "arm64");
  assert.equal(root, "/home/tester/.local/share/sandy/codex/aarch64-apple-darwin");
});

test("ensureManagedCodexPath returns SANDY_CODEX_PATH without touching the cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-codex-cache-"));
  const codexPath = join(root, process.platform === "win32" ? "codex.exe" : "codex");

  try {
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n");
    await chmod(codexPath, 0o755);

    const resolved = await ensureManagedCodexPath({
      cacheRoot: join(root, "cache"),
      env: {
        SANDY_CODEX_PATH: codexPath,
      },
    });

    assert.equal(resolved, codexPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureManagedCodexPath reuses the cached matching version and prunes older versions", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sandy-codex-cache-"));
  const currentVersion = resolveCodexVersion();
  const currentVersionDir = join(cacheRoot, currentVersion);
  const currentBinaryPath = join(currentVersionDir, process.platform === "win32" ? "codex.exe" : "codex");
  const oldVersionDir = join(cacheRoot, "0.0.1");

  try {
    await mkdir(currentVersionDir, { recursive: true });
    await writeFile(currentBinaryPath, "#!/bin/sh\nexit 0\n");
    await chmod(currentBinaryPath, 0o755);
    await mkdir(oldVersionDir, { recursive: true });
    const failingFetch = (async () => {
      throw new Error("fetch should not be called when the cache already matches");
    }) as unknown as typeof fetch;

    const resolved = await ensureManagedCodexPath({
      cacheRoot,
      fetchFn: failingFetch,
    });

    assert.equal(resolved, currentBinaryPath);
    const entries = await readdir(cacheRoot);
    assert.deepEqual(entries, [currentVersion]);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("ensureManagedCodexPath isolates cross-platform worker caches by target triple", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sandy-codex-cache-"));
  const currentVersion = resolveCodexVersion();
  const linuxTriple = resolveCodexTargetTriple("linux", "x64");
  assert.ok(linuxTriple);

  const workerVersionDir = join(cacheRoot, linuxTriple, currentVersion);
  const workerBinaryPath = join(workerVersionDir, "codex");

  try {
    await mkdir(workerVersionDir, { recursive: true });
    await writeFile(workerBinaryPath, "#!/bin/sh\nexit 0\n");
    await chmod(workerBinaryPath, 0o755);

    const resolved = await ensureManagedCodexPath({
      cacheRoot: join(cacheRoot, linuxTriple),
      platform: "linux",
      arch: "x64",
    });

    assert.equal(resolved, workerBinaryPath);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
