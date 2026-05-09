import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { ChannelAdapter } from "./channel/channel-adapter.js";
import type { MainAgentController } from "./agent/main-agent-controller.js";
import { messages } from "./messages.js";
import type { PrivilegeBroker } from "./privilege/privilege-broker.js";
import type { PersistentApprovalStore } from "./privilege/persistent-approval-store.js";
import { createNoopPersistentApprovalStore } from "./privilege/persistent-approval-store.js";
import { createNoopTaskBundleAssignmentRegistry } from "./sandbox/task-bundle-assignment-registry.js";
import type { HostfsBroker } from "./hostfs/hostfs-broker.js";
import { createNoopHostfsBroker } from "./hostfs/hostfs-broker.js";
import type { HostDirectoryAccessLevel } from "./hostfs/path-policy.js";
import { HttpTokenAuthorizer } from "./http/token-authorizer.js";
import { hostGrantsPrefix } from "./paths.js";
import { sharedWorkspaceMountPath } from "./shared-workspace.js";
import type { SandboxHandle, SandboxRunner, LaunchTaskRequest } from "./sandbox/sandbox-runner.js";
import type { TaskInputPayload } from "./types.js";
import { SandyOrchestrator } from "./orchestrator.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";
import { TaskRegistry } from "./task-registry.js";
import type {
  ChannelFormatting,
  DecideContext,
  MainAgentDecision,
  MessageAttachment,
  PrivilegeRequest,
  PrivilegeResolutionResult,
  SavedAttachment,
  SubAgentEvent,
} from "./types.js";
import type { SupportedPrivilegeRequest } from "./privilege/privilege-broker.js";

const testFormatting: ChannelFormatting = {
  channelId: "telegram",
  markup: "telegram_html",
  allowedTags: ["b", "i", "code", "pre"],
  instructions: "Use simple Telegram HTML.",
};

function expectDefined<T>(value: T | null | undefined, message: string): NonNullable<T> {
  assert.notEqual(value, undefined, message);
  assert.notEqual(value, null, message);
  return value as NonNullable<T>;
}

class RecordingChannel implements ChannelAdapter {
  public readonly sentTexts: Array<{ chatId: string; text: string }> = [];
  public readonly taskUpdates: Array<{ chatId: string; text: string }> = [];
  public readonly sentFiles: Array<{ chatId: string; filePath: string; caption?: string }> = [];
  public readonly privilegeRequests: Array<{ chatId: string; request: PrivilegeRequest }> = [];
  public readonly shareDeletionRequests: Array<{ chatId: string; requestId: string; taskName: string; summary: string }> = [];
  public readonly savedAttachments: Array<{ chatId: string; attachments: MessageAttachment[]; targetDirectory: string }> = [];
  public sendFileError: Error | null = null;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getFormatting(): ChannelFormatting {
    return testFormatting;
  }

  async saveAttachments(chatId: string, attachments: MessageAttachment[], targetDirectory: string): Promise<SavedAttachment[]> {
    this.savedAttachments.push({ chatId, attachments, targetDirectory });
    return attachments.map((attachment, index) => ({
      attachmentId: attachment.attachmentId,
      kind: attachment.kind,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      hostPath: resolve(targetDirectory, `${index + 1}-${attachment.fileName}`),
    }));
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    if (this.sendFileError) {
      throw this.sendFileError;
    }
    this.sentFiles.push({ chatId, filePath, caption });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
  }

  async sendTaskUpdate(chatId: string, text: string): Promise<void> {
    this.taskUpdates.push({ chatId, text });
  }

  async sendReportableText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
  }

  async sendPrivilegeRequest(chatId: string, request: PrivilegeRequest): Promise<void> {
    this.privilegeRequests.push({ chatId, request });
  }

  async sendShareDeletionRequest(chatId: string, requestId: string, taskName: string, summary: string): Promise<void> {
    this.shareDeletionRequests.push({ chatId, requestId, taskName, summary });
  }
}

class StubMainAgent implements MainAgentController {
  public readonly contexts: DecideContext[] = [];

  constructor(private readonly decision: MainAgentDecision) {}

  async decide(context: DecideContext): Promise<MainAgentDecision> {
    this.contexts.push(context);
    return this.decision;
  }
}

