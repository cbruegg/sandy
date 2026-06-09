import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { HostfsBroker } from "../hostfs/hostfs-broker.js";
import type { HostDirectoryAccessLevel } from "../hostfs/path-policy.js";
import { HttpTokenAuthorizer } from "../http/token-authorizer.js";
import { messages } from "../messages.js";
import {
  createTestOrchestrator,
  expectDefined,
  FakePrivilegeBroker,
  InMemoryJobApprovalStore,
  RecordingChannel,
  StubMainAgent,
} from "./test-helpers.js";
import { hostGrantsPrefix } from "../paths.js";
import type { PersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import { sharedWorkspaceMountPath } from "../shared-workspace.js";
import type { JobDefinition } from "../jobs/job-validation.js";

async function waitFor(check: () => boolean, attempts = 20): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for test condition.");
}

test("orchestrator applies supported privilege requests deterministically and outside the main agent path", async () => {
  const privilegeBroker = new FakePrivilegeBroker();
  const { orchestrator, runner, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Need a host file copied into the share.",
      taskName: "copy-in",
      taskLanguage: "English",
    }),
    privilegeBroker,
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-3",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Copy a host file into the shared workspace",
    rawText: "Copy a host file into the shared workspace",
    attachments: [],
  });

  const taskId = expectDefined(runner.launches[0], "Expected launch.").taskId;
  const toolCallPromise = orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "copy_into_share",
    arguments: {
      sourcePath: "/Users/test/input.txt",
      targetPath: `${sharedWorkspaceMountPath}/input.txt`,
      reason: "Need a local fixture file.",
    },
  });

  const requestId = channel.privilegeRequests[0]?.request.requestId;

  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-3",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "approve",
    requestId,
  });

  assert.equal(channel.privilegeRequests.length, 1);
  assert.deepEqual(privilegeBroker.appliedRequests, [{
    request: {
      type: "copy_into_share",
      sourcePath: "/Users/test/input.txt",
      targetPath: `${sharedWorkspaceMountPath}/input.txt`,
      reason: "Need a local fixture file.",
    },
    taskId,
    taskSharePath: resolve(import.meta.dirname, "../../tmp", taskId),
  }]);
  assert.deepEqual(await toolCallPromise, {
    isError: false,
    message: "Applied copy_into_share.",
  });
  assert.ok(requestId);
});

test("orchestrator sends worker-requested shared files back through the channel", async () => {
  const { orchestrator, runner, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Generate a file.",
      taskName: "file-out",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-file-out",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Generate a file",
    rawText: "Generate a file",
    attachments: [],
  });

  await orchestrator.executeNativeWorkerToolCall({
    taskId: expectDefined(runner.launches[0], "Expected launch.").taskId,
    toolName: "send_file_to_channel",
    arguments: {
      path: `${sharedWorkspaceMountPath}/results/output.txt`,
      caption: "Generated output",
    },
  });

  assert.deepEqual(channel.sentFiles, [{
    chatId: "chat-file-out",
    filePath: resolve(import.meta.dirname, "../../tmp", expectDefined(runner.launches[0], "Expected launch.").taskId, "results/output.txt"),
    caption: "Generated output",
  }]);
});

test("orchestrator fails the active task if channel file delivery fails", async () => {
  const channel = new RecordingChannel();
  channel.sendFileError = new Error("Telegram upload failed.");
  const { orchestrator, runner, store } = createTestOrchestrator({
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Prepare a file.",
      taskName: "file-task",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-file-failure",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Prepare a file",
    rawText: "Prepare a file",
    attachments: [],
  });

  const toolResult = await orchestrator.executeNativeWorkerToolCall({
    taskId: expectDefined(runner.launches[0], "Expected launch.").taskId,
    toolName: "send_file_to_channel",
    arguments: {
      path: `${sharedWorkspaceMountPath}/result.txt`,
      caption: "Result",
    },
  });

  const session = store.getOrCreate("chat-file-failure");
  assert.equal(session.activeTask, null);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.taskFailed("Telegram upload failed."));
  assert.equal(runner.handle.closeCalls, 1);
  assert.deepEqual(toolResult, {
    isError: true,
    message: "Telegram upload failed.",
  });
});

