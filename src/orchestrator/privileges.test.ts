import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HostfsBroker } from "../hostfs/hostfs-broker.js";
import type { HostDirectoryAccessLevel } from "../hostfs/path-policy.js";
import { HttpTokenAuthorizer } from "../http/token-authorizer.js";
import { messages } from "../messages.js";
import {
  createTestOrchestrator,
  expectDefined,
  FileCopySpy,
  InMemoryJobApprovalStore,
  RecordingChannel,
  StubMainAgent,
} from "./test-helpers.js";
import { hostGrantsPrefix } from "../paths.js";
import type { PersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import { sharedWorkspaceMountPath } from "../shared-workspace.js";
import type { JobDefinition } from "../jobs/job-validation.js";
import { ActiveTaskState } from "../types.js";

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
  const tmpRoot = resolve(import.meta.dirname, "../../tmp");
  await mkdir(tmpRoot, { recursive: true });
  const root = await mkdtemp(resolve(tmpRoot, "sandy-privileges-test-"));
  const sourcePath = resolve(root, "input.txt");
  await writeFile(sourcePath, "fixture contents");
  const fileCopySpy = new FileCopySpy();
  try {
    const { orchestrator, runner, channel } = createTestOrchestrator({
      mainAgent: new StubMainAgent({
        action: "launch_task",
        taskBrief: "Need a host file copied into the share.",
        taskName: "copy-in",
        taskLanguage: "English",
      }),
      fileCopySpy,
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
        sourcePath,
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
    assert.deepEqual(fileCopySpy.appliedRequests, [{
      request: {
        type: "copy_into_share",
        sourcePath,
        targetPath: `${sharedWorkspaceMountPath}/input.txt`,
        reason: "Need a local fixture file.",
      },
      taskId,
      taskSharePath: resolve(import.meta.dirname, "../../tmp", taskId),
    }]);
    assert.deepEqual(await toolCallPromise, {
      isError: false,
      message: `Copied ${sourcePath} into the shared workspace at ${sharedWorkspaceMountPath}/input.txt.`,
    });
    assert.ok(requestId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("approved skill mutation delegates execution through the worker tools handler", async () => {
  const { orchestrator, runner, channel, skillService } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Create a skill.",
      taskName: "skill-create",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-skill-create",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Create a skill",
    rawText: "Create a skill",
    attachments: [],
  });

  const taskId = expectDefined(runner.launches[0], "Expected launch.").taskId;
  const toolCallPromise = orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "create_skill",
    arguments: {
      skillId: "daily-report",
      name: "Daily report",
      description: "Generate a daily report.",
      body: "Run the report and summarize the results.",
    },
  });

  await waitFor(() => channel.privilegeRequests.length === 1);
  const requestId = channel.privilegeRequests[0]?.request.requestId;

  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-skill-create",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "approve",
    requestId,
  });

  assert.deepEqual(await toolCallPromise, {
    isError: false,
    message: messages.skillMutationApproved("create", "daily-report"),
  });
  assert.deepEqual(skillService.getSkills(), [
    {
      name: "Notify me when X",
      description: "Use this when the user wants Sandy to monitor a condition and notify them when it becomes true.",
    },
    {
      name: "Daily report",
      description: "Generate a daily report.",
    },
  ]);
});

