import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { SandyOAuthClientProvider } from "./oauth-provider.js";

test("SandyOAuthClientProvider prepares a refresh-token request for non-interactive runtime use", async () => {
  const stateFilePath = join(await mkdtemp(join(tmpdir(), "sandy-oauth-provider-")), "homeassistant.json");
  await writeFile(stateFilePath, JSON.stringify({
    tokens: {
      access_token: "expired-token",
      token_type: "Bearer",
      expires_in: 1800,
      refresh_token: "refresh-token-1",
    },
  }), "utf8");

  const provider = new SandyOAuthClientProvider({
    stateFilePath,
    interactive: false,
  });

  const params = await provider.prepareTokenRequest("calendar:read");
  assert.ok(params);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("refresh_token"), "refresh-token-1");
  assert.equal(params.get("scope"), "calendar:read");
});

test("SandyOAuthClientProvider keeps its cached runtime state in sync via saveTokens", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "sandy-oauth-provider-"));
  const stateFilePath = join(stateDirectory, "homeassistant.json");
  await writeFile(stateFilePath, JSON.stringify({
    tokens: {
      access_token: "stale-token",
      token_type: "Bearer",
      expires_in: 1800,
      refresh_token: "refresh-token-1",
    },
  }), "utf8");

  const provider = new SandyOAuthClientProvider({
    stateFilePath,
    interactive: false,
  });

  assert.equal((await provider.tokens())?.access_token, "stale-token");

  await provider.saveTokens({
    access_token: "fresh-token",
    token_type: "Bearer",
    expires_in: 1800,
    refresh_token: "refresh-token-2",
  });

  assert.equal((await provider.tokens())?.access_token, "fresh-token");
  const params = await provider.prepareTokenRequest();
  assert.ok(params);
  assert.equal(params.get("refresh_token"), "refresh-token-2");
  const persistedState = JSON.parse(await readFile(stateFilePath, "utf8")) as {
    tokens: {
      refresh_token: string;
    };
  };
  assert.equal(
    persistedState.tokens.refresh_token,
    "refresh-token-2",
  );
});

test("SandyOAuthClientProvider does not override interactive authorization-code exchange", async () => {
  const stateFilePath = join(await mkdtemp(join(tmpdir(), "sandy-oauth-provider-")), "todoist.json");
  await writeFile(stateFilePath, JSON.stringify({
    tokens: {
      refresh_token: "refresh-token-1",
    },
  }), "utf8");

  const provider = new SandyOAuthClientProvider({
    stateFilePath,
    interactive: true,
    redirectUrl: "http://127.0.0.1:60399/callback",
  });

  assert.equal(await provider.prepareTokenRequest("data:read_write"), undefined);
});
