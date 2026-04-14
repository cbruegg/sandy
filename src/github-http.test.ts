import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildGitHubHeaders, isGitHubUrl } from "./github-http.js";

test("buildGitHubHeaders adds Sandy as the GitHub user agent", () => {
  assert.deepEqual(buildGitHubHeaders({
    accept: "application/vnd.github+json",
  }), {
    "user-agent": "Sandy",
    accept: "application/vnd.github+json",
  });
});

test("isGitHubUrl matches GitHub API and download hosts", () => {
  assert.equal(isGitHubUrl("https://api.github.com/repos/openai/codex/releases/tags/rust-v0.118.0"), true);
  assert.equal(isGitHubUrl("https://github.com/openai/codex/releases/download/rust-v0.118.0/codex-aarch64-apple-darwin.tar.gz"), true);
  assert.equal(isGitHubUrl("https://example.com/archive.tar.gz"), false);
});
