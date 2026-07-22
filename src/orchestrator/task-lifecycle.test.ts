import { test } from "bun:test";
import assert from "node:assert/strict";
import { messages } from "../messages-to-user.js";
import {
  contextTexts,
  createTestOrchestrator,
  expectDefined,
  RecordingChannel,
  SequenceMainAgent,
  StubMainAgent,
} from "./test-helpers.js";
import type { JobDefinition } from "../jobs/job-validation.js";
import { CommentaryBufferManager } from "./commentary-buffer-manager.js";
import type { JobTaskMemoryContextInput, TaskMemoryContextCollector } from "../memory/task-memory-context-collector.js";

function assertNull(value: unknown): void {
  assert.equal(value, null);
}

class FakeTimers {
  public now = 0;
  private nextId = 1;
  private readonly entries = new Map<number, { at: number; callback: () => void }>();

  readonly setTimeoutImpl = ((callback: () => void, delay?: number) => {
    const id = this.nextId += 1;
    this.entries.set(id, { at: this.now + (delay ?? 0), callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  readonly clearTimeoutImpl = ((handle: ReturnType<typeof setTimeout>) => {
    this.entries.delete(handle as unknown as number);
  }) as typeof clearTimeout;

  async advanceBy(ms: number): Promise<void> {
    const target = this.now + ms;
    while (true) {
      const next = Array.from(this.entries.entries())
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next || next[1].at > target) {
        break;
      }
      this.entries.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
      await Promise.resolve();
    }
    this.now = target;
  }
}

class StaticTaskMemoryContextCollector implements TaskMemoryContextCollector {
  public readonly inputs: JobTaskMemoryContextInput[] = [];

  constructor(private readonly context: string | null) {}

  collectForJobTask(input: JobTaskMemoryContextInput): Promise<string | null> {
    this.inputs.push(input);
    return Promise.resolve(this.context);
  }
}

test("orchestrator stages attached files into the task share before launching the worker", async () => {
  const mainAgent = new StubMainAgent({
    action: "launch_task",
    taskBrief: "Analyze the uploaded file.",
    taskName: "file-analysis",
    taskLanguage: "English",
  });
  const { orchestrator, channel, runner } = createTestOrchestrator({ mainAgent });

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
  assert.equal(runner.launchedTaskShares.length, 1);
  assert.match(expectDefined(channel.savedAttachments[0], "Expected saved attachment batch.").targetDirectory, /inbox\/message_1$/);
  const launch = expectDefined(runner.launches[0], "Expected launch.");
  assert.match(launch.taskBrief, /Files attached by the user are already available/);
  assert.match(launch.taskBrief, /\/workspace\/share\/inbox\/message_1\/1-input\.csv/);
  assert.deepEqual(contextTexts(expectDefined(mainAgent.contexts[0], "Expected main-agent context.")), ["Analyze this\n\nAttached files:\n- input.csv"]);
});

test("orchestrator retains idle attachments across direct replies until the next task launch", async () => {
  const mainAgent = new SequenceMainAgent([
    {
      action: "reply",
      replyText: "What should I do with the image?",
    },
    {
      action: "launch_task",
      taskBrief: "Identify the event shown in the image.",
      taskName: "image-analysis",
      taskLanguage: "English",
    },
  ]);
  const { orchestrator, channel, runner, store } = createTestOrchestrator({ mainAgent });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-pending-image",
    messageId: "image-message",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "",
    rawText: "",
    attachments: [{
      attachmentId: "image-1",
      kind: "image",
      fileName: "dj-set.png",
      mimeType: "image/png",
    }],
  });

  assert.equal(channel.savedAttachments.length, 0);
  assert.equal(store.getOrCreate("chat-pending-image").pendingAttachmentBatches.length, 1);

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-pending-image",
    messageId: "text-message",
    timestamp: "2026-04-01T00:00:10.000Z",
    text: "Find the full set",
    rawText: "Find the full set",
    attachments: [],
  });

  assert.equal(channel.savedAttachments.length, 1);
  assert.equal(channel.savedAttachments[0]?.attachments[0]?.attachmentId, "image-1");
  assert.match(channel.savedAttachments[0]?.targetDirectory ?? "", /inbox\/image-message$/);
  assert.equal(store.getOrCreate("chat-pending-image").pendingAttachmentBatches.length, 0);
  assert.deepEqual(runner.launches[0]?.initialInput.images, [{
    sharePath: expectDefined(runner.launches[0]?.initialInput.images[0], "Expected staged image.").sharePath,
    fileName: "dj-set.png",
  }]);
  assert.match(runner.launches[0]?.initialInput.images[0]?.sharePath ?? "", /inbox\/image-message\/1-dj-set\.png$/);
});

