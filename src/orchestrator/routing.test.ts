import { test } from "bun:test";
import assert from "node:assert/strict";
import { messages } from "../messages.js";
import {
  createTestOrchestrator,
  expectDefined,
  StubMainAgent,
} from "./test-helpers.js";
import type { MainAgentDecision } from "../types.js";
import type { JobDefinition } from "../jobs/job-validation.js";

test("orchestrator accepts active-task output without storing host-side history", async () => {
  const mainAgent = new StubMainAgent({
    action: "launch_task",
    taskBrief: "Investigate the issue.",
    taskName: "issue-investigation",
    taskLanguage: "English",
  });
  const { orchestrator, runner, store } = createTestOrchestrator({ mainAgent });

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

test("orchestrator reports top-level chat event failures back to the user", async () => {
  const { orchestrator, channel, store } = createTestOrchestrator({
    mainAgent: {
      async decide(): Promise<MainAgentDecision> {
        throw new Error("You've hit your usage limit.");
      },
    },
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

test("user messages route to an interacting scheduled job after waiting behind a user task", async () => {
  const { orchestrator, runner, store, taskLifecycle, channel } = createTestOrchestrator({
    mainAgent: new StubMainAgent({
      action: "launch_task",
      taskBrief: "Handle the user's request.",
      taskName: "user-task",
      taskLanguage: "English",
    }),
  });

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-job-routing",
    messageId: "1",
    timestamp: "2026-04-01T00:00:00.000Z",
    text: "Do the first thing",
    rawText: "Do the first thing",
    attachments: [],
  });

  const job: JobDefinition = {
    id: "daily-cleanup",
    name: "Daily cleanup",
    enabled: true,
    schedule: { kind: "cron", expression: "0 9 * * *" },
    skillId: "cleanup-skill",
  };
  const jobTaskId = await taskLifecycle.launchJobTask(job, "chat-job-routing", null);

  const blockedInteraction = orchestrator.executeNativeWorkerToolCall({
    taskId: jobTaskId,
    toolName: "request_interaction",
    arguments: { message: "Waiting on the user task." },
  });
  await Promise.resolve();

  assert.equal(channel.taskUpdates.length, 0);
  assert.equal(store.getOrCreate("chat-job-routing").backgroundJobTasks[0]?.interactionState, "waitingToInteract");

  const userTaskId = expectDefined(runner.launches[0], "Expected launch.").taskId;
  await runner.emit({ type: "task_done" }, userTaskId);
  await blockedInteraction;

  assert.match(channel.taskUpdates.at(-1)?.text ?? "", /needs your attention.*Waiting on the user task/);
  assert.equal(store.getOrCreate("chat-job-routing").activeTask?.taskId, jobTaskId);

  await orchestrator.handleChatEvent({
    kind: "user_message",
    chatId: "chat-job-routing",
    messageId: "2",
    timestamp: "2026-04-01T00:01:00.000Z",
    text: "Continue the scheduled job",
    rawText: "Continue the scheduled job",
    attachments: [],
  });

  const jobHandle = runner.handles.get(jobTaskId);
  assert.match(jobHandle?.userMessages[0]?.text ?? "", /Continue the scheduled job/);
});