class SequenceMainAgent implements MainAgentController {
  private index = 0;
  public readonly contexts: DecideContext[] = [];

  constructor(private readonly decisions: MainAgentDecision[]) {}

  async decide(context: DecideContext): Promise<MainAgentDecision> {
    this.contexts.push(context);
    const decision = this.decisions[this.index] ?? this.decisions.at(-1);
    if (!decision) {
      throw new Error("No main-agent decision configured.");
    }
    this.index += 1;
    return decision;
  }
}

function contextTexts(context: DecideContext): string[] {
  return context.newVisibleEntries.map((entry) => entry.text ?? "");
}

class FakeSandboxHandle implements SandboxHandle {
  public readonly userMessages: TaskInputPayload[] = [];
  public readonly privilegeResults: PrivilegeResolutionResult[] = [];
  public markFinishedCalls = 0;
  public closeCalls = 0;
  public readonly cancellations: string[] = [];

  async sendUserMessage(input: TaskInputPayload): Promise<void> {
    this.userMessages.push(input);
  }

  async resolvePrivilege(result: PrivilegeResolutionResult): Promise<void> {
    this.privilegeResults.push(result);
  }

  async markFinished(): Promise<void> {
    this.markFinishedCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  async cancel(reason: string): Promise<void> {
    this.cancellations.push(reason);
  }
}

class FakeSandboxRunner implements SandboxRunner {
  public readonly launches: LaunchTaskRequest[] = [];
  public readonly handle = new FakeSandboxHandle();
  public onEvent: ((event: SubAgentEvent) => Promise<void>) | null = null;
  public readonly deletedTaskShares: string[] = [];
  public shareInspections = new Map<string, { isEmpty: boolean; summary: string | null }>();

  async launchTask(request: LaunchTaskRequest, onEvent: (event: SubAgentEvent) => Promise<void>): Promise<SandboxHandle> {
    this.launches.push(request);
    this.onEvent = onEvent;
    return this.handle;
  }

  async emit(event: SubAgentEvent): Promise<void> {
    if (!this.onEvent) {
      throw new Error("No task is active.");
    }
    await this.onEvent(event);
  }

  async inspectTaskShare(taskId: string): Promise<{ isEmpty: boolean; summary: string | null }> {
    return this.shareInspections.get(taskId) ?? { isEmpty: true, summary: null };
  }

  async deleteTaskShare(taskId: string): Promise<void> {
    this.deletedTaskShares.push(taskId);
  }

  getTaskSharePath(taskId: string): string {
    return `/tmp/${taskId}`;
  }
}

class FakePrivilegeBroker implements PrivilegeBroker {
  public readonly appliedRequests: Array<{ request: SupportedPrivilegeRequest; taskId: string; taskSharePath: string }> = [];

  async apply(request: SupportedPrivilegeRequest, context: { taskId: string; taskSharePath: string }): Promise<{ outcome: "approved"; message: string }> {
    this.appliedRequests.push({ request, taskId: context.taskId, taskSharePath: context.taskSharePath });
    return {
      outcome: "approved",
      message: `Applied ${request.type}.`,
    };
  }
}


test("orchestrator accepts active-task output without storing host-side history", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const mainAgent = new StubMainAgent({
    action: "launch_task",
    taskBrief: "Investigate the issue.",
    taskName: "issue-investigation",
  taskLanguage: "English",
  });
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent,
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-2",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Investigate the issue",
    rawText: "Investigate the issue",
    attachments: [],
  });

  await runner.emit({
    type: "assistant_output",
    text: "Need clarification about the target branch.",
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-2",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    text: "Use the main branch.",
    rawText: "Use the main branch.",
    attachments: [],
  });

  const session = store.getOrCreate("chat-2");
  assert.equal(session.pendingTaskSummary, null);
  assert.match(runner.handle.userMessages[0]?.text ?? "", /Use the main branch\./);
  assert.equal(mainAgent.contexts.length, 1);
});