test("orchestrator retains pending attachments when task launch fails", async () => {
  const mainAgent = new SequenceMainAgent([
    {
      action: "reply",
      replyText: "What should I do with the image?",
    },
    {
      action: "launch_task",
      taskBrief: "Identify the event shown in the image.",
      taskName: "failed-image-analysis",
      taskLanguage: "English",
    },
    {
      action: "launch_task",
      taskBrief: "Retry identifying the event shown in the image.",
      taskName: "retried-image-analysis",
      taskLanguage: "English",
    },
  ]);
  const channel = new RecordingChannel();
  const { orchestrator, runner, store } = createTestOrchestrator({ mainAgent, channel });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-image-launch-retry",
    messageId: "image-message",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "",
    rawText: "",
    attachments: [{
      attachmentId: "image-1",
      kind: "image",
      fileName: "dj-set.png",
      mimeType: "image/png",
    }],
  });

  channel.saveAttachmentsError = new Error("download failed");
  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-image-launch-retry",
    messageId: "first-instruction",
    timestamp: "2026-04-01T00:00:10.000Z",
    text: "Find the full set",
    rawText: "Find the full set",
    attachments: [],
  });

  assert.equal(runner.launches.length, 0);
  assert.equal(store.getOrCreate("chat-image-launch-retry").visibleTask, null);
  assert.equal(store.getOrCreate("chat-image-launch-retry").pendingAttachmentBatches.length, 1);

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-image-launch-retry",
    messageId: "retry-instruction",
    timestamp: "2026-04-01T00:00:20.000Z",
    text: "Retry",
    rawText: "Retry",
    attachments: [],
  });

  assert.equal(store.getOrCreate("chat-image-launch-retry").pendingAttachmentBatches.length, 0);
  assert.equal(runner.launches.length, 1);
  assert.equal(runner.launches[0]?.initialInput.images[0]?.fileName, "dj-set.png");
  assert.match(runner.launches[0]?.initialInput.images[0]?.sharePath ?? "", /inbox\/image-message\/1-dj-set\.png$/);
});

test("orchestrator stages attached files into the active task share and notifies the worker", async () => {
  const { orchestrator, channel, runner } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Wait for files.",
      taskName: "file-wait",
      taskLanguage: "English",
    }),
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

test("scheduled job task brief includes collected memory context", async () => {
  const memoryContextCollector = new StaticTaskMemoryContextCollector("User prefers weekly reports in concise bullet points.");
  const { taskLifecycle, runner } = createTestOrchestrator({
    mainAgent: new StubMainAgent({ action: "reply", replyText: "ok" }),
    memoryContextCollector,
  });
  const job: JobDefinition = {
    id: "job-memory-context",
    name: "Weekly report",
    enabled: true,
    schedule: { kind: "cron", expression: "0 9 * * 1" },
    skillId: "report",
  };

  await taskLifecycle.launchJobTask(job, "chat-job-memory", "/host/job-workspace");

  assert.equal(memoryContextCollector.inputs.length, 1);
  assert.equal(memoryContextCollector.inputs[0]?.job.id, "job-memory-context");
  assert.equal(memoryContextCollector.inputs[0]?.workspacePath, "/host/job-workspace");
  const launch = expectDefined(runner.launches[0], "Expected scheduled job launch.");
  assert.match(launch.taskBrief, /Relevant stored memories:/);
  assert.match(launch.taskBrief, /User prefers weekly reports in concise bullet points/);
  assert.match(launch.taskBrief, /potentially useful background context/);
});

test("orchestrator keeps completed-task summary pending until the user sends another message", async () => {
  const { orchestrator, runner, store } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the environment.",
      taskName: "env-inspection",
      taskLanguage: "English",
    }),
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

  await runner.emit({ type: "assistant_output", text: "The environment has 8 CPUs.", phase: null });
  await runner.emit({
    type: "task_summary",
    summary: [
      "Summary: Inspected the environment and found 8 CPUs.",
      "Artifacts: none",
      "Open questions: none",
    ].join("\n"),
  });
  await runner.emit({ type: "task_done" });

  const session = store.getOrCreate("chat-4");
  assert.equal(session.visibleTask, null);
  assert.deepEqual(session.pendingTaskSummary, {
    taskName: "env-inspection",
    summary: [
      "Summary: Inspected the environment and found 8 CPUs.",
      "Artifacts: none",
      "Open questions: none",
    ].join("\n"),
  });
});

