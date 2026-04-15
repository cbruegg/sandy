import { test } from "bun:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { ChannelAdapter } from "./channel/channel-adapter.js";
import type { MainAgentController } from "./agent/main-agent-controller.js";
import { messages } from "./messages.js";
import type { PrivilegeBroker } from "./privilege/privilege-broker.js";
import type { SandboxHandle, SandboxRunner, LaunchTaskRequest } from "./sandbox/sandbox-runner.js";
import { SandyOrchestrator } from "./orchestrator.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";
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
  public readonly userMessages: string[] = [];
  public readonly privilegeResults: PrivilegeResolutionResult[] = [];
  public markFinishedCalls = 0;
  public closeCalls = 0;
  public readonly cancellations: string[] = [];

  async sendUserMessage(text: string): Promise<void> {
    this.userMessages.push(text);
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

test("orchestrator launches a task and discards pending output on danger report", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const mainAgent = new StubMainAgent({
    action: "launch_task",
    taskBrief: "Inspect the repository.",
    taskName: "repo-inspect",
  });
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent,
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-1",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the repository",
    rawText: "Inspect the repository",
    attachments: [],
  });

  await runner.emit({
    type: "assistant_output",
    text: "Potentially dangerous hidden output",
  });

  await orchestrator.handleChatEvent({
    kind: "danger_report",
    chatId: "chat-1",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
  });

  assert.equal(runner.handle.cancellations.length, 1);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.taskTerminatedAndDiscarded("repo-inspect"));
  assert.deepEqual(runner.launches[0]?.channelFormatting, testFormatting);

  const session = store.getOrCreate("chat-1");
  assert.equal(session.activeTask, null);
  assert.equal(session.pendingTaskSummary, null);
  const firstContext = expectDefined(mainAgent.contexts[0], "Expected main-agent context.");
  assert.deepEqual(contextTexts(firstContext), ["Inspect the repository"]);
  assert.deepEqual(firstContext.channelFormatting, testFormatting);
});

test("orchestrator accepts active-task output without storing host-side history", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const mainAgent = new StubMainAgent({
    action: "launch_task",
    taskBrief: "Investigate the issue.",
    taskName: "issue-investigation",
  });
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent,
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
    kind: "user_text",
    chatId: "chat-2",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    text: "Use the main branch.",
    rawText: "Use the main branch.",
    attachments: [],
  });

  const session = store.getOrCreate("chat-2");
  assert.equal(session.pendingTaskSummary, null);
  assert.match(runner.handle.userMessages[0] ?? "", /Use the main branch\./);
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
  });
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent,
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Wait for files.",
      taskName: "file-wait",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-file-active",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Start waiting",
    rawText: "Start waiting",
    attachments: [],
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
  assert.match(runner.handle.userMessages[0] ?? "", /The user attached additional files to the shared workspace/);
  assert.match(runner.handle.userMessages[0] ?? "", /\/workspace\/share\/inbox\/message_2\/1-followup\.txt/);
});

test("orchestrator applies supported privilege requests deterministically and outside the main agent path", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const privilegeBroker = new FakePrivilegeBroker();
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Need a host file copied into the share.",
      taskName: "copy-in",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker,
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-3",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Copy a host file into the shared workspace",
    rawText: "Copy a host file into the shared workspace",
    attachments: [],
  });

  await runner.emit({
    type: "tool_call",
    call: {
      type: "copy_into_share",
      sourcePath: "/Users/test/input.txt",
      targetPath: "/workspace/share/input.txt",
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
      targetPath: "/workspace/share/input.txt",
      reason: "Need a local fixture file.",
    },
    taskId: expectDefined(runner.launches[0], "Expected launch.").taskId,
    taskSharePath: `/tmp/${expectDefined(runner.launches[0], "Expected launch.").taskId}`,
  }]);
  assert.deepEqual(runner.handle.privilegeResults, [{
    requestId,
    outcome: "approved",
    message: "Applied copy_into_share.",
  }]);
  assert.ok(requestId);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.privilegeApproved(requestId, "Applied copy_into_share."));
});

