import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpTokenAuthorizer } from "./token-authorizer.js";
import { JobApprovalStore } from "../jobs/job-approval-store.js";
import { InMemorySessionStore } from "../session/in-memory-session-store.js";
import type { PersistentApprovalStore } from "../privilege/persistent-approval-store.js";

function createFakePersistentApprovalStore(
  alwaysAllowed: Array<{ tokenId: string; host: string }> = [],
): PersistentApprovalStore {
  const allowed = new Set(alwaysAllowed.map((a) => `${a.tokenId}:${a.host}`));
  return {
    isAlwaysAllowed: () => false,
    allowTool: async () => {},
    isResourceReadAlwaysAllowed: () => false,
    allowResourceRead: async () => {},
    isHttpTokenAlwaysAllowed: (tokenId: string, host: string) => allowed.has(`${tokenId}:${host}`),
    allowHttpToken: async () => {},
    isHostDirectoryAlwaysAllowed: () => false,
    allowHostDirectory: async () => {},
  };
}

test("HttpTokenAuthorizer prefers worker_session grants over once grants", async () => {
  const sessionStore = new InMemorySessionStore();
  const authorizer = new HttpTokenAuthorizer(
    sessionStore,
    createFakePersistentApprovalStore(),
    new JobApprovalStore(mkdtempSync(join(tmpdir(), "sandy-job-approvals-"))),
  );

  const chatId = "chat-1";
  const taskId = "task-1";

  const session = sessionStore.getOrCreate(chatId);
  session.activeTask = {
    taskId,
    taskName: "test",
    status: "running",
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pendingPrivilegeRequest: null,
    taskPolicy: { autoApproveMcpServers: [], autoApproveHttpTokens: [] },
    approvedMcpTools: [],
    approvedMcpResourceReads: [],
    approvedHttpTokenSessionGrants: [{ tokenId: "api-token", host: "api.example.com" }],
    approvedHttpTokenOnceGrants: [{ tokenId: "api-token", host: "api.example.com", consumed: false }],
    approvedHostDirectories: [],
    workerConnected: false,
    taskSummary: null,
    origin: { kind: "launchedByUser", chatId },
    interactionState: "interacting",
  };

  const first = await authorizer.authorizeHttpTokenUse({
    taskId,
    tokenId: "api-token",
    host: "api.example.com",
  });
  const second = await authorizer.authorizeHttpTokenUse({
    taskId,
    tokenId: "api-token",
    host: "api.example.com",
  });

  assert.equal(first.outcome, "approved");
  assert.equal(first.scope, "worker_session");
  assert.equal(second.outcome, "approved");
  assert.equal(second.scope, "worker_session");
  assert.equal(session.activeTask.approvedHttpTokenOnceGrants[0]?.consumed, false);
});

test("HttpTokenAuthorizer consumes once grants without affecting session grants", async () => {
  const sessionStore = new InMemorySessionStore();
  const authorizer = new HttpTokenAuthorizer(
    sessionStore,
    createFakePersistentApprovalStore(),
    new JobApprovalStore(mkdtempSync(join(tmpdir(), "sandy-job-approvals-"))),
  );

  const chatId = "chat-1";
  const taskId = "task-1";

  const session = sessionStore.getOrCreate(chatId);
  session.activeTask = {
    taskId,
    taskName: "test",
    status: "running",
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pendingPrivilegeRequest: null,
    taskPolicy: { autoApproveMcpServers: [], autoApproveHttpTokens: [] },
    approvedMcpTools: [],
    approvedMcpResourceReads: [],
    approvedHttpTokenSessionGrants: [],
    approvedHttpTokenOnceGrants: [{ tokenId: "api-token", host: "api.example.com", consumed: false }],
    approvedHostDirectories: [],
    workerConnected: false,
    taskSummary: null,
    origin: { kind: "launchedByUser", chatId },
    interactionState: "interacting",
  };

  const first = await authorizer.authorizeHttpTokenUse({
    taskId,
    tokenId: "api-token",
    host: "api.example.com",
  });
  const second = await authorizer.authorizeHttpTokenUse({
    taskId,
    tokenId: "api-token",
    host: "api.example.com",
  });

  assert.equal(first.outcome, "approved");
  assert.equal(first.scope, "once");
  assert.equal(session.activeTask.approvedHttpTokenOnceGrants[0]?.consumed, true);
  assert.equal(second.outcome, "denied");
});

test("HttpTokenAuthorizer returns failed when task is not registered", async () => {
  const authorizer = new HttpTokenAuthorizer(
    new InMemorySessionStore(),
    createFakePersistentApprovalStore(),
    new JobApprovalStore(mkdtempSync(join(tmpdir(), "sandy-job-approvals-"))),
  );

  const result = await authorizer.authorizeHttpTokenUse({
    taskId: "missing-task",
    tokenId: "api-token",
    host: "api.example.com",
  });

  assert.equal(result.outcome, "failed");
});

test("HttpTokenAuthorizer applies persistent approvals only when task policy enables token auto-approval", async () => {
  const sessionStore = new InMemorySessionStore();
  const authorizer = new HttpTokenAuthorizer(
    sessionStore,
    createFakePersistentApprovalStore([{ tokenId: "api-token", host: "api.example.com" }]),
    new JobApprovalStore(mkdtempSync(join(tmpdir(), "sandy-job-approvals-"))),
  );

  const chatId = "chat-1";
  const taskId = "task-1";

  const session = sessionStore.getOrCreate(chatId);
  session.activeTask = {
    taskId,
    taskName: "test",
    status: "running",
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pendingPrivilegeRequest: null,
    taskPolicy: { autoApproveMcpServers: [], autoApproveHttpTokens: [] },
    approvedMcpTools: [],
    approvedMcpResourceReads: [],
    approvedHttpTokenSessionGrants: [],
    approvedHttpTokenOnceGrants: [],
    approvedHostDirectories: [],
    workerConnected: false,
    taskSummary: null,
    origin: { kind: "launchedByUser", chatId },
    interactionState: "interacting",
  };

  const beforeAccess = await authorizer.authorizeHttpTokenUse({
    taskId,
    tokenId: "api-token",
    host: "api.example.com",
  });
  session.activeTask.taskPolicy.autoApproveHttpTokens.push("api-token");
  const afterAccess = await authorizer.authorizeHttpTokenUse({
    taskId,
    tokenId: "api-token",
    host: "api.example.com",
  });

  assert.equal(beforeAccess.outcome, "denied");
  assert.equal(afterAccess.outcome, "approved");
  assert.equal(afterAccess.scope, "always");
});