test("orchestrator closes the sandbox handle on normal task completion", async () => {
  const { orchestrator, runner } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the environment.",
      taskName: "env-inspection",
      taskLanguage: "English",
    }),
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

  await runner.emit({ type: "task_done" });

  assert.equal(runner.handle.closeCalls, 1);
});

test("orchestrator retries cleanup through event-failure handling when normal completion cleanup fails once", async () => {
  const { orchestrator, runner, store, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the environment.",
      taskName: "env-inspection",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-close-retry",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the environment",
    rawText: "Inspect the environment",
    attachments: [],
  });

  runner.handle.closeError = new Error("close failed once");

  await runner.emit({ type: "task_done" });

  const session = store.getOrCreate("chat-close-retry");
  assert.ok(session.visibleTask === null);
  assert.equal(runner.handle.closeCalls, 2);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.taskFailed("close failed once"));
});

test("orchestrator asks the worker to finalize when the user marks the task as finished", async () => {
  const { orchestrator, runner, store } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the environment.",
      taskName: "env-inspection",
      taskLanguage: "English",
    }),
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
  await runner.emit({ type: "task_done" });

  const session = store.getOrCreate("chat-mark-finished");
  assert.equal(session.visibleTask, null);
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
  const { orchestrator, runner, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the environment.",
      taskName: "env-inspection",
      taskLanguage: "English",
    }),
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

  await runner.emit({ type: "task_done" });

  assert.equal(
    channel.sentTexts.at(-1)?.text,
    messages.taskSummaryReady(
      "env-inspection",
      [
        "The task ended without a worker-provided handoff summary. Task name: env-inspection.",
        "Open questions: Review the visible task updates above if more detail is needed.",
      ].join("\n"),
    ),
  );
});

test("orchestrator releases completed-task output only when the user continues normally", async () => {
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
  const { orchestrator, runner, store } = createTestOrchestrator({ mainAgent });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-5",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the environment",
    rawText: "Inspect the environment",
    attachments: [],
  });

  await runner.emit({ type: "assistant_output", text: "The environment has 8 CPUs.", phase: null });
  await runner.emit({
    type: "task_summary",
    summary: [
      "Summary: Inspected the environment and found 8 CPUs.",
      "Artifacts: none",
      "Open questions: none",
    ].join("\n"),
  });
  await runner.emit({ type: "task_done" });

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
  const { orchestrator, runner, store, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the filesystem.",
      taskName: "fs-inspect",
      taskLanguage: "English",
    }),
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

  await runner.emit({ type: "assistant_output", text: "Potentially unsafe filesystem output", phase: null });
  await runner.emit({
    type: "task_summary",
    summary: [
      "Summary: Inspected the filesystem.",
      "Artifacts: none",
      "Open questions: none",
    ].join("\n"),
  });
  await runner.emit({ type: "task_done" });

  await orchestrator.handleChatEvent({
    kind: "danger_report",
    chatId: "chat-5",
    messageId: "2",
    timestamp: "2026-04-01T00:00:10.000Z",
  });

  const session = store.getOrCreate("chat-5");
  assert.equal(session.visibleTask, null);
  assert.equal(session.pendingTaskSummary, null);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.discardedPendingOutput());
});

