import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildReleaseApiUrl, parseGitHubRelease, resolveExecutableAssets, waitWithSoftTimeout } from "./self-update.js";

test("resolveExecutableAssets maps supported platforms to published asset names", () => {
  assert.deepEqual(resolveExecutableAssets("linux", "x64"), {
    bundleAssetName: "sandy-bun-linux-x64.zip",
    binaryFileName: "sandy-bun-linux-x64",
    updaterFileName: "sandy-updater-bun-linux-x64",
  });
  assert.deepEqual(resolveExecutableAssets("win32", "arm64"), {
    bundleAssetName: "sandy-bun-windows-arm64.zip",
    binaryFileName: "sandy-bun-windows-arm64.exe",
    updaterFileName: "sandy-updater-bun-windows-arm64.exe",
  });
  assert.equal(resolveExecutableAssets("freebsd", "x64"), null);
});

test("buildReleaseApiUrl targets the rolling GitHub release endpoint", () => {
  assert.equal(
    buildReleaseApiUrl("cbruegg/sandy", "main-build"),
    "https://api.github.com/repos/cbruegg/sandy/releases/tags/main-build",
  );
});

test("parseGitHubRelease validates and returns asset metadata", () => {
  const release = parseGitHubRelease({
    target_commitish: "abcdef0123456789",
    published_at: "2026-04-12T10:00:00Z",
    assets: [
      {
        name: "sandy-bun-linux-x64",
        browser_download_url: "https://github.com/cbruegg/sandy/releases/download/main-build/sandy-bun-linux-x64",
        digest: "sha256:deadbeef",
        size: 123,
      },
    ],
  });

  assert.equal(release.gitRevision, "abcdef0123456789");
  assert.deepEqual(release.assets[0], {
    name: "sandy-bun-linux-x64",
    browserDownloadUrl: "https://github.com/cbruegg/sandy/releases/download/main-build/sandy-bun-linux-x64",
    sha256: "deadbeef",
    size: 123,
  });
});

test("parseGitHubRelease rejects malformed payloads", () => {
  assert.throws(() => {
    parseGitHubRelease({
      target_commitish: "",
      published_at: "2026-04-12T10:00:00Z",
      assets: [],
    });
  }, /target_commitish/);
});

test("waitWithSoftTimeout resolves after the timeout without waiting for the operation", async () => {
  let timedOut = false;
  const startedAt = Date.now();

  await waitWithSoftTimeout(
    () => new Promise(() => {}),
    20,
    () => {
      timedOut = true;
    },
  );

  const elapsedMs = Date.now() - startedAt;
  assert.equal(timedOut, true);
  assert(elapsedMs < 250, `expected timeout helper to return quickly, took ${elapsedMs}ms`);
});

test("waitWithSoftTimeout propagates operation failures before the timeout", async () => {
  await assert.rejects(
    waitWithSoftTimeout(
      async () => {
        throw new Error("boom");
      },
      1_000,
      () => {
        throw new Error("timeout callback should not run");
      },
    ),
    /boom/,
  );
});