test("orchestrator stages attached files into the task share before launching the worker", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const mainAgent = new StubMainAgent({
    action: "launch_task",
    taskBrief: "Analyze the uploaded file.",
    taskName: "file-analysis",
  taskLanguage: "English",
  });
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent,
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-file-launch",
    messageId: "message/1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Analyze this",
    rawText: "Analyze this",
    attachments: [{
      attachmentId: "doc-1",
      kind: "file",
      fileName: "input.csv",
      mimeType: "text/csv",
    }],
  });

  assert.equal(channel.savedAttachments.length, 1);
  assert.match(expectDefined(channel.savedAttachments[0], "Expected saved attachment batch.").targetDirectory, /inbox\/message_1$/);
  const launch = expectDefined(runner.launches[0], "Expected launch.");
  assert.match(launch.taskBrief, /Files attached by the user are already available/);
  assert.match(launch.taskBrief, /\/workspace\/share\/inbox\/message_1\/1-input\.csv/);
  assert.deepEqual(contextTexts(expectDefined(mainAgent.contexts[0], "Expected main-agent context.")), ["Analyze this\n\nAttached files:\n- input.csv"]);
});

test("orchestrator stages attached files into the active task share and notifies the worker", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Wait for files.",
      taskName: "file-wait",
    taskLanguage: "English",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-file-active",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Start waiting",
    rawText: "Start waiting",
    attachments: [],
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-file-active",
    messageId: "message/2",
    timestamp: "2026-04-01T00:00:10.000Z",
    text: "",
    rawText: "",
    attachments: [{
      attachmentId: "doc-2",
      kind: "file",
      fileName: "followup.txt",
    }],
  });

  assert.equal(channel.savedAttachments.length, 1);
  assert.match(runner.handle.userMessages[0]?.text ?? "", /The user attached additional files to the shared workspace/);
  assert.match(runner.handle.userMessages[0]?.text ?? "", /\/workspace\/share\/inbox\/message_2\/1-followup\.txt/);
});

test("orchestrator applies supported privilege requests deterministically and outside the main agent path", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const privilegeBroker = new FakePrivilegeBroker();
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Need a host file copied into the share.",
      taskName: "copy-in",
    taskLanguage: "English",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker,
    taskRegistry: new TaskRegistry(),
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
    taskSharePath: `/tmp/${taskId}`,
  }]);
  assert.deepEqual(await toolCallPromise, {
    isError: false,
    message: "Applied copy_into_share.",
  });
  assert.ok(requestId);
});


test("orchestrator keeps completed-task summary pending until the user sends another message", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the environment.",
      taskName: "env-inspection",
    taskLanguage: "English",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-4",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the environment",
    rawText: "Inspect the environment",
    attachments: [],
  });

  await runner.emit({
    type: "assistant_output",
    text: "The environment has 8 CPUs.",
  });

  await runner.emit({
    type: "task_summary",
    summary: [
      "Summary: Inspected the environment and found 8 CPUs.",
      "Artifacts: none",
      "Open questions: none",
    ].join("\n"),
  });

  await runner.emit({
    type: "task_done",
  });

  const session = store.getOrCreate("chat-4");
  assert.equal(session.activeTask, null);
  assert.deepEqual(session.pendingTaskSummary, {
    taskName: "env-inspection",
    summary: [
      "Summary: Inspected the environment and found 8 CPUs.",
      "Artifacts: none",
      "Open questions: none",
    ].join("\n"),
  });
});

test("orchestrator sends worker-requested shared files back through the channel", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Generate a file.",
      taskName: "file-out",
    taskLanguage: "English",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
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
    filePath: `/tmp/${expectDefined(runner.launches[0], "Expected launch.").taskId}/results/output.txt`,
    caption: "Generated output",
  }]);
});

test("orchestrator closes the sandbox handle on normal task completion", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const mainAgent = new StubMainAgent({
    action: "launch_task",
    taskBrief: "Inspect the environment.",
    taskName: "env-inspection",
  taskLanguage: "English",
  });
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent,
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-close",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the environment",
    rawText: "Inspect the environment",
    attachments: [],
  });

  await runner.emit({
    type: "task_done",
  });

  assert.equal(runner.handle.closeCalls, 1);
});