test("orchestrator requires pending summary confirmation before a background job becomes interactive", async () => {
  const mainAgent = new SequenceMainAgent([
    {
      action: "launch_task",
      taskBrief: "Inspect the environment.",
      taskName: "env-inspection",
      taskLanguage: "English",
    },
    {
      action: "reply",
      replyText: "should not run yet",
    },
  ]);
  const { orchestrator, taskLifecycle, runner, store, channel } = createTestOrchestrator({ mainAgent });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-summary-confirm",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the environment",
    rawText: "Inspect the environment",
    attachments: [],
  });
  await runner.emit({ type: "task_summary", summary: "Summary: Found 8 CPUs." });
  await runner.emit({ type: "task_done" });

  const job: JobDefinition = {
    id: "job-confirm",
    name: "Daily report",
    enabled: true,
    schedule: { kind: "one_shot", runAt: "2026-04-01T00:00:00.000Z" },
    skillId: "report",
  };
  const jobTaskId = await taskLifecycle.launchJobTask(job, "chat-summary-confirm", null);
  const interactionPromise = orchestrator.executeNativeWorkerToolCall({
    taskId: jobTaskId,
    toolName: "request_interaction",
    arguments: { message: "Need review." },
  });
  await Promise.resolve();

  const session = store.getOrCreate("chat-summary-confirm");
  assertNull(session.visibleTask);
  assert.equal(channel.taskUpdates.length, 0);
  assert.equal(channel.taskSummaryConfirmationRequests.length, 1);
  const requestId = expectDefined(channel.taskSummaryConfirmationRequests[0], "Expected summary confirmation request.").requestId;
  assert.equal(session.pendingTaskSummary?.confirmationRequestId, requestId);

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-summary-confirm",
    messageId: "2",
    timestamp: "2026-04-01T00:00:05.000Z",
    text: "hello?",
    rawText: "hello?",
    attachments: [],
  });
  assert.equal(mainAgent.contexts.length, 1);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.pendingSummaryStillPending());

  await orchestrator.handleChatEvent({
    kind: "approval_response",
    target: "task_summary_confirmation",
    chatId: "chat-summary-confirm",
    messageId: "confirm:1",
    timestamp: "2026-04-01T00:00:10.000Z",
    decision: "approve",
    requestId,
  });

  assert.equal(session.pendingTaskSummary, null);
  assert.equal(session.visibleTask?.taskId, jobTaskId);
  assert.equal(channel.taskUpdates.length, 2);
  assert.equal(channel.taskUpdates[0]?.text, messages.scheduledJobBecameInteractive("Scheduled job: Daily report", "Daily report"));
  assert.equal(channel.taskUpdates[1]?.text, messages.jobRequestsInteraction("Scheduled job: Daily report", "Daily report", "Need review."));

  await interactionPromise;
});

test("confirmed task summaries are released on the next idle main-agent turn", async () => {
  const mainAgent = new SequenceMainAgent([
    { action: "reply", replyText: "ok" },
  ]);
  const { orchestrator, taskLifecycle, store } = createTestOrchestrator({ mainAgent });
  const session = store.getOrCreate("chat-confirmed-summary-release");
  session.pendingTaskSummary = {
    taskName: "env-inspection",
    summary: "Summary: Found 8 CPUs.",
    confirmationRequestId: "summary-1",
  };

  assert.equal(taskLifecycle.confirmPendingTaskSummary(session), "env-inspection");

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-confirmed-summary-release",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "thanks",
    rawText: "thanks",
    attachments: [],
  });

  const context = expectDefined(mainAgent.contexts[0], "Expected main-agent context.");
  assert.deepEqual(contextTexts(context), ["Summary: Found 8 CPUs.", "thanks"]);
});

test("orchestrator keeps final_result output pending until the user continues normally", async () => {
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
  const { orchestrator, runner, store, channel } = createTestOrchestrator({ mainAgent });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-6",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the environment",
    rawText: "Inspect the environment",
    attachments: [],
  });

  await runner.emit({ type: "final_result", text: "The environment has 8 CPUs." });

  let session = store.getOrCreate("chat-6");
  assert.equal(session.visibleTask, null);
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
  const { orchestrator, runner, store, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the filesystem.",
      taskName: "fs-inspect",
      taskLanguage: "English",
    }),
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
  assert.equal(session.visibleTask, null);
  assert.equal(channel.sentTexts.at(-1)?.text, "Sub-agent control channel disconnected unexpectedly.");
});

test("orchestrator prompts before deleting a non-empty shared workspace", async () => {
  const { orchestrator, runner, store, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Inspect the filesystem.",
      taskName: "fs-inspect",
      taskLanguage: "English",
    }),
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

  await runner.emit({ type: "task_done" });

  const session = store.getOrCreate("chat-8");
  assert.equal(session.visibleTask, null);
  assert.equal(channel.shareDeletionRequests.length, 1);
  assert.equal(channel.shareDeletionRequests[0]?.taskName, "fs-inspect");
  assert.equal(runner.deletedTaskShares.length, 0);
});