test("request_interaction tool promotes a silent job task to interactive mode", async () => {
  const { orchestrator, taskLifecycle, store, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({ action: "reply", replyText: "ok" }),
  });

  const job: JobDefinition = {
    id: "job-request-interaction-tool",
    name: "Daily report",
    enabled: true,
    schedule: { kind: "one_shot", runAt: "2026-04-01T00:00:00.000Z" },
    skillId: "report",
  };
  const taskId = await taskLifecycle.launchJobTask(job, "chat-request-interaction-tool", null);

  // Before request_interaction, the job task is silent.
  const session = store.getOrCreate("chat-request-interaction-tool");
  const task = session.findTask(taskId)?.task;
  assert.ok(task);
  assert.equal(task.interactionState, "silent");

  const toolResult = await orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "request_interaction",
    arguments: { message: "I need the user to confirm the report format." },
  });

  assert.equal(toolResult.isError, false);
  assert.match(toolResult.message, /promoted to interactive mode/i);
  assert.equal(channel.taskUpdates.length, 2);
  assert.equal(channel.taskUpdates[0]?.text, messages.scheduledJobBecameInteractive("Scheduled job: Daily report", "Daily report"));
  assert.match(channel.taskUpdates[1]?.text ?? "", /needs your attention.*confirm the report format/);

  const updatedTask = session.findTask(taskId)?.task;
  assert.ok(updatedTask);
  assert.equal(updatedTask.interactionState, "interacting");
});

test("silent job privilege requests are preceded by task context when they make the task visible", async () => {
  const persistentApprovalStore: PersistentApprovalStore = {
    isAlwaysAllowed: (serverId, toolName) => serverId === "todoist" && toolName === "find-projects",
    allowTool: async () => {},
    isResourceReadAlwaysAllowed: () => false,
    allowResourceRead: async () => {},
    isHttpTokenAlwaysAllowed: () => false,
    allowHttpToken: async () => {},
    isHostDirectoryAlwaysAllowed: () => false,
    allowHostDirectory: async () => {},
  };
  const { orchestrator, taskLifecycle, channel } = createTestOrchestrator({
    persistentApprovalStore,
    mainAgent: new StubMainAgent({ action: "reply", replyText: "ok" }),
  });

  const job: JobDefinition = {
    id: "job-privilege-context",
    name: "Shopping sync",
    enabled: true,
    schedule: { kind: "one_shot", runAt: "2026-04-01T00:00:00.000Z" },
    skillId: "shopping-sync",
  };
  const taskId = await taskLifecycle.launchJobTask(job, "chat-privilege-context", null);

  const privilegePromise = orchestrator.authorizeMcpToolCall({
    taskId,
    serverId: "todoist",
    toolName: "find-projects",
    arguments: { searchText: "Alexa Shopping List", limit: 10 },
  });
  await waitFor(() => channel.privilegeRequests.length === 1);

  assert.deepEqual(channel.taskUpdates, [{
    chatId: "chat-privilege-context",
    text: messages.scheduledJobBecameInteractive("Scheduled job: Shopping sync", "Shopping sync"),
  }]);

  const requestId = channel.privilegeRequests[0]?.request.requestId;
  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-privilege-context",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "deny",
    requestId,
    reason: "Not needed for this job.",
  });
  const denied = await privilegePromise;
  assert.equal(denied.outcome, "denied");
  assert.match(denied.message, /Reason: Not needed for this job\./);
});

test("approved job mutation delegates execution through the worker tools handler", async () => {
  const { orchestrator, runner, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Create a job.",
      taskName: "job-create",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-job-create",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Create a job",
    rawText: "Create a job",
    attachments: [],
  });

  const definition: JobDefinition = {
    id: "daily-report",
    name: "Daily report",
    enabled: true,
    schedule: { kind: "cron", expression: "0 9 * * *" },
    skillId: "report-skill",
  };

  const taskId = expectDefined(runner.launches[0], "Expected launch.").taskId;
  const toolCallPromise = orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "create_job",
    arguments: { definition },
  });

  await waitFor(() => channel.privilegeRequests.length === 1);
  const requestId = channel.privilegeRequests[0]?.request.requestId;

  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-job-create",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "approve",
    requestId,
  });

  assert.deepEqual(await toolCallPromise, {
    isError: false,
    message: `${messages.jobMutationApproved("create", "daily-report")} Updated job daily-report.`,
  });

  const getJobResult = await orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "get_job",
    arguments: { jobId: "daily-report" },
  });
  assert.equal(getJobResult.isError, false);
  assert.deepEqual(JSON.parse(getJobResult.message), definition);
});

