import { test } from "bun:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { normalizeOAuthLoginError, parseAuthorizationCodeInput, resolveLoginServerUrl, SandyMcpAdminService } from "./admin-service.js";

test("normalizeOAuthLoginError rewrites Zod discovery errors into a targeted message", () => {
  const result = z.object({
    issuer: z.string(),
    authorization_endpoint: z.string().url(),
  }).safeParse({
    authorization_endpoint: "not-a-url",
  });

  assert.equal(result.success, false);
  if (result.success) {
    return;
  }

  const error = normalizeOAuthLoginError("homeassistant", "http://raspinas:8123/api/mcp", result.error, {
    url: "http://raspinas:8123/.well-known/oauth-authorization-server",
    status: 200,
    body: "{\"authorization_endpoint\":\"/auth/authorize\"}",
  });
  assert.match(error.message, /OAuth login for homeassistant failed/);
  assert.match(error.message, /http:\/\/raspinas:8123\/api\/mcp/);
  assert.match(error.message, /issuer: Invalid input/);
  assert.match(error.message, /authorization_endpoint: Invalid URL/);
  assert.match(error.message, /Raw response:/);
  assert.match(error.message, /Status: 200/);
  assert.match(error.message, /"authorization_endpoint":"\/auth\/authorize"/);
});

test("normalizeOAuthLoginError preserves non-Zod errors", () => {
  const original = new Error("boom");
  assert.equal(normalizeOAuthLoginError("homeassistant", "http://raspinas:8123/api/mcp", original), original);
});

test("SandyMcpAdminService lists stdio servers without OAuth state", () => {
  const admin = new SandyMcpAdminService("/tmp/sandy-config", {
    spotify: {
      transport: "stdio",
      command: "node",
      args: ["build/index.js"],
      workingDirectory: "/tmp/spotify",
      env: {
        SPOTIFY_CLIENT_ID: "client-id",
      },
    },
  });

  assert.deepEqual(admin.listServers(), [{
    serverId: "spotify",
    transport: "stdio",
    command: "node",
    args: ["build/index.js"],
    workingDirectory: "/tmp/spotify",
    envKeys: ["SPOTIFY_CLIENT_ID"],
    oauthConfigured: false,
  }]);
});

test("SandyMcpAdminService rejects OAuth login for stdio servers", async () => {
  const admin = new SandyMcpAdminService("/tmp/sandy-config", {
    spotify: {
      transport: "stdio",
      command: "node",
      args: ["build/index.js"],
      workingDirectory: "/tmp/spotify",
      env: {},
    },
  });

  await assert.rejects(() => admin.login("spotify"), /uses stdio/);
  await assert.rejects(() => admin.logout("spotify"), /uses stdio/);
});

test("parseAuthorizationCodeInput accepts a raw code", () => {
  assert.equal(parseAuthorizationCodeInput("raw-code-123"), "raw-code-123");
});

test("parseAuthorizationCodeInput extracts the code from a full callback URL", () => {
  assert.equal(
    parseAuthorizationCodeInput("http://127.0.0.1:45221/callback?code=abc123&state=xyz"),
    "abc123",
  );
});

test("parseAuthorizationCodeInput extracts the code from a pasted callback path", () => {
  assert.equal(
    parseAuthorizationCodeInput("/callback?code=abc123&state=xyz"),
    "abc123",
  );
});

test("parseAuthorizationCodeInput rejects callback input without a code", () => {
  assert.equal(parseAuthorizationCodeInput("http://127.0.0.1:45221/callback?state=xyz"), null);
});

test("parseAuthorizationCodeInput surfaces OAuth callback errors", () => {
  assert.throws(
    () => parseAuthorizationCodeInput("http://127.0.0.1:45221/callback?error=access_denied"),
    /OAuth callback returned error: access_denied/,
  );
});

test("resolveLoginServerUrl rewrites host.docker.internal for host-side login", () => {
  assert.equal(
    resolveLoginServerUrl("http://host.docker.internal:8123/api/mcp"),
    "http://localhost:8123/api/mcp",
  );
  assert.equal(
    resolveLoginServerUrl("https://example.com/api/mcp"),
    "https://example.com/api/mcp",
  );
});