test("orchestrator deletes or preserves a finished task share based on user confirmation", async () => {
  const mainAgent = new SequenceMainAgent([
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
  ]);
  const { orchestrator, runner, channel } = createTestOrchestrator({ mainAgent });

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

  await runner.emit({ type: "task_done" });

  const deleteRequestId = channel.shareDeletionRequests[0]?.requestId;
  assert.ok(deleteRequestId);
  await orchestrator.handleChatEvent({
    kind: "approval_response",
    target: "share_deletion",
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

  await runner.emit({ type: "task_done" });

  const preserveRequestId = channel.shareDeletionRequests[1]?.requestId;
  assert.ok(preserveRequestId);
  await orchestrator.handleChatEvent({
    kind: "approval_response",
    target: "share_deletion",
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
  const { orchestrator, runner, channel } = createTestOrchestrator({ mainAgent });

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

  await runner.emit({ type: "task_done" });

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

test("orchestrator prompts for share deletion from a silent job task", async () => {
  const { taskLifecycle, runner, store, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({ action: "reply", replyText: "ok" }),
  });

  const job: JobDefinition = {
    id: "job-1",
    name: "Daily cleanup",
    enabled: true,
    schedule: { kind: "one_shot", runAt: "2026-04-01T00:00:00.000Z" },
    skillId: "cleanup",
  };
  const taskId = await taskLifecycle.launchJobTask(job, "chat-job-silent", null);
  runner.shareInspections.set(taskId, {
    isEmpty: false,
    summary: "report.txt",
  });

  await runner.emit({ type: "task_done" }, taskId);

  const session = store.getOrCreate("chat-job-silent");
  assert.equal(session.visibleTask, null);
  assert.equal(channel.shareDeletionRequests.length, 1);
  assert.equal(channel.shareDeletionRequests[0]?.taskName, "Scheduled job: Daily cleanup");
});

test("orchestrator defers job share deletion prompt while a user task is active", async () => {
  const mainAgent = new SequenceMainAgent([
    {
      action: "launch_task",
      taskBrief: "Inspect the filesystem.",
      taskName: "fs-inspect",
      taskLanguage: "English",
    },
    {
      action: "reply",
      replyText: "ok",
    },
  ]);
  const { orchestrator, taskLifecycle, runner, store, channel } = createTestOrchestrator({ mainAgent });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-job-defer",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Inspect the filesystem",
    rawText: "Inspect the filesystem",
    attachments: [],
  });

  const job: JobDefinition = {
    id: "job-1",
    name: "Daily cleanup",
    enabled: true,
    schedule: { kind: "one_shot", runAt: "2026-04-01T00:00:00.000Z" },
    skillId: "cleanup",
  };
  const jobTaskId = await taskLifecycle.launchJobTask(job, "chat-job-defer", null);
  runner.shareInspections.set(jobTaskId, {
    isEmpty: false,
    summary: "report.txt",
  });

  await runner.emit({ type: "task_done" }, jobTaskId);

  const session = store.getOrCreate("chat-job-defer");
  assert.equal(session.visibleTask?.taskId, runner.launches[0]?.taskId);
  assert.equal(channel.shareDeletionRequests.length, 0);

  const userTaskId = runner.launches[0]?.taskId;
  assert.ok(userTaskId);
  runner.shareInspections.set(userTaskId, {
    isEmpty: true,
    summary: null,
  });
  await runner.emit({ type: "task_done" }, userTaskId);

  assert.equal(session.visibleTask, null);
  assert.equal(channel.taskSummaryConfirmationRequests.length, 1);
  await orchestrator.handleChatEvent({
    kind: "approval_response",
    target: "task_summary_confirmation",
    chatId: "chat-job-defer",
    messageId: "confirm-summary:1",
    timestamp: "2026-04-01T00:00:20.000Z",
    decision: "approve",
    requestId: channel.taskSummaryConfirmationRequests[0]?.requestId,
  });

  assert.equal(channel.shareDeletionRequests.length, 1);
  assert.equal(channel.shareDeletionRequests[0]?.taskName, "Scheduled job: Daily cleanup");
});

test("silent job task progress updates are suppressed", async () => {
  const { taskLifecycle, runner, store, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({ action: "reply", replyText: "ok" }),
  });

  const job: JobDefinition = {
    id: "job-silent-progress",
    name: "Daily cleanup",
    enabled: true,
    schedule: { kind: "one_shot", runAt: "2026-04-01T00:00:00.000Z" },
    skillId: "cleanup",
  };
  const taskId = await taskLifecycle.launchJobTask(job, "chat-silent-progress", null);

  await runner.emit({ type: "progress", message: "Cleaning up old files." }, taskId);
  await runner.emit({ type: "assistant_output", text: "I'm working on the cleanup.", phase: null }, taskId);

  // Progress and assistant_output should be suppressed for a silent job task.
  assert.equal(channel.taskUpdates.length, 0);
  assert.equal(channel.sentTexts.length, 0);

  const session = store.getOrCreate("chat-silent-progress");
  const task = session.findTask(taskId)?.task;
  assert.ok(task);
  assert.equal(task.interactionState, "silent");
});

test("commentary-phase assistant_output is buffered instead of sent immediately", async () => {
  const { orchestrator, runner, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Do the thing.",
      taskName: "commentary-task",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-commentary-buffer",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Do the thing",
    rawText: "Do the thing",
    attachments: [],
  });

  // Commentary output — should be buffered, not sent.
  await runner.emit({ type: "assistant_output", text: "Checking prerequisites...", phase: "commentary" });
  await runner.emit({ type: "assistant_output", text: "Still checking...", phase: "commentary" });

  assert.equal(channel.taskUpdates.length, 0);
});

test("non-commentary assistant_output flushes buffered commentary first", async () => {
  const { orchestrator, runner, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Do the thing.",
      taskName: "flush-task",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-flush",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Do the thing",
    rawText: "Do the thing",
    attachments: [],
  });

  await runner.emit({ type: "assistant_output", text: "Buffered commentary A", phase: "commentary" });
  await runner.emit({ type: "assistant_output", text: "Buffered commentary B", phase: "commentary" });

  // Non-commentary output — should flush the buffer first.
  await runner.emit({ type: "assistant_output", text: "Real output", phase: null });

  assert.equal(channel.taskUpdates.length, 2);
  assert.equal(channel.taskUpdates[0]?.text, "Buffered commentary A\n\nBuffered commentary B");
  assert.equal(channel.taskUpdates[1]?.text, "Real output");
});