test("orchestrator asks the worker to finalize when the user marks the task as finished", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the environment.",
      taskName: "env-inspection",
    taskLanguage: "English",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-mark-finished",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the environment",
    rawText: "Inspect the environment",
    attachments: [],
  });

  await orchestrator.handleChatEvent({
    kind: "mark_finished_request",
    chatId: "chat-mark-finished",
    messageId: "callback:1",
    timestamp: "2026-04-01T00:00:05.000Z",
  });

  assert.equal(runner.handle.markFinishedCalls, 1);

  await runner.emit({
    type: "task_summary",
    summary: [
      "Summary: Finished based on the visible progress.",
      "Artifacts: none",
      "Open questions: none",
    ].join("\n"),
  });

  await runner.emit({
    type: "task_done",
  });

  const session = store.getOrCreate("chat-mark-finished");
  assert.equal(session.activeTask, null);
  assert.deepEqual(session.pendingTaskSummary, {
    taskName: "env-inspection",
    summary: [
      "Summary: Finished based on the visible progress.",
      "Artifacts: none",
      "Open questions: none",
    ].join("\n"),
  });
});

test("orchestrator uses the task name in task_done completion messages", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the environment.",
      taskName: "env-inspection",
    taskLanguage: "English",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-task-name",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the environment",
    rawText: "Inspect the environment",
    attachments: [],
  });

  await runner.emit({
    type: "task_done",
  });

  assert.equal(
    channel.sentTexts.at(-1)?.text,
    messages.taskSummaryReady(
      "env-inspection",
      [
        'The task ended without a worker-provided handoff summary. Task name: env-inspection. Brief: Inspect the environment.',
        "Artifacts: unknown",
        "Open questions: Review the visible task updates above if more detail is needed.",
      ].join("\n"),
    ),
  );
});

test("orchestrator releases completed-task output only when the user continues normally", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const mainAgent = new SequenceMainAgent([
    {
      action: "launch_task",
      taskBrief: "Inspect the environment.",
      taskName: "env-inspection",
    taskLanguage: "English",
    },
    {
      action: "reply",
      replyText: "Continuing with the next step.",
    },
  ]);
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent,
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-5",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the environment",
    rawText: "Inspect the environment",
    attachments: [],
  });

  await runner.emit({
    type: "assistant_output",
    text: "The environment has 8 CPUs.",
  });

  await runner.emit({
    type: "task_summary",
    summary: [
      "Summary: Inspected the environment and found 8 CPUs.",
      "Artifacts: none",
      "Open questions: none",
    ].join("\n"),
  });

  await runner.emit({
    type: "task_done",
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-5",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    text: "thanks",
    rawText: "thanks",
    attachments: [],
  });

  const session = store.getOrCreate("chat-5");
  assert.equal(session.pendingTaskSummary, null);
  const followUpContext = expectDefined(mainAgent.contexts[1], "Expected follow-up context.");
  assert.equal(contextTexts(followUpContext).at(-1), "thanks");
  assert.match(contextTexts(followUpContext)[0] ?? "", /found 8 CPUs/);
});

test("orchestrator discards completed-task output when the user sends a danger report next", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the filesystem.",
      taskName: "fs-inspect",
    taskLanguage: "English",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-5",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the filesystem",
    rawText: "Inspect the filesystem",
    attachments: [],
  });

  await runner.emit({
    type: "assistant_output",
    text: "Potentially unsafe filesystem output",
  });

  await runner.emit({
    type: "task_summary",
    summary: [
      "Summary: Inspected the filesystem.",
      "Artifacts: none",
      "Open questions: none",
    ].join("\n"),
  });

  await runner.emit({
    type: "task_done",
  });

  await orchestrator.handleChatEvent({
    kind: "danger_report",
    chatId: "chat-5",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
  });

  const session = store.getOrCreate("chat-5");
  assert.equal(session.activeTask, null);
  assert.equal(session.pendingTaskSummary, null);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.discardedPendingOutput());
});

