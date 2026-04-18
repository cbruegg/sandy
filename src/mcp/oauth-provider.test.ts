import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "bun:test";
import { SandyOAuthClientProvider } from "./oauth-provider.js";

test("SandyOAuthClientProvider prepares a refresh-token request for non-interactive runtime use", async () => {
  const stateFilePath = join(await mkdtemp(join(tmpdir(), "sandy-oauth-provider-")), "homeassistant.json");
  await writeFile(stateFilePath, JSON.stringify({
    configuredServerUrl: "http://host.docker.internal:8123/api/mcp",
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
    configuredServerUrl: "http://host.docker.internal:8123/api/mcp",
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
    configuredServerUrl: "http://host.docker.internal:8123/api/mcp",
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
    configuredServerUrl: "http://host.docker.internal:8123/api/mcp",
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
    configuredServerUrl: string;
    tokens: {
      refresh_token: string;
    };
  };
  assert.equal(persistedState.configuredServerUrl, "http://host.docker.internal:8123/api/mcp");
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
    configuredServerUrl: "https://todoist.example/mcp",
  });

  assert.equal(await provider.prepareTokenRequest("data:read_write"), undefined);
});

test("SandyOAuthClientProvider invalidates saved state when the configured server URL changes", async () => {
  const stateFilePath = join(await mkdtemp(join(tmpdir(), "sandy-oauth-provider-")), "homeassistant.json");
  await writeFile(stateFilePath, JSON.stringify({
    configuredServerUrl: "http://raspinas:8123/api/mcp",
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
    configuredServerUrl: "http://host.docker.internal:8123/api/mcp",
  });

  assert.equal(await provider.tokens(), undefined);
  await assert.rejects(
    () => provider.prepareTokenRequest(),
    /Run "sandy mcp login <serverId>" first/,
  );
});

test("SandyOAuthClientProvider rewrites saved discovery URLs back to the configured server URL", async () => {
  const stateFilePath = join(await mkdtemp(join(tmpdir(), "sandy-oauth-provider-")), "homeassistant.json");
  const provider = new SandyOAuthClientProvider({
    stateFilePath,
    interactive: true,
    redirectUrl: "http://127.0.0.1:60399/callback",
    configuredServerUrl: "http://host.docker.internal:8123/api/mcp",
    loginServerUrl: "http://localhost:8123/api/mcp",
  });

  await provider.saveDiscoveryState({
    authorizationServerUrl: "http://localhost:8123/",
    authorizationServerMetadata: {
      issuer: "http://localhost:8123/",
      authorization_endpoint: "http://localhost:8123/auth/authorize",
      token_endpoint: "http://localhost:8123/auth/token",
      response_types_supported: ["code"],
      revocation_endpoint: "http://localhost:8123/auth/revoke",
    },
  });

  const persistedState = JSON.parse(await readFile(stateFilePath, "utf8")) as {
    discoveryState: {
      authorizationServerUrl: string;
      authorizationServerMetadata: {
        issuer: string;
        token_endpoint: string;
      };
    };
  };
  assert.equal(persistedState.discoveryState.authorizationServerUrl, "http://host.docker.internal:8123/");
  assert.equal(persistedState.discoveryState.authorizationServerMetadata.issuer, "http://host.docker.internal:8123/");
  assert.equal(
    persistedState.discoveryState.authorizationServerMetadata.token_endpoint,
    "http://host.docker.internal:8123/auth/token",
  );
});