test("orchestrator authorizes mcp resource reads from persistent config", async () => {
  const persistentApprovalStore: PersistentApprovalStore = {
    isAlwaysAllowed: () => false,
    allowTool: async () => {},
    isResourceReadAlwaysAllowed: (_serverId, uri) => uri === "test://resource",
    allowResourceRead: async () => {},
    isHttpTokenAlwaysAllowed: () => false,
    allowHttpToken: async () => {},
    isHostDirectoryAlwaysAllowed: () => false,
    allowHostDirectory: async () => {},
  };
  const { orchestrator, runner } = createTestOrchestrator({
    persistentApprovalStore,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Read a resource.",
      taskName: "resource-read",
      taskLanguage: "English",
      taskPolicy: {
        autoApproveMcpServers: ["todoist"],
        autoApproveHttpTokens: [],
      },
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-resource",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Read a resource",
    rawText: "Read a resource",
    attachments: [],
  });

  const taskId = runner.launches[0]?.taskId;
  assert.ok(taskId);

  const approved = await orchestrator.authorizeMcpResourceRead({
    taskId,
    serverId: "todoist",
    uri: "test://resource",
  });

  assert.equal(approved.outcome, "approved");
  assert.equal(approved.scope, "always");
});

test("orchestrator does not apply persistent mcp approvals when task policy omits the server", async () => {
  const persistentApprovalStore: PersistentApprovalStore = {
    isAlwaysAllowed: () => false,
    allowTool: async () => {},
    isResourceReadAlwaysAllowed: (_serverId, uri) => uri === "test://resource",
    allowResourceRead: async () => {},
    isHttpTokenAlwaysAllowed: () => false,
    allowHttpToken: async () => {},
    isHostDirectoryAlwaysAllowed: () => false,
    allowHostDirectory: async () => {},
  };
  const { orchestrator, runner, channel } = createTestOrchestrator({
    persistentApprovalStore,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Read a resource.",
      taskName: "resource-read",
      taskLanguage: "English",
      taskPolicy: {
        autoApproveMcpServers: [],
        autoApproveHttpTokens: [],
      },
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-resource-no-server-access",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Read a resource",
    rawText: "Read a resource",
    attachments: [],
  });

  const taskId = runner.launches[0]?.taskId;
  assert.ok(taskId);

  const promise = orchestrator.authorizeMcpResourceRead({
    taskId,
    serverId: "todoist",
    uri: "test://resource",
  });
  await new Promise<void>((resolve) => setImmediate(() => resolve()));

  const request = channel.privilegeRequests[0]?.request;
  assert.equal(request?.kind, "mcp_resource_read");

  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-resource-no-server-access",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "approve_once",
    requestId: request?.requestId,
  });

  const result = await promise;
  assert.equal(result.outcome, "approved");
});

test("orchestrator confirms persisted mcp tool approval suitability and reuses it for the task", async () => {
  const persistentApprovalStore: PersistentApprovalStore = {
    isAlwaysAllowed: (serverId, toolName) => serverId === "todoist" && toolName === "addTask",
    allowTool: async () => {},
    isResourceReadAlwaysAllowed: () => false,
    allowResourceRead: async () => {},
    isHttpTokenAlwaysAllowed: () => false,
    allowHttpToken: async () => {},
    isHostDirectoryAlwaysAllowed: () => false,
    allowHostDirectory: async () => {},
  };
  const { orchestrator, runner, channel, store } = createTestOrchestrator({
    persistentApprovalStore,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Add a task.",
      taskName: "todoist-add",
      taskLanguage: "English",
      taskPolicy: {
        autoApproveMcpServers: [],
        autoApproveHttpTokens: [],
      },
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-mcp-confirm",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Add a Todoist task",
    rawText: "Add a Todoist task",
    attachments: [],
  });

  const taskId = runner.launches[0]?.taskId;
  assert.ok(taskId);

  const promise = orchestrator.authorizeMcpToolCall({
    taskId,
    serverId: "todoist",
    toolName: "addTask",
    arguments: { content: "Buy milk" },
  });
  await new Promise<void>((resolve) => setImmediate(() => resolve()));

  assert.equal(channel.privilegeRequests.length, 1);
  const request = channel.privilegeRequests[0]?.request;
  assert.equal(request?.kind, "mcp_tool_call");
  assert.equal(request?.confirmsAutoApprovalForTask, true);

  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-mcp-confirm",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "approve",
    requestId: request?.requestId,
  });

  const result = await promise;
  assert.equal(result.outcome, "approved");
  assert.equal(result.scope, "always");

  const session = store.getOrCreate("chat-mcp-confirm");
  assert.deepEqual(session.activeTask?.taskPolicy.autoApproveMcpServers, ["todoist"]);

  const second = await orchestrator.authorizeMcpToolCall({
    taskId,
    serverId: "todoist",
    toolName: "addTask",
    arguments: { content: "Buy eggs" },
  });

  assert.equal(second.outcome, "approved");
  assert.equal(second.scope, "always");
  assert.equal(channel.privilegeRequests.length, 1);
});