test("orchestrator keeps final_result output pending until the user continues normally", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const mainAgent = new SequenceMainAgent([
    {
      action: "launch_task",
      taskBrief: "Inspect the environment.",
      taskName: "env-inspection",
    taskLanguage: "English",
    },
    {
      action: "reply",
      replyText: "Continuing with the next step.",
    },
  ]);
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent,
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-6",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the environment",
    rawText: "Inspect the environment",
    attachments: [],
  });

  await runner.emit({
    type: "final_result",
    text: "The environment has 8 CPUs.",
  });

  let session = store.getOrCreate("chat-6");
  assert.equal(session.activeTask, null);
  assert.deepEqual(session.pendingTaskSummary, {
    taskName: "env-inspection",
    summary: [
      "Summary: The environment has 8 CPUs.",
      "Artifacts: none",
      "Open questions: none",
    ].join("\n"),
  });
  assert.equal(
    channel.sentTexts.at(-1)?.text,
    messages.taskSummaryReady(
      "env-inspection",
      [
        "Summary: The environment has 8 CPUs.",
        "Artifacts: none",
        "Open questions: none",
      ].join("\n"),
    ),
  );

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-6",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    text: "thanks",
    rawText: "thanks",
    attachments: [],
  });

  session = store.getOrCreate("chat-6");
  assert.equal(session.pendingTaskSummary, null);
  const followUpContext = expectDefined(mainAgent.contexts[1], "Expected follow-up context.");
  assert.equal(contextTexts(followUpContext).at(-1), "thanks");
  assert.match(contextTexts(followUpContext)[0] ?? "", /The environment has 8 CPUs/);
});

test("orchestrator marks worker disconnects as task failure and clears the task", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the filesystem.",
      taskName: "fs-inspect",
    taskLanguage: "English",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-7",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the filesystem",
    rawText: "Inspect the filesystem",
    attachments: [],
  });

  await runner.emit({
    type: "worker_disconnected",
    message: "Sub-agent control channel disconnected unexpectedly.",
  });

  const session = store.getOrCreate("chat-7");
  assert.equal(session.activeTask, null);
  assert.equal(channel.sentTexts.at(-1)?.text, "Sub-agent control channel disconnected unexpectedly.");
});

test("orchestrator fails the active task if channel file delivery fails", async () => {
  const channel = new RecordingChannel();
  channel.sendFileError = new Error("Telegram upload failed.");
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Prepare a file.",
      taskName: "file-task",
    taskLanguage: "English",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
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

test("orchestrator reports top-level chat event failures back to the user", async () => {
  const channel = new RecordingChannel();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent: {
      async decide(): Promise<MainAgentDecision> {
        throw new Error("You've hit your usage limit.");
      },
    },
    sandboxRunner: new FakeSandboxRunner(),
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-top-level-error",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Do the thing",
    rawText: "Do the thing",
    attachments: [],
  });

  assert.equal(
    channel.sentTexts.at(-1)?.text,
    messages.handlerFailed("You've hit your usage limit."),
  );
  assert.equal(store.getOrCreate("chat-top-level-error").activeTask, null);
});

test("orchestrator prompts before deleting a non-empty shared workspace", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the filesystem.",
      taskName: "fs-inspect",
    taskLanguage: "English",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-8",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the filesystem",
    rawText: "Inspect the filesystem",
    attachments: [],
  });

  const taskId = runner.launches[0]?.taskId;
  assert.ok(taskId);
  runner.shareInspections.set(taskId, {
    isEmpty: false,
    summary: "report.txt\nlogs/\n  latest.log",
  });

  await runner.emit({
    type: "task_done",
  });

  const session = store.getOrCreate("chat-8");
  assert.equal(session.activeTask, null);
  assert.equal(channel.shareDeletionRequests.length, 1);
  assert.equal(channel.shareDeletionRequests[0]?.taskName, "fs-inspect");
  assert.equal(runner.deletedTaskShares.length, 0);
});

