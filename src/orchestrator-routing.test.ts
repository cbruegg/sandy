import { test } from "bun:test";
import assert from "node:assert/strict";
import { messages } from "./messages.js";
import {
  createTestOrchestrator,
  StubMainAgent,
} from "./orchestrator-test-helpers.js";
import type { MainAgentDecision } from "./types.js";

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