test("orchestrator terminates the task when the user reports a pending privilege request as dangerous", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Need a host file copied into the share.",
      taskName: "copy-in",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-danger-privilege",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Copy a host file into the shared workspace",
    rawText: "Copy a host file into the shared workspace",
    attachments: [],
  });

  await runner.emit({
    type: "tool_call",
    call: {
      type: "copy_into_share",
      sourcePath: "/Users/test/input.txt",
      targetPath: "/workspace/share/input.txt",
      reason: "Need a local fixture file.",
    },
  });

  await orchestrator.handleChatEvent({
    kind: "danger_report",
    chatId: "chat-danger-privilege",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
  });

  assert.equal(runner.handle.cancellations.length, 1);
  assert.equal(
    channel.sentTexts.at(-1)?.text,
    messages.taskTerminatedAfterDangerousPrivilegeRequest("copy-in"),
  );
});

test("orchestrator keeps completed-task summary pending until the user sends another message", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the environment.",
      taskName: "env-inspection",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
      "Outcome: completed",
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
      "Outcome: completed",
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
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Generate a file.",
      taskName: "file-out",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-file-out",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Generate a file",
    rawText: "Generate a file",
    attachments: [],
  });

  await runner.emit({
    type: "tool_call",
    call: {
      type: "send_file_to_channel",
      path: "/workspace/share/results/output.txt",
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
  });
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent,
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the environment.",
      taskName: "env-inspection",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
      "Outcome: completed",
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
      "Outcome: completed",
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
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the environment.",
      taskName: "env-inspection",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
        "Outcome: completed",
        'Summary: The task ended without a worker-provided handoff summary. Task name: env-inspection. Brief: Inspect the environment.',
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
    },
    {
      action: "reply",
      replyText: "Continuing with the next step.",
    },
  ]);
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent,
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
      "Outcome: completed",
      "Summary: Inspected the environment and found 8 CPUs.",
      "Artifacts: none",
      "Open questions: none",
    ].join("\n"),
  });

  await runner.emit({
    type: "task_done",
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
  assert.match(contextTexts(followUpContext)[0] ?? "", /Outcome: completed/);
  assert.match(contextTexts(followUpContext)[0] ?? "", /found 8 CPUs/);
});

test("orchestrator discards completed-task output when the user sends a danger report next", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the filesystem.",
      taskName: "fs-inspect",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
      "Outcome: completed",
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
    },
    {
      action: "reply",
      replyText: "Continuing with the next step.",
    },
  ]);
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent,
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
      "Outcome: completed",
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
        "Outcome: completed",
        "Summary: The environment has 8 CPUs.",
        "Artifacts: none",
        "Open questions: none",
      ].join("\n"),
    ),
  );

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
  assert.match(contextTexts(followUpContext)[0] ?? "", /Outcome: completed/);
  assert.match(contextTexts(followUpContext)[0] ?? "", /The environment has 8 CPUs/);
});

test("orchestrator marks worker disconnects as task failure and clears the task", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the filesystem.",
      taskName: "fs-inspect",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Prepare a file.",
      taskName: "file-task",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-file-failure",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Prepare a file",
    rawText: "Prepare a file",
    attachments: [],
  });

  await runner.emit({
    type: "tool_call",
    call: {
      type: "send_file_to_channel",
      path: "/workspace/share/result.txt",
      caption: "Result",
    },
  });

  const session = store.getOrCreate("chat-file-failure");
  assert.equal(session.activeTask, null);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.taskFailed("Telegram upload failed."));
  assert.equal(runner.handle.closeCalls, 1);
});

test("orchestrator reports top-level chat event failures back to the user", async () => {
  const channel = new RecordingChannel();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent: {
      async decide(): Promise<MainAgentDecision> {
        throw new Error("You've hit your usage limit.");
      },
    },
    sandboxRunner: new FakeSandboxRunner(),
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the filesystem.",
      taskName: "fs-inspect",
    }),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
    channel,
    mainAgent: new SequenceMainAgent([
      {
        action: "launch_task",
        taskBrief: "Inspect the filesystem.",
        taskName: "fs-inspect",
      },
      {
        action: "launch_task",
        taskBrief: "Inspect another filesystem.",
        taskName: "fs-inspect-2",
      },
    ]),
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
    kind: "user_text",
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
    },
    {
      action: "reply",
      replyText: "This should not be reached yet.",
    },
  ]);
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent,
    sandboxRunner: runner,
    sessionStore: store,
    privilegeBroker: new FakePrivilegeBroker(),
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
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
    kind: "user_text",
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