test("orchestrator deletes or preserves a finished task share based on user confirmation", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent: new SequenceMainAgent([
      {
        action: "launch_task",
        taskBrief: "Inspect the filesystem.",
        taskName: "fs-inspect",
      taskLanguage: "English",
      },
      {
        action: "launch_task",
        taskBrief: "Inspect another filesystem.",
        taskName: "fs-inspect-2",
      taskLanguage: "English",
      },
    ]),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-9",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the filesystem",
    rawText: "Inspect the filesystem",
    attachments: [],
  });

  const firstTaskId = runner.launches[0]?.taskId;
  assert.ok(firstTaskId);
  runner.shareInspections.set(firstTaskId, {
    isEmpty: false,
    summary: "report.txt",
  });

  await runner.emit({
    type: "task_done",
  });

  const deleteRequestId = channel.shareDeletionRequests[0]?.requestId;
  assert.ok(deleteRequestId);
  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-9",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "approve",
    requestId: deleteRequestId,
  });

  assert.deepEqual(runner.deletedTaskShares, [firstTaskId]);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.shareDeleted("fs-inspect"));

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-9",
    messageId: "3",
    timestamp: "2026-04-01T00:00:20.000Z",
    text: "Inspect another filesystem",
    rawText: "Inspect another filesystem",
    attachments: [],
  });

  const secondTaskId = runner.launches[1]?.taskId;
  assert.ok(secondTaskId);
  runner.shareInspections.set(secondTaskId, {
    isEmpty: false,
    summary: "archive/\n  result.json",
  });

  await runner.emit({
    type: "task_done",
  });

  const preserveRequestId = channel.shareDeletionRequests[1]?.requestId;
  assert.ok(preserveRequestId);
  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-9",
    messageId: "4",
    timestamp: "2026-04-01T00:00:30.000Z",
    decision: "deny",
    requestId: preserveRequestId,
  });

  assert.deepEqual(runner.deletedTaskShares, [firstTaskId]);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.sharePreserved("fs-inspect-2"));
});

test("orchestrator blocks new idle input while shared workspace deletion is pending", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const mainAgent = new SequenceMainAgent([
    {
      action: "launch_task",
      taskBrief: "Inspect the filesystem.",
      taskName: "fs-inspect",
    taskLanguage: "English",
    },
    {
      action: "reply",
      replyText: "This should not be reached yet.",
    },
  ]);
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent,
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-10",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the filesystem",
    rawText: "Inspect the filesystem",
    attachments: [],
  });

  const taskId = runner.launches[0]?.taskId;
  assert.ok(taskId);
  runner.shareInspections.set(taskId, {
    isEmpty: false,
    summary: "report.txt",
  });

  await runner.emit({
    type: "task_done",
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-10",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    text: "Do something else",
    rawText: "Do something else",
    attachments: [],
  });

  assert.equal(mainAgent.contexts.length, 1);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.shareDeletionStillPending());
});

test("orchestrator authorizes mcp resource reads from persistent config", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
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
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    channel,
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
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
    persistentApprovalStore,
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
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
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
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    channel,
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
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
    persistentApprovalStore,
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
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
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
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    channel,
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
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
    persistentApprovalStore,
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
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const taskRegistry = new TaskRegistry();
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
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    channel,
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
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry,
    persistentApprovalStore,
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

  const authorizer = new HttpTokenAuthorizer(taskRegistry, store, persistentApprovalStore);
  const proxyResult = await authorizer.authorizeHttpTokenUse({
    taskId,
    tokenId: "vid2text",
    host: "api.example.com",
  });

  assert.equal(proxyResult.outcome, "approved");
  assert.equal(proxyResult.scope, "always");
});

test("orchestrator creates a hostfs grant for worker-session host directory approval", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const taskRegistry = new TaskRegistry();
  const hostfsCalls: Array<{ bundleId: string; taskId: string; path: string; level: string }> = [];
  let launchedTaskId: string | null = null;
  const orchestrator = new SandyOrchestrator({
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect a host directory.",
      taskName: "hostfs-check",
      taskLanguage: "English",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry,
    hostfsBroker: {
      registerBundle: () => {},
      revokeBundle: () => {},
      getBundleNamespace: () => null,
      getWebDAVUrlForBundle: () => "http://localhost:9876/bundles/bundle-1",
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
    taskBundleAssignmentRegistry: {
      get: (taskId: string) => taskId === launchedTaskId
        ? {bundleId: "bundle-1", hasHostfsVolume: true}
        : null,
    },
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
  launchedTaskId = taskId;

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
    message: messages.hostDirectoryAccessAllowedForWorkerSession("/tmp", "read_only"),
  });
});

test("orchestrator sends mcp resource read privilege request to user when not pre-approved", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    hostfsBroker: createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: createNoopTaskBundleAssignmentRegistry(),
    persistentApprovalStore: createNoopPersistentApprovalStore(),
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Read a resource.",
      taskName: "resource-read",
      taskLanguage: "English",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
    taskRegistry: new TaskRegistry(),
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
