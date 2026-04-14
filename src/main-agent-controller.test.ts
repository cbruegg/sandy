import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ThreadOptions } from "@openai/codex-sdk";
import {
  buildMainAgentPrompt,
  buildMainAgentThreadOptions,
  CodexMainAgentController,
} from "./agent/main-agent-controller.js";
import type { ChannelFormatting, DecideContext } from "./types.js";

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

class RecordingThread {
  public readonly inputs: string[] = [];

  constructor(private readonly finalResponses: string[]) {}

  async run(input: string): Promise<{ finalResponse: string }> {
    this.inputs.push(input);
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

  const options = expectDefined(codex.startedThreads[0], "Expected started thread options.");
  assert.equal(options.approvalPolicy, "never");
  assert.equal(options.sandboxMode, "read-only");
  assert.equal(options.skipGitRepoCheck, true);
  assert.match(options.workingDirectory ?? "", /^.+sandy-main-agent-/);
  assert.match(expectDefined(codex.threads[0], "Expected thread.").inputs[0] ?? "", /Required JSON schema:/);
});

test("buildMainAgentPrompt includes the precise decision schema", () => {
  const prompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["hello"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    isInitialTurn: true,
  });

  assert.match(prompt, /Required JSON schema:/);
  assert.match(prompt, /"oneOf"/);
  assert.match(prompt, /"reply"/);
  assert.match(prompt, /"launch_task"/);
});

test("CodexMainAgentController sends only the entries provided for each decision", async () => {
  const codex = new RecordingCodexClient([[replyDecision("hello"), replyDecision("world")]]);
  const controller = new CodexMainAgentController(codex);

  await controller.decide(makeContext(["hello"]));
  await controller.decide(makeContext(["world"]));

  assert.equal(codex.threads.length, 1);
  const thread = expectDefined(codex.threads[0], "Expected thread.");
  assert.equal(thread.inputs.length, 2);

  const [firstInput, secondInput] = thread.inputs;
  assert.ok(firstInput);
  assert.ok(secondInput);
  assert.match(firstInput, /"text": "hello"/);
  assert.doesNotMatch(firstInput, /"text": "world"/);
  assert.match(secondInput, /"text": "world"/);
  assert.doesNotMatch(secondInput, /"text": "hello"/);
});

test("CodexMainAgentController retries when the model returns invalid JSON", async () => {
  const codex = new RecordingCodexClient([["not json", replyDecision("hello")]]);
  const controller = new CodexMainAgentController(codex);

  const decision = await controller.decide(makeContext(["hello"]));

  assert.equal(decision.action, "reply");
  const thread = expectDefined(codex.threads[0], "Expected thread.");
  assert.equal(thread.inputs.length, 2);
  assert.match(thread.inputs[1] ?? "", /Your last response was not valid JSON/);
});

test("CodexMainAgentController gives up after repeated validation failures", async () => {
  const codex = new RecordingCodexClient([["{}", "[]", "{\"action\":\"reply\"}"]]);
  const controller = new CodexMainAgentController(codex);

  await assert.rejects(
    controller.decide(makeContext(["hello"])),
    /Main agent failed to return a valid decision after 3 attempts/,
  );
  assert.equal(expectDefined(codex.threads[0], "Expected thread.").inputs.length, 3);
});