test("request_interaction tool is a no-op for user-launched tasks", async () => {
  const mainAgent = new StubMainAgent({
    action: "launch_task",
    taskBrief: "Test task.",
    taskName: "user-task",
    taskLanguage: "English",
  });
  const { orchestrator, runner, channel } = createTestOrchestrator({ mainAgent });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-user-interaction-tool",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Start a task",
    rawText: "Start a task",
    attachments: [],
  });

  const taskId = expectDefined(runner.launches[0], "Expected launch.").taskId;

  const toolResult = await orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "request_interaction",
    arguments: { message: "Should be a no-op." },
  });

  assert.equal(toolResult.isError, false);
  assert.match(toolResult.message, /already in interactive mode/i);
  // No task updates should be sent since the task is already interactive.
  assert.equal(channel.taskUpdates.length, 0);
});

test("request_interaction tool is a no-op for an already interactive job task", async () => {
  const { orchestrator, taskLifecycle, channel, runner } = createTestOrchestrator({
    mainAgent: new StubMainAgent({ action: "reply", replyText: "ok" }),
  });

  const job: JobDefinition = {
    id: "job-request-interaction-again",
    name: "Daily report",
    enabled: true,
    schedule: { kind: "one_shot", runAt: "2026-04-01T00:00:00.000Z" },
    skillId: "report",
  };
  const taskId = await taskLifecycle.launchJobTask(job, "chat-request-interaction-again", null);

  await orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "request_interaction",
    arguments: { message: "I need the user to confirm the report format." },
  });

  const toolResult = await orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "request_interaction",
    arguments: { message: "Still waiting." },
  });

  assert.equal(toolResult.isError, false);
  assert.match(toolResult.message, /already in interactive mode/i);
  assert.deepEqual(channel.taskUpdates, [
    {
      chatId: "chat-request-interaction-again",
      text: messages.scheduledJobBecameInteractive("Scheduled job: Daily report", "Daily report"),
    },
    {
      chatId: "chat-request-interaction-again",
      text: messages.jobRequestsInteraction(
        "Scheduled job: Daily report",
        "Daily report",
        "I need the user to confirm the report format.",
      ),
    },
  ]);
  assert.equal(runner.handles.get(taskId)?.interactiveNotices, 1);
});

test("request_interaction tool reports already waiting when a job task is blocked behind a user task", async () => {
  const { orchestrator, runner, taskLifecycle, channel, store } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Handle the user's request.",
      taskName: "user-task",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-request-interaction-waiting",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Do the first thing",
    rawText: "Do the first thing",
    attachments: [],
  });

  const job: JobDefinition = {
    id: "job-request-interaction-waiting",
    name: "Daily cleanup",
    enabled: true,
    schedule: { kind: "cron", expression: "0 9 * * *" },
    skillId: "cleanup-skill",
  };
  const taskId = await taskLifecycle.launchJobTask(job, "chat-request-interaction-waiting", null);

  const blockedInteraction = orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "request_interaction",
    arguments: { message: "Waiting on the user task." },
  });
  await Promise.resolve();

  const toolResult = await orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "request_interaction",
    arguments: { message: "Still waiting on the user task." },
  });

  assert.equal(toolResult.isError, false);
  assert.match(toolResult.message, /already waiting to become interactive/i);
  assert.equal(store.getOrCreate("chat-request-interaction-waiting").backgroundJobTasks[0]?.interactionState, "waitingToInteract");
  assert.equal(channel.taskUpdates.length, 0);

  const userTaskId = expectDefined(runner.launches[0], "Expected launch.").taskId;
  await runner.emit({ type: "task_done" }, userTaskId);
  await blockedInteraction;
  assert.equal(runner.handles.get(taskId)?.interactiveNotices, 1);
});

