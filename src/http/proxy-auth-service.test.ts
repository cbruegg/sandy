import { test } from "bun:test";
import assert from "node:assert/strict";
import { ProxyAccess } from "../proxy-access.js";
import { ProxyAuthService } from "./proxy-auth-service.js";

test("ProxyAuthService resolves headers for approved requests", () => {
  const access = new ProxyAccess("test-secret");
  const service = new ProxyAuthService({
    access,
    httpTokens: { token_1: { description: "Test API token.", value: "real-secret" } },
    authorizeHttpTokenUse: () => ({ outcome: "approved", message: "ok" }),
  });

  const result = service.resolveProxyRequest({
    type: "auth_request",
    requestId: "request-1",
    proxyAuthUsername: "Bearer",
    proxyAuthPassword: access.issueWorkerGrant("task-1").bearerToken,
    targetHost: "api.example.com",
    headers: [
      { name: "x-api-key", value: "SANDY_TOKEN_token_1" },
      { name: "proxy-connection", value: "keep-alive" },
    ],
  });

  assert.deepEqual(result, {
    type: "auth_response",
    requestId: "request-1",
    outcome: "approved",
    headers: [
      { name: "x-api-key", value: "real-secret" },
    ],
  });
});

test("ProxyAuthService denies rejected token approvals", () => {
  const access = new ProxyAccess("test-secret");
  const service = new ProxyAuthService({
    access,
    httpTokens: { token_1: { description: "Test API token.", value: "real-secret" } },
    authorizeHttpTokenUse: () => ({ outcome: "denied", message: "not allowed" }),
  });

  const result = service.resolveProxyRequest({
    type: "auth_request",
    requestId: "request-1",
    proxyAuthUsername: "Bearer",
    proxyAuthPassword: access.issueWorkerGrant("task-1").bearerToken,
    targetHost: "api.example.com",
    headers: [{ name: "authorization", value: "Bearer SANDY_TOKEN_token_1" }],
  });

  assert.deepEqual(result, {
    type: "auth_response",
    requestId: "request-1",
    outcome: "denied",
    message: "not allowed",
  });
});

test("ProxyAuthService handles authorization errors gracefully", () => {
  const access = new ProxyAccess("test-secret");
  const service = new ProxyAuthService({
    access,
    httpTokens: { token_1: { description: "Test API token.", value: "real-secret" } },
    authorizeHttpTokenUse: () => {
      throw new Error("database down");
    },
  });

  assert.throws(() => service.resolveProxyRequest({
    type: "auth_request",
    requestId: "request-1",
    proxyAuthUsername: "Bearer",
    proxyAuthPassword: access.issueWorkerGrant("task-1").bearerToken,
    targetHost: "api.example.com",
    headers: [{ name: "authorization", value: "Bearer SANDY_TOKEN_token_1" }],
  }), /database down/);
});

test("ProxyAuthService denies invalid proxy auth usernames", () => {
  const service = new ProxyAuthService({
    access: new ProxyAccess("test-secret"),
    httpTokens: { token_1: { description: "Test API token.", value: "real-secret" } },
    authorizeHttpTokenUse: () => ({ outcome: "approved", message: "ok" }),
  });

  const result = service.resolveProxyRequest({
    type: "auth_request",
    requestId: "request-1",
    proxyAuthUsername: "Basic",
    proxyAuthPassword: "irrelevant",
    targetHost: "api.example.com",
    headers: [],
  });

  assert.deepEqual(result, {
    type: "auth_response",
    requestId: "request-1",
    outcome: "denied",
    message: "Proxy authentication username must be Bearer.",
  });
});

test("ProxyAuthService denies invalid worker grants", () => {
  const service = new ProxyAuthService({
    access: new ProxyAccess("test-secret"),
    httpTokens: { token_1: { description: "Test API token.", value: "real-secret" } },
    authorizeHttpTokenUse: () => ({ outcome: "approved", message: "ok" }),
  });

  const result = service.resolveProxyRequest({
    type: "auth_request",
    requestId: "request-1",
    proxyAuthUsername: "Bearer",
    proxyAuthPassword: "invalid",
    targetHost: "api.example.com",
    headers: [{ name: "authorization", value: "Bearer SANDY_TOKEN_token_1" }],
  });
  
  assert.equal(result.type, "auth_response");
  assert.equal(result.outcome, "denied");
  assert.match(result.message, /(invalid|malformed)/i);
});
