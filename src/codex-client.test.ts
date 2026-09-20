import { test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const currentCodeModeHostPath = join(currentVersionDir, process.platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host");
  const oldVersionDir = join(cacheRoot, "0.0.1");

  try {
    await mkdir(currentVersionDir, { recursive: true });
    await writeFile(currentBinaryPath, "#!/bin/sh\nexit 0\n");
    await chmod(currentBinaryPath, 0o755);
    await writeFile(currentCodeModeHostPath, "#!/bin/sh\nexit 0\n");
    await chmod(currentCodeModeHostPath, 0o755);
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
  const workerCodeModeHostPath = join(workerVersionDir, "codex-code-mode-host");

  try {
    await mkdir(workerVersionDir, { recursive: true });
    await writeFile(workerBinaryPath, "#!/bin/sh\nexit 0\n");
    await chmod(workerBinaryPath, 0o755);
    await writeFile(workerCodeModeHostPath, "#!/bin/sh\nexit 0\n");
    await chmod(workerCodeModeHostPath, 0o755);

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

test("ensureManagedCodexPath downloads the Code Mode host alongside Codex", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sandy-codex-cache-"));
  const version = resolveCodexVersion();
  const codexAssetName = "codex-x86_64-pc-windows-msvc.exe";
  const codeModeHostAssetName = "codex-code-mode-host-x86_64-pc-windows-msvc.exe";
  const codexContents = "codex executable";
  const codeModeHostContents = "code mode host executable";
  const assetResponse = (name: string, contents: string) => ({
    name,
    browser_download_url: `https://example.test/${name}`,
    digest: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
    size: Buffer.byteLength(contents),
  });
  const assets = [
    assetResponse(codexAssetName, codexContents),
    assetResponse(codeModeHostAssetName, codeModeHostContents),
  ];
  const fetchCalls: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.startsWith("https://api.github.com/")) {
      return new Response(JSON.stringify({ assets }), { status: 200 });
    }
    if (url.endsWith(codexAssetName)) {
      return new Response(codexContents, { status: 200 });
    }
    if (url.endsWith(codeModeHostAssetName)) {
      return new Response(codeModeHostContents, { status: 200 });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as unknown as typeof fetch;

  try {
    const codexPath = await ensureManagedCodexPath({
      cacheRoot,
      fetchFn,
      platform: "win32",
      arch: "x64",
    });

    assert.equal(codexPath, join(cacheRoot, version, "codex.exe"));
    assert.equal(await Bun.file(codexPath).text(), codexContents);
    assert.equal(await Bun.file(join(cacheRoot, version, "codex-code-mode-host.exe")).text(), codeModeHostContents);
    assert.equal(fetchCalls.length, 3);
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