test("orchestrator confirms persisted http token suitability and enables later proxy auto-approval", async () => {
  const persistentApprovalStore: PersistentApprovalStore = {
    isAlwaysAllowed: () => false,
    allowTool: async () => {},
    isResourceReadAlwaysAllowed: () => false,
    allowResourceRead: async () => {},
    isHttpTokenAlwaysAllowed: (tokenId, host) => tokenId === "vid2text" && host === "api.example.com",
    allowHttpToken: async () => {},
    isHostDirectoryAlwaysAllowed: () => false,
    allowHostDirectory: async () => {},
  };
  const { orchestrator, runner, channel, store } = createTestOrchestrator({
    persistentApprovalStore,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Transcribe a video.",
      taskName: "video-transcribe",
      taskLanguage: "English",
      taskPolicy: {
        autoApproveMcpServers: [],
        autoApproveHttpTokens: [],
      },
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-http-confirm",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Transcribe this video",
    rawText: "Transcribe this video",
    attachments: [],
  });

  const taskId = runner.launches[0]?.taskId;
  assert.ok(taskId);

  const toolCallPromise = orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "request_http_token",
    arguments: {
      tokenId: "vid2text",
      host: "api.example.com",
      reason: "Need the transcript API.",
    },
  });

  await waitFor(() => channel.privilegeRequests.length === 1);
  assert.equal(channel.privilegeRequests.length, 1);
  const request = channel.privilegeRequests[0]?.request;
  assert.equal(request?.kind, "http_token_use");
  assert.equal(request?.confirmsAutoApprovalForTask, true);

  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-http-confirm",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "approve",
    requestId: request?.requestId,
  });

  assert.deepEqual(await toolCallPromise, {
    isError: false,
    message: messages.httpTokenAllowedFromPersistentConfig("vid2text", "api.example.com"),
  });

  const session = store.getOrCreate("chat-http-confirm");
  assert.deepEqual(session.activeTask?.taskPolicy.autoApproveHttpTokens, ["vid2text"]);

  const authorizer = new HttpTokenAuthorizer(store, persistentApprovalStore);
  const proxyResult = authorizer.authorizeHttpTokenUse({
    taskId,
    tokenId: "vid2text",
    host: "api.example.com",
  });

  assert.equal(proxyResult.outcome, "approved");
  assert.equal(proxyResult.scope, "always");
});

test("orchestrator creates a hostfs grant for worker-session host directory approval", async () => {
  const hostfsCalls: Array<{ bundleId: string; taskId: string; path: string; level: string }> = [];
  const { orchestrator, runner, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect a host directory.",
      taskName: "hostfs-check",
      taskLanguage: "English",
    }),
    hostfsBroker: {
      registerBundle: () => {},
      revokeBundle: () => {},
      getBundleNamespace: () => null,
      requestDirectoryAccess: async (
        bundleId: string,
        taskId: string,
        path: string,
        level: HostDirectoryAccessLevel,
      ) => {
        hostfsCalls.push({ bundleId, taskId, path, level });
        return {
          ok: true,
          grantId: "grant-1",
          grantPath: `${hostGrantsPrefix}/grant-1`,
        };
      },
    } as unknown as HostfsBroker,
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-hostfs-once",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect this host directory",
    rawText: "Inspect this host directory",
    attachments: [],
  });

  const taskId = expectDefined(runner.launches[0], "Expected launch.").taskId;
  runner.handle.taskBundle = { bundleId: "bundle-1", hostfsVolumeName: "hostfs-volume-1" };

  const toolCallPromise = orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "request_host_directory_access",
    arguments: {
      path: "/tmp",
      level: "read_only",
    },
  });

  await new Promise<void>((resolve) => setImmediate(() => resolve()));

  const request = expectDefined(channel.privilegeRequests[0], "Expected privilege request.").request;
  assert.equal(request.kind, "host_directory_access");

  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-hostfs-once",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "approve_worker_session",
    requestId: request.requestId,
  });

  assert.deepEqual(hostfsCalls, [{
    bundleId: "bundle-1",
    taskId,
    path: "/tmp",
    level: "read_only",
  }]);
  assert.deepEqual(await toolCallPromise, {
    isError: false,
    message: `${messages.hostDirectoryAccessAllowedForWorkerSession("/tmp", "read_only")} Use the path: ${hostGrantsPrefix}/grant-1`,
  });
});