test("progress output flushes buffered commentary first", async () => {
  const { orchestrator, runner, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Do the thing.",
      taskName: "progress-flush-task",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-progress-flush",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Do the thing",
    rawText: "Do the thing",
    attachments: [],
  });

  await runner.emit({ type: "assistant_output", text: "Buffered commentary", phase: "commentary" });
  await runner.emit({ type: "progress", message: "Next planned step: Deploy" });

  assert.equal(channel.taskUpdates.length, 2);
  assert.equal(channel.taskUpdates[0]?.text, "Buffered commentary");
  assert.equal(channel.taskUpdates[1]?.text, "Next planned step: Deploy");
});

test("commentary buffer is flushed after 60s idle timeout", async () => {
  const timers = new FakeTimers();
  const channel = new RecordingChannel();

  const commentaryBuffer = new CommentaryBufferManager(
    async (_taskId, chatId, text) => {
      await channel.sendTaskUpdate(chatId, text);
    },
    {
      now: () => timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
  );

  const { orchestrator, runner } = createTestOrchestrator({
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Do the thing.",
      taskName: "timeout-task",
      taskLanguage: "English",
    }),
    commentaryBuffer,
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-timeout",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Do the thing",
    rawText: "Do the thing",
    attachments: [],
  });

  await runner.emit({ type: "assistant_output", text: "Checking...", phase: "commentary" });
  assert.equal(channel.taskUpdates.length, 0);

  // Advance just under 60s — still no flush.
  await timers.advanceBy(59_999);
  assert.equal(channel.taskUpdates.length, 0);

  // Advance past 60s — buffer should flush.
  await timers.advanceBy(2);
  assert.equal(channel.taskUpdates.length, 1);
  assert.equal(channel.taskUpdates[0]?.text, "Checking...");
});

