import { test } from "bun:test";
import assert from "node:assert/strict";
import { messages } from "../messages.js";
import {
  contextTexts,
  createTestOrchestrator,
  expectDefined,
  SequenceMainAgent,
  StubMainAgent,
} from "./test-helpers.js";

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
  assert.equal(runner.ensuredTaskShares.length, 1);
  assert.match(expectDefined(channel.savedAttachments[0], "Expected saved attachment batch.").targetDirectory, /inbox\/message_1$/);
  const launch = expectDefined(runner.launches[0], "Expected launch.");
  assert.match(launch.taskBrief, /Files attached by the user are already available/);
  assert.match(launch.taskBrief, /\/workspace\/share\/inbox\/message_1\/1-input\.csv/);
  assert.deepEqual(contextTexts(expectDefined(mainAgent.contexts[0], "Expected main-agent context.")), ["Analyze this\n\nAttached files:\n- input.csv"]);
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

  await runner.emit({ type: "assistant_output", text: "The environment has 8 CPUs." });
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
        "The task ended without a worker-provided handoff summary. Task name: env-inspection. Brief: Inspect the environment.",
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

  await runner.emit({ type: "assistant_output", text: "The environment has 8 CPUs." });
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

  await runner.emit({ type: "assistant_output", text: "Potentially unsafe filesystem output" });
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
  assert.equal(session.activeTask, null);
  assert.equal(session.pendingTaskSummary, null);
  assert.equal(channel.sentTexts.at(-1)?.text, messages.discardedPendingOutput());
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
  assert.equal(session.activeTask, null);
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
  assert.equal(session.activeTask, null);
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