test("terminate_task marks a silent job task for completion", async () => {
  const { orchestrator, taskLifecycle, store, runner } = createTestOrchestrator({
    mainAgent: new StubMainAgent({ action: "reply", replyText: "ok" }),
  });

  const job: JobDefinition = {
    id: "job-terminate-task",
    name: "Daily cleanup",
    enabled: true,
    schedule: { kind: "one_shot", runAt: "2026-04-01T00:00:00.000Z" },
    skillId: "cleanup",
  };
  const taskId = await taskLifecycle.launchJobTask(job, "chat-terminate-task", null);

  const session = store.getOrCreate("chat-terminate-task");
  const task = session.findTask(taskId)?.task;
  assert.ok(task);
  assert.equal(task.interactionState, "silent");

  const handle = runner.handles.get(taskId);
  assert.ok(handle);
  assert.equal(handle.markFinishedCalls, 0);

  const toolResult = await orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "terminate_task",
    arguments: {},
  });

  assert.equal(toolResult.isError, false);
  assert.match(toolResult.message, /marked for completion/i);
  assert.equal(handle.markFinishedCalls, 1);
});

test("terminate_task returns an error for user-launched tasks", async () => {
  const mainAgent = new StubMainAgent({
    action: "launch_task",
    taskBrief: "Test task.",
    taskName: "user-task",
    taskLanguage: "English",
  });
  const { orchestrator, runner } = createTestOrchestrator({ mainAgent });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-terminate-user-task",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Start a task",
    rawText: "Start a task",
    attachments: [],
  });

  const taskId = expectDefined(runner.launches[0], "Expected launch.").taskId;
  const handle = runner.handles.get(taskId);
  assert.ok(handle);

  const toolResult = await orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "terminate_task",
    arguments: {},
  });

  assert.equal(toolResult.isError, true);
  assert.match(toolResult.message, /only available for scheduled job tasks/i);
  assert.equal(handle.markFinishedCalls, 0);
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
  assert.equal(session.visibleTask, null);
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
  assert.deepEqual(session.visibleTask?.taskPolicy.autoApproveMcpServers, ["todoist"]);

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
  assert.deepEqual(session.visibleTask?.taskPolicy.autoApproveHttpTokens, ["vid2text"]);

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
  assert.ok(session.visibleTask?.approvedMcpResourceReads.some((entry) => entry.serverId === "todoist" && entry.uri === "test://resource"));
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
    reason: "Wrong job scope.",
  });
  const thirdResult = await thirdApproval;
  assert.equal(thirdResult.outcome, "denied");
  assert.match(thirdResult.message, /Reason: Wrong job scope\./);
});

test("denial without an inline reason prompts for a reason and routes it back to the agent", async () => {
  const { orchestrator, runner, channel, store } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Add a Todoist task.",
      taskName: "todoist-deny-reason",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-deny-reason",
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
  await waitFor(() => channel.privilegeRequests.length === 1);
  const request = channel.privilegeRequests[0]?.request;

  // Deny without a reason: the orchestrator must ask for a reason before resolving.
  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-deny-reason",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "deny",
    requestId: request?.requestId,
  });

  await waitFor(() => channel.denialReasonPrompts.length === 1);
  assert.equal(channel.denialReasonPrompts[0]?.request.requestId, request?.requestId);
  const session = store.getOrCreate("chat-deny-reason");
  assert.equal(session.visibleTask?.status, "awaiting_denial_reason");

  // While awaiting a reason, free text is consumed as the reason rather than
  // forwarded to the agent, and a second approval/deny is rejected.
  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-deny-reason",
    messageId: "3",
    timestamp: "2026-04-01T00:00:11.000Z",
    decision: "approve",
    requestId: request?.requestId,
  });
  assert.match(channel.sentTexts.at(-1)?.text ?? "", /denial reason is still pending/i);

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-deny-reason",
    messageId: "4",
    timestamp: "2026-04-01T00:00:12.000Z",
    text: "Too risky for now",
    rawText: "Too risky for now",
    attachments: [],
  });

  const result = await promise;
  assert.equal(result.outcome, "denied");
  assert.equal(result.reason, "Too risky for now");
  assert.match(result.message, /Reason: Too risky for now/);
  assert.equal(session.visibleTask?.status, "running");
  assert.equal(session.visibleTask?.pendingPrivilegeRequest, null);
});

