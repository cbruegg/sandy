import { test } from "bun:test";
import assert from "node:assert/strict";
import { HttpTokenAuthorizer } from "./token-authorizer.js";
import { InMemorySessionStore } from "../session/in-memory-session-store.js";
import { TaskRegistry } from "../task-registry.js";
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
  };
}

test("HttpTokenAuthorizer prefers worker_session grants over once grants", async () => {
  const taskRegistry = new TaskRegistry();
  const sessionStore = new InMemorySessionStore();
  const authorizer = new HttpTokenAuthorizer(
    taskRegistry,
    sessionStore,
    createFakePersistentApprovalStore(),
  );

  const chatId = "chat-1";
  const taskId = "task-1";
  taskRegistry.register(taskId, chatId);

  const session = sessionStore.getOrCreate(chatId);
  session.activeTask = {
    taskId,
    taskName: "test",
    taskBrief: "test brief",
    status: "running",
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pendingPrivilegeRequest: null,
    taskPolicy: { autoApproveMcpServers: [], autoApproveHttpTokens: [] },
    approvedMcpTools: [],
    approvedMcpResourceReads: [],
    approvedHttpTokenSessionGrants: [{ tokenId: "api-token", host: "api.example.com" }],
    approvedHttpTokenOnceGrants: [{ tokenId: "api-token", host: "api.example.com", consumed: false }],
    workerConnected: false,
    taskSummary: null,
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
  const taskRegistry = new TaskRegistry();
  const sessionStore = new InMemorySessionStore();
  const authorizer = new HttpTokenAuthorizer(
    taskRegistry,
    sessionStore,
    createFakePersistentApprovalStore(),
  );

  const chatId = "chat-1";
  const taskId = "task-1";
  taskRegistry.register(taskId, chatId);

  const session = sessionStore.getOrCreate(chatId);
  session.activeTask = {
    taskId,
    taskName: "test",
    taskBrief: "test brief",
    status: "running",
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pendingPrivilegeRequest: null,
    taskPolicy: { autoApproveMcpServers: [], autoApproveHttpTokens: [] },
    approvedMcpTools: [],
    approvedMcpResourceReads: [],
    approvedHttpTokenSessionGrants: [],
    approvedHttpTokenOnceGrants: [{ tokenId: "api-token", host: "api.example.com", consumed: false }],
    workerConnected: false,
    taskSummary: null,
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
    new TaskRegistry(),
    new InMemorySessionStore(),
    createFakePersistentApprovalStore(),
  );

  const result = await authorizer.authorizeHttpTokenUse({
    taskId: "missing-task",
    tokenId: "api-token",
    host: "api.example.com",
  });

  assert.equal(result.outcome, "failed");
});

test("HttpTokenAuthorizer applies persistent approvals only when task policy enables token auto-approval", async () => {
  const taskRegistry = new TaskRegistry();
  const sessionStore = new InMemorySessionStore();
  const authorizer = new HttpTokenAuthorizer(
    taskRegistry,
    sessionStore,
    createFakePersistentApprovalStore([{ tokenId: "api-token", host: "api.example.com" }]),
  );

  const chatId = "chat-1";
  const taskId = "task-1";
  taskRegistry.register(taskId, chatId);

  const session = sessionStore.getOrCreate(chatId);
  session.activeTask = {
    taskId,
    taskName: "test",
    taskBrief: "test brief",
    status: "running",
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    pendingPrivilegeRequest: null,
    taskPolicy: { autoApproveMcpServers: [], autoApproveHttpTokens: [] },
    approvedMcpTools: [],
    approvedMcpResourceReads: [],
    approvedHttpTokenSessionGrants: [],
    approvedHttpTokenOnceGrants: [],
    workerConnected: false,
    taskSummary: null,
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
