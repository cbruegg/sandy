import test from "node:test";
import assert from "node:assert/strict";
import type { ThreadOptions } from "@openai/codex-sdk";
import { mainAgentDecisionOutputSchema } from "./agent/main-agent-decision.js";
import {
  buildMainAgentPrompt,
  buildMainAgentThreadOptions,
  CodexMainAgentController,
} from "./agent/main-agent-controller.js";
import type { ChannelFormatting, DecideContext } from "./types.js";

const testFormatting: ChannelFormatting = {
  channel: "telegram",
  markup: "telegram_html",
  allowedTags: ["b", "i", "code", "pre"],
  instructions: "Use simple Telegram HTML.",
};

class RecordingThread {
  public readonly inputs: Array<{ input: string; options?: { outputSchema?: object } }> = [];

  constructor(private readonly finalResponses: string[]) {}

  async run(input: string, options?: { outputSchema?: object }): Promise<{ finalResponse: string }> {
    this.inputs.push({ input, options });
    const finalResponse = this.finalResponses.shift();
    if (!finalResponse) {
      throw new Error("No final response configured.");
    }
    return { finalResponse };
  }
}

class RecordingCodexClient {
  public readonly startedThreads: ThreadOptions[] = [];
  public readonly threads: RecordingThread[] = [];

  constructor(private readonly finalResponsesPerThread: string[][]) {}

  startThread(options?: ThreadOptions): RecordingThread {
    this.startedThreads.push(options ?? {});
    const finalResponses = this.finalResponsesPerThread.shift() ?? [];
    const thread = new RecordingThread(finalResponses);
    this.threads.push(thread);
    return thread;
  }
}

function makeContext(texts: string[], chatId = "chat-1"): DecideContext {
  return {
    chatId,
    newVisibleEntries: texts.map((text, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      kind: index % 2 === 0 ? "user_text" : "main_agent_reply",
      timestamp: `2026-04-02T10:00:0${index}.000Z`,
      text,
    })),
    activeTask: null,
    channelFormatting: testFormatting,
  };
}

function replyDecision(replyText: string): string {
  return JSON.stringify({
    action: "reply",
    replyText,
  });
}

test("buildMainAgentThreadOptions locks the main agent down", () => {
  const options = buildMainAgentThreadOptions("/tmp/sandy-main-agent-test");

  assert.equal(options.approvalPolicy, "never");
  assert.equal(options.sandboxMode, "read-only");
  assert.equal(options.workingDirectory, "/tmp/sandy-main-agent-test");
  assert.equal(options.skipGitRepoCheck, true);
});

test("buildMainAgentPrompt includes only the new visible entries for incremental turns", () => {
  const initialPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["hello"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    isInitialTurn: true,
  });
  const deltaPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["follow-up"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    isInitialTurn: false,
  });

  assert.match(initialPrompt, /Visible chat entries for this first decision:/);
  assert.match(deltaPrompt, /New visible chat entries since your last decision:/);
  assert.doesNotMatch(deltaPrompt, /Visible chat entries for this first decision:/);
  assert.match(initialPrompt, /telegram_html/);
  assert.match(initialPrompt, /"allowedTags"/);
});

test("CodexMainAgentController starts threads in a unique temp directory with no approvals", async () => {
  const codex = new RecordingCodexClient([[replyDecision("hello")]]);
  const controller = new CodexMainAgentController(codex);

  const decision = await controller.decide(makeContext(["hello"]));

  assert.equal(decision.action, "reply");
  assert.equal(codex.startedThreads.length, 1);

  const options = codex.startedThreads[0];
  assert.equal(options.approvalPolicy, "never");
  assert.equal(options.sandboxMode, "read-only");
  assert.equal(options.skipGitRepoCheck, true);
  assert.match(options.workingDirectory ?? "", /^.+sandy-main-agent-/);
  assert.deepEqual(codex.threads[0].inputs[0].options?.outputSchema, mainAgentDecisionOutputSchema);
});

test("CodexMainAgentController sends only the entries provided for each decision", async () => {
  const codex = new RecordingCodexClient([[replyDecision("hello"), replyDecision("world")]]);
  const controller = new CodexMainAgentController(codex);

  await controller.decide(makeContext(["hello"]));
  await controller.decide(makeContext(["world"]));

  assert.equal(codex.threads.length, 1);
  assert.equal(codex.threads[0].inputs.length, 2);

  const [firstInput, secondInput] = codex.threads[0].inputs.map((entry) => entry.input);
  assert.match(firstInput, /"text": "hello"/);
  assert.doesNotMatch(firstInput, /"text": "world"/);
  assert.match(secondInput, /"text": "world"/);
  assert.doesNotMatch(secondInput, /"text": "hello"/);
});
