import test from "node:test";
import assert from "node:assert/strict";
import { SandyMcpProxyAccess } from "./proxy-access.js";

function createAccess() {
  return new SandyMcpProxyAccess();
}

test("SandyMcpProxyAccess issues grants that validate for the matching task and server", () => {
  const access = createAccess();
  const grant = access.issueWorkerGrant("task-1");

  assert.deepEqual(access.validateWorkerGrant({
    taskId: "task-1",
    bearerToken: grant.bearerToken,
  }), { ok: true });
});

test("SandyMcpProxyAccess rejects grants for the wrong task", () => {
  const access = createAccess();
  const grant = access.issueWorkerGrant("task-1");

  assert.deepEqual(access.validateWorkerGrant({
    taskId: "task-2",
    bearerToken: grant.bearerToken,
  }), {
    ok: false,
    code: "task_mismatch",
    message: "Bearer token does not grant access to this task.",
  });
});

test("SandyMcpProxyAccess accepts the same task grant across different MCP servers", () => {
  const access = new SandyMcpProxyAccess();
  const grant = access.issueWorkerGrant("task-1");

  assert.deepEqual(access.validateWorkerGrant({
    taskId: "task-1",
    bearerToken: grant.bearerToken,
  }), { ok: true });
});

test("SandyMcpProxyAccess rejects invalid bearer tokens", () => {
  const access = createAccess();
  const result = access.validateWorkerGrant({
    taskId: "task-1",
    bearerToken: "not-a-jwt",
  });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.code, "invalid_token");
  assert.match(result.message, /jwt|token/i);
});
