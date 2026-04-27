import { test } from "bun:test";
import assert from "node:assert/strict";
import { ProxyAccess } from "../proxy-access.js";

function createAccess() {
  return new ProxyAccess();
}

test("ProxyAccess issues grants that validate for the matching task and server", () => {
  const access = createAccess();
  const grant = access.issueWorkerGrant("task-1");

  assert.deepEqual(access.validateWorkerGrant({
    taskId: "task-1",
    bearerToken: grant.bearerToken,
  }), { ok: true });
});

test("ProxyAccess rejects grants for the wrong task", () => {
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

test("ProxyAccess accepts the same task grant across different MCP servers", () => {
  const access = new ProxyAccess();
  const grant = access.issueWorkerGrant("task-1");

  assert.deepEqual(access.validateWorkerGrant({
    taskId: "task-1",
    bearerToken: grant.bearerToken,
  }), { ok: true });
});

test("ProxyAccess rejects invalid bearer tokens", () => {
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