test("orchestrator sends mcp resource read privilege request to user when not pre-approved", async () => {
  const { orchestrator, runner, channel, store } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Read a resource.",
      taskName: "resource-read",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-resource-pending",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Read a resource",
    rawText: "Read a resource",
    attachments: [],
  });

  const taskId = runner.launches[0]?.taskId;
  assert.ok(taskId);

  const promise = orchestrator.authorizeMcpResourceRead({
    taskId,
    serverId: "todoist",
    uri: "test://resource",
  });

  await new Promise<void>((resolve) => setImmediate(() => resolve()));

  assert.equal(channel.privilegeRequests.length, 1);
  const request = channel.privilegeRequests[0]?.request;
  assert.equal(request?.kind, "mcp_resource_read");
  assert.equal(request?.serverId, "todoist");
  assert.equal(request?.uri, "test://resource");

  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-resource-pending",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "approve_worker_session",
    requestId: request?.requestId,
  });

  const result = await promise;
  assert.equal(result.outcome, "approved");
  assert.equal(result.scope, "worker_session");

  const session = store.getOrCreate("chat-resource-pending");
  assert.ok(session.activeTask?.approvedMcpResourceReads.some((entry) => entry.serverId === "todoist" && entry.uri === "test://resource"));
});

test("job-scoped persistent approvals apply only to later executions of the same job", async () => {
  const allowedServers = new Map<string, Set<string>>();
  const persistentApprovalStore: PersistentApprovalStore = {
    isAlwaysAllowed: (serverId, toolName) => allowedServers.get(serverId)?.has(toolName) ?? false,
    allowTool: async (serverId, toolName) => {
      const tools = allowedServers.get(serverId) ?? new Set<string>();
      tools.add(toolName);
      allowedServers.set(serverId, tools);
    },
    isResourceReadAlwaysAllowed: () => false,
    allowResourceRead: async () => {},
    isHttpTokenAlwaysAllowed: () => false,
    allowHttpToken: async () => {},
    isHostDirectoryAlwaysAllowed: () => false,
    allowHostDirectory: async () => {},
  };
  const { orchestrator, channel, taskLifecycle, runner } = createTestOrchestrator({
    persistentApprovalStore,
    jobApprovalStore: new InMemoryJobApprovalStore(),
    mainAgent: new StubMainAgent({
      action: "reply",
      replyText: "idle",
    }),
  });

  const job: JobDefinition = {
    id: "daily-cleanup",
    name: "Daily cleanup",
    enabled: true,
    schedule: { kind: "cron", expression: "0 9 * * *" },
    skillId: "cleanup-skill",
  };

  const firstTaskId = await taskLifecycle.launchJobTask(job, "chat-job-approval", null);
  const firstApproval = orchestrator.authorizeMcpToolCall({
    taskId: firstTaskId,
    serverId: "todoist",
    toolName: "list_projects",
    arguments: {},
  });
  await waitFor(() => channel.privilegeRequests.length === 1);

  const firstRequestId = channel.privilegeRequests[0]?.request.requestId;
  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-job-approval",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "approve_always",
    requestId: firstRequestId,
  });
  assert.equal((await firstApproval).scope, "always");

  await runner.emit({ type: "task_done" }, firstTaskId);

  const secondTaskId = await taskLifecycle.launchJobTask(job, "chat-job-approval", null);
  const secondApproval = orchestrator.authorizeMcpToolCall({
    taskId: secondTaskId,
    serverId: "todoist",
    toolName: "list_projects",
    arguments: {},
  });
  assert.equal((await secondApproval).scope, "always");
  assert.equal(channel.privilegeRequests.length, 1);

  await runner.emit({ type: "task_done" }, secondTaskId);

  const thirdTaskId = await taskLifecycle.launchJobTask({ ...job, id: "weekly-cleanup", name: "Weekly cleanup" }, "chat-job-approval", null);
  const thirdApproval = orchestrator.authorizeMcpToolCall({
    taskId: thirdTaskId,
    serverId: "todoist",
    toolName: "list_projects",
    arguments: {},
  });
  await waitFor(() => channel.privilegeRequests.length >= 2);

  assert.equal(channel.privilegeRequests.length, 2);
  const thirdRequest = channel.privilegeRequests[1]?.request;
  assert.equal(thirdRequest?.kind, "mcp_tool_call");
  assert.equal(thirdRequest?.confirmsAutoApprovalForTask, true);
  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-job-approval",
    messageId: "3",
    timestamp: "2026-04-01T00:00:30.000Z",
    decision: "deny",
    requestId: thirdRequest?.requestId,
  });
  assert.equal((await thirdApproval).outcome, "denied");
});