test("denial reason can be skipped and the agent still receives the canned denial", async () => {
  const { orchestrator, runner, channel, store } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Copy a file.",
      taskName: "file-copy-deny-skip",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-deny-skip",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Copy a file",
    rawText: "Copy a file",
    attachments: [],
  });

  const taskId = runner.launches[0]?.taskId;
  assert.ok(taskId);

  const toolCallPromise = orchestrator.executeNativeWorkerToolCall({
    taskId,
    toolName: "copy_into_share",
    arguments: {
      sourcePath: "/tmp/missing.txt",
      targetPath: `${sharedWorkspaceMountPath}/missing.txt`,
      reason: "Need the file.",
    },
  });

  await waitFor(() => channel.privilegeRequests.length === 1);
  const request = channel.privilegeRequests[0]?.request;

  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-deny-skip",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "deny",
    requestId: request?.requestId,
  });
  await waitFor(() => channel.denialReasonPrompts.length === 1);

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-deny-skip",
    messageId: "3",
    timestamp: "2026-04-01T00:00:11.000Z",
    text: "/skip",
    rawText: "/skip",
    attachments: [],
  });

  const result = await toolCallPromise;
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.message, /Reason:/);
  const session = store.getOrCreate("chat-deny-skip");
  assert.equal(session.visibleTask?.status, "running");
});

test("cancelling a task while awaiting a denial reason fails the pending privilege request", async () => {
  const { orchestrator, runner, channel, store } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Add a Todoist task.",
      taskName: "todoist-deny-cancel",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-deny-cancel",
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
  await waitFor(() => channel.privilegeRequests.length === 1);
  const request = channel.privilegeRequests[0]?.request;

  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-deny-cancel",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "deny",
    requestId: request?.requestId,
  });
  await waitFor(() => channel.denialReasonPrompts.length === 1);
  assert.equal(store.getOrCreate("chat-deny-cancel").visibleTask?.status, "awaiting_denial_reason");

  await orchestrator.handleChatEvent({
    kind: "cancel_request",
    chatId: "chat-deny-cancel",
    messageId: "3",
    timestamp: "2026-04-01T00:00:11.000Z",
  });

  const result = await promise;
  assert.equal(result.outcome, "failed");
  assert.equal(store.getOrCreate("chat-deny-cancel").visibleTask, null);
});

test("moveToState rejects invalid task state transitions", () => {
  const task = new ActiveTaskState({
    taskId: "task-1",
    taskName: "test",
    startedAt: new Date(0).toISOString(),
    taskPolicy: { autoApproveMcpServers: [], autoApproveHttpTokens: [] },
    origin: { kind: "launchedByUser" },
    interactionState: "interacting",
  });
  assert.equal(task.status, "running");
  task.moveToState("awaiting_privilege_decision");
  task.moveToState("awaiting_denial_reason");
  task.moveToState("running");
  task.moveToState("completed");
  assert.throws(() => task.moveToState("running"), /Invalid task state transition: completed -> running/);
});

test("task status field is not directly assignable", () => {
  const task = new ActiveTaskState({
    taskId: "task-1",
    taskName: "test",
    startedAt: new Date(0).toISOString(),
    taskPolicy: { autoApproveMcpServers: [], autoApproveHttpTokens: [] },
    origin: { kind: "launchedByUser" },
    interactionState: "interacting",
  });
  // The status getter has no setter, so direct assignment is both a type error
  // (suppressed below) and a runtime TypeError. The backing field is private,
  // so moveToState is the only way to mutate status.
  assert.throws(() => {
    // @ts-expect-error -- status is private and only mutable via moveToState.
    task.status = "failed";
  }, /readonly property|only a getter|Cannot set property status/);
  assert.equal(task.status, "running");
});