test("commentary timer resets on user message", async () => {
  const timers = new FakeTimers();
  const channel = new RecordingChannel();

  const commentaryBuffer = new CommentaryBufferManager(
    async (_taskId, chatId, text) => {
      await channel.sendTaskUpdate(chatId, text);
    },
    {
      now: () => timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
  );

  const { orchestrator, runner } = createTestOrchestrator({
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Do the thing.",
      taskName: "reset-task",
      taskLanguage: "English",
    }),
    commentaryBuffer,
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-reset",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Do the thing",
    rawText: "Do the thing",
    attachments: [],
  });

  await runner.emit({ type: "assistant_output", text: "Buffered", phase: "commentary" });

  // Advance 30s, then user sends another message — timer should reset.
  await timers.advanceBy(30_000);

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-reset",
    messageId: "2",
    timestamp: "2026-04-01T00:00:30.000Z",
    text: "Keep going",
    rawText: "Keep going",
    attachments: [],
  });

  // Advance 30s more (total 60s from first event, but only 30s from user message) — no flush yet.
  await timers.advanceBy(30_000);
  assert.equal(channel.taskUpdates.length, 0);

  // Advance to 60s from user message — flush.
  await timers.advanceBy(30_000);
  assert.equal(channel.taskUpdates.length, 1);
  assert.equal(channel.taskUpdates[0]?.text, "Buffered");
});

test("task completion clears the commentary buffer without flushing", async () => {
  const timers = new FakeTimers();
  const channel = new RecordingChannel();

  const commentaryBuffer = new CommentaryBufferManager(
    async (_taskId, chatId, text) => {
      await channel.sendTaskUpdate(chatId, text);
    },
    {
      now: () => timers.now,
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
    },
  );

  const { orchestrator, runner } = createTestOrchestrator({
    channel,
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Do the thing.",
      taskName: "clear-task",
      taskLanguage: "English",
    }),
    commentaryBuffer,
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-clear",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Do the thing",
    rawText: "Do the thing",
    attachments: [],
  });

  await runner.emit({ type: "assistant_output", text: "Buffered commentary", phase: "commentary" });

  // Task completes — buffer should be cleared, not flushed.
  await runner.emit({ type: "task_done" });

  assert.equal(channel.taskUpdates.length, 0);

  // Advance past 60s — still nothing because buffer was cleared.
  await timers.advanceBy(60_001);
  assert.equal(channel.taskUpdates.length, 0);
});

test("task error does not flush the commentary buffer", async () => {
  const { orchestrator, runner, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Do the thing.",
      taskName: "error-task",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-error",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Do the thing",
    rawText: "Do the thing",
    attachments: [],
  });

  await runner.emit({ type: "assistant_output", text: "Buffered commentary", phase: "commentary" });

  // Task error — should NOT flush buffer, just send the error.
  await runner.emit({ type: "task_error", message: "Something broke" });

  assert.equal(channel.taskUpdates.length, 0);
  assert.equal(channel.sentTexts.length, 2); // "Started task" + error message
  assert.match(channel.sentTexts[1]?.text ?? "", /Something broke/);
});

test("privilege prompt flushes commentary buffer before showing the request", async () => {
  const { orchestrator, runner, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Do the thing.",
      taskName: "privilege-task",
      taskLanguage: "English",
      taskPolicy: { autoApproveMcpServers: [], autoApproveHttpTokens: [] },
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-privilege",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Do the thing",
    rawText: "Do the thing",
    attachments: [],
  });

  await runner.emit({ type: "assistant_output", text: "Buffered before privilege", phase: "commentary" });

  // Fire a privilege request — the flush should happen within the
  // runJobUserVisibleOperation callback before the result promise is awaited.
  // We don't await the result so the test doesn't block on the pending privilege resolution.
  const taskId = expectDefined(runner.launches[0], "Expected launch.").taskId;
  const mcpPromise = orchestrator.authorizeMcpToolCall({
    taskId,
    serverId: "test-server",
    toolName: "getStuff",
    arguments: { key: "val" },
  });

  // Let microtasks run so the enqueuePrivilegeRequest callback executes.
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });

  // Buffer should have been flushed BEFORE the privilege request was sent.
  assert.equal(channel.taskUpdates.length, 1);
  assert.equal(channel.taskUpdates[0]?.text, "Buffered before privilege");
  assert.equal(channel.privilegeRequests.length, 1);
  assert.equal(channel.privilegeRequests[0]?.request.kind, "mcp_tool_call");

  // Resolve the pending privilege to clean up.
  await orchestrator.handleChatEvent({
    kind: "approval_response",
    target: "privilege_request",
    chatId: "chat-privilege",
    messageId: "approve:1",
    timestamp: "2026-04-01T00:00:05.000Z",
    decision: "approve_once",
    requestId: channel.privilegeRequests[0]?.request.requestId,
  });
  await mcpPromise;
});
