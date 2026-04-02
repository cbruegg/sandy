import test from "node:test";
import assert from "node:assert/strict";
import type { ChannelAdapter } from "./channel/channel-adapter.js";
import type { MainAgentController } from "./agent/main-agent-controller.js";
import { messages } from "./messages.js";
import type { SandboxHandle, SandboxRunner, LaunchTaskRequest } from "./sandbox/sandbox-runner.js";
import { SandyOrchestrator } from "./orchestrator.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";
import type { ChannelFormatting, DecideContext, MainAgentDecision, PrivilegeRequest, SubAgentEvent } from "./types.js";

const testFormatting: ChannelFormatting = {
  channel: "telegram",
  markup: "telegram_html",
  allowedTags: ["b", "i", "code", "pre"],
  instructions: "Use simple Telegram HTML.",
};

class RecordingChannel implements ChannelAdapter {
  public readonly sentTexts: Array<{ chatId: string; text: string }> = [];
  public readonly taskUpdates: Array<{ chatId: string; text: string }> = [];
  public readonly privilegeRequests: Array<{ chatId: string; request: PrivilegeRequest }> = [];
  public readonly shareDeletionRequests: Array<{ chatId: string; requestId: string; taskName: string; summary: string }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getFormatting(): ChannelFormatting {
    return testFormatting;
  }

  async sendText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
  }

  async sendTaskUpdate(chatId: string, text: string): Promise<void> {
    this.taskUpdates.push({ chatId, text });
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
  public readonly privilegeDecisions: Array<{ requestId: string; decision: "approve" | "deny" }> = [];
  public readonly cancellations: string[] = [];

  async sendUserMessage(text: string): Promise<void> {
    this.userMessages.push(text);
  }

  async resolvePrivilege(requestId: string, decision: "approve" | "deny"): Promise<void> {
    this.privilegeDecisions.push({ requestId, decision });
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
}

test("orchestrator launches a task and discards quarantined output on danger report", async () => {
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
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-1",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the repository",
    rawText: "Inspect the repository",
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
  assert.deepEqual(session.pendingQuarantinedOutputs, []);
  assert.deepEqual(contextTexts(mainAgent.contexts[0]), ["Inspect the repository"]);
  assert.deepEqual(mainAgent.contexts[0]?.channelFormatting, testFormatting);
});

test("orchestrator accepts active-task quarantined output without storing host-side history", async () => {
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
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-2",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Investigate the issue",
    rawText: "Investigate the issue",
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
  });

  const session = store.getOrCreate("chat-2");
  assert.deepEqual(session.pendingQuarantinedOutputs, []);
  assert.equal(session.activeTask?.quarantinedOutputs.length ?? 0, 0);
  assert.deepEqual(runner.handle.userMessages, ["Use the main branch."]);
  assert.equal(mainAgent.contexts.length, 1);
});

test("orchestrator keeps privilege decisions deterministic and out of the main agent path", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Check an MCP resource.",
      taskName: "mcp-check",
    }),
    sandboxRunner: runner,
    sessionStore: store,
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-3",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Check an MCP resource",
    rawText: "Check an MCP resource",
  });

  await runner.emit({
    type: "privilege_request",
    request: {
      type: "enable_mcp",
      requestId: "req-1",
      identifier: "github-readonly",
      reason: "Need repository metadata.",
    },
  });

  await orchestrator.handleChatEvent({
    kind: "approval_response",
    chatId: "chat-3",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "approve",
    requestId: "req-1",
  });

  assert.equal(channel.privilegeRequests.length, 1);
  assert.deepEqual(runner.handle.privilegeDecisions, [{ requestId: "req-1", decision: "approve" }]);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.privilegeApproved("req-1"));
});

test("orchestrator keeps completed-task output quarantined until the user sends another message", async () => {
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
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-4",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the environment",
    rawText: "Inspect the environment",
  });

  await runner.emit({
    type: "assistant_output",
    text: "The environment has 8 CPUs.",
  });

  await runner.emit({
    type: "task_done",
  });

  const session = store.getOrCreate("chat-4");
  assert.equal(session.activeTask, null);
  assert.deepEqual(session.pendingQuarantinedOutputs, ["The environment has 8 CPUs."]);
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
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-5",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the environment",
    rawText: "Inspect the environment",
  });

  await runner.emit({
    type: "assistant_output",
    text: "The environment has 8 CPUs.",
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
  });

  const session = store.getOrCreate("chat-5");
  assert.deepEqual(session.pendingQuarantinedOutputs, []);
  assert.deepEqual(contextTexts(mainAgent.contexts[1]), ["The environment has 8 CPUs.", "thanks"]);
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
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-5",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the filesystem",
    rawText: "Inspect the filesystem",
  });

  await runner.emit({
    type: "assistant_output",
    text: "Potentially unsafe filesystem output",
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
  assert.deepEqual(session.pendingQuarantinedOutputs, []);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.discardedPendingOutput());
});

test("orchestrator keeps final_result output quarantined until the user continues normally", async () => {
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
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-6",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the environment",
    rawText: "Inspect the environment",
  });

  await runner.emit({
    type: "final_result",
    text: "The environment has 8 CPUs.",
  });

  let session = store.getOrCreate("chat-6");
  assert.equal(session.activeTask, null);
  assert.deepEqual(session.pendingQuarantinedOutputs, ["The environment has 8 CPUs."]);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.taskComplete("The environment has 8 CPUs."));

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-6",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
    text: "thanks",
    rawText: "thanks",
  });

  session = store.getOrCreate("chat-6");
  assert.deepEqual(session.pendingQuarantinedOutputs, []);
  assert.deepEqual(contextTexts(mainAgent.contexts[1]), ["The environment has 8 CPUs.", "thanks"]);
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
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-7",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the filesystem",
    rawText: "Inspect the filesystem",
  });

  await runner.emit({
    type: "worker_disconnected",
    message: "Sub-agent control channel disconnected unexpectedly.",
  });

  const session = store.getOrCreate("chat-7");
  assert.equal(session.activeTask, null);
  assert.equal(channel.sentTexts.at(-1)?.text, "Sub-agent control channel disconnected unexpectedly.");
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
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-8",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the filesystem",
    rawText: "Inspect the filesystem",
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
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-9",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the filesystem",
    rawText: "Inspect the filesystem",
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
  });

  await orchestrator.handleChatEvent({
    kind: "user_text",
    chatId: "chat-10",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the filesystem",
    rawText: "Inspect the filesystem",
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
  });

  assert.equal(mainAgent.contexts.length, 1);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.shareDeletionStillPending());
});
