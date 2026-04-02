import test from "node:test";
import assert from "node:assert/strict";
import type { ChannelAdapter } from "./channel/channel-adapter.js";
import type { MainAgentController } from "./agent/main-agent-controller.js";
import { messages } from "./messages.js";
import type { SandboxHandle, SandboxRunner, LaunchTaskRequest } from "./sandbox/sandbox-runner.js";
import { SandyOrchestrator } from "./orchestrator.js";
import { InMemorySessionStore } from "./session/in-memory-session-store.js";
import type { DecideContext, MainAgentDecision, PrivilegeRequest, SubAgentEvent } from "./types.js";

class RecordingChannel implements ChannelAdapter {
  public readonly sentTexts: Array<{ chatId: string; text: string }> = [];
  public readonly taskUpdates: Array<{ chatId: string; text: string }> = [];
  public readonly privilegeRequests: Array<{ chatId: string; request: PrivilegeRequest }> = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async sendText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
  }

  async sendTaskUpdate(chatId: string, text: string): Promise<void> {
    this.taskUpdates.push({ chatId, text });
  }

  async sendPrivilegeRequest(chatId: string, request: PrivilegeRequest): Promise<void> {
    this.privilegeRequests.push({ chatId, request });
  }
}

class StubMainAgent implements MainAgentController {
  constructor(private readonly decision: MainAgentDecision) {}

  async decide(_context: DecideContext): Promise<MainAgentDecision> {
    return this.decision;
  }
}

class SequenceMainAgent implements MainAgentController {
  private index = 0;

  constructor(private readonly decisions: MainAgentDecision[]) {}

  async decide(_context: DecideContext): Promise<MainAgentDecision> {
    const decision = this.decisions[this.index] ?? this.decisions.at(-1);
    if (!decision) {
      throw new Error("No main-agent decision configured.");
    }
    this.index += 1;
    return decision;
  }
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
}

test("orchestrator launches a task and discards quarantined output on danger report", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the repository.",
      taskName: "repo-inspect",
    }),
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

  const session = store.getOrCreate("chat-1");
  assert.equal(session.activeTask, null);
  assert.equal(
    session.transcript.some((entry) => entry.text === "Potentially dangerous hidden output"),
    false,
  );
});

test("orchestrator releases quarantined output before forwarding the next user message", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Investigate the issue.",
      taskName: "issue-investigation",
    }),
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
  const releasedIndex = session.transcript.findIndex((entry) => entry.kind === "released_sub_agent_output");
  const userIndex = session.transcript.findIndex((entry) => entry.text === "Use the main branch.");
  assert.notEqual(releasedIndex, -1);
  assert.notEqual(userIndex, -1);
  assert.ok(releasedIndex < userIndex);
  assert.deepEqual(runner.handle.userMessages, ["Use the main branch."]);
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
  assert.equal(
    session.transcript.some((entry) => entry.kind === "released_sub_agent_output" && entry.text === "The environment has 8 CPUs."),
    false,
  );
});

test("orchestrator releases completed-task output only when the user continues normally", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent: new SequenceMainAgent([
      {
        action: "launch_task",
        taskBrief: "Inspect the environment.",
        taskName: "env-inspection",
      },
      {
        action: "reply",
        replyText: "Continuing with the next step.",
      },
    ]),
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
  const releasedIndex = session.transcript.findIndex((entry) => entry.kind === "released_sub_agent_output");
  const userIndex = session.transcript.findIndex((entry) => entry.text === "thanks");
  assert.notEqual(releasedIndex, -1);
  assert.notEqual(userIndex, -1);
  assert.ok(releasedIndex < userIndex);
  assert.deepEqual(session.pendingQuarantinedOutputs, []);
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
  assert.equal(
    session.transcript.some((entry) => entry.text === "Potentially unsafe filesystem output"),
    false,
  );
  assert.equal(channel.sentTexts.at(-1)?.text, messages.discardedPendingOutput());
});

test("orchestrator keeps final_result output quarantined until the user continues normally", async () => {
  const channel = new RecordingChannel();
  const runner = new FakeSandboxRunner();
  const store = new InMemorySessionStore();
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent: new SequenceMainAgent([
      {
        action: "launch_task",
        taskBrief: "Inspect the environment.",
        taskName: "env-inspection",
      },
      {
        action: "reply",
        replyText: "Continuing with the next step.",
      },
    ]),
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
  assert.equal(
    session.transcript.some((entry) => entry.text === "The environment has 8 CPUs."),
    false,
  );
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
  const releasedIndex = session.transcript.findIndex((entry) => entry.kind === "released_sub_agent_output");
  const userIndex = session.transcript.findIndex((entry) => entry.text === "thanks");
  assert.notEqual(releasedIndex, -1);
  assert.notEqual(userIndex, -1);
  assert.ok(releasedIndex < userIndex);
  assert.deepEqual(session.pendingQuarantinedOutputs, []);
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
