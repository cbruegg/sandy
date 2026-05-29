import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Input } from "@openai/codex-sdk";
import {
  buildMainAgentPrompt,
  CodexMainAgentController,
} from "./main-agent-controller.js";
import type { SkillMetadata } from "../skills.js";
import type { ChannelFormatting, DecideContext } from "../types.js";
import type { HttpTokenConfig } from "../config.js";
import type {
  AgentClient,
  AppServerEvent,
  AuthRefreshCallback,
  ThreadStartParams,
} from "../codex-app-server-client/app-server-client.js";

const testFormatting: ChannelFormatting = {
  channelId: "telegram",
  markup: "telegram_html",
  allowedTags: ["b", "i", "code", "pre"],
  instructions: "Use simple Telegram HTML.",
};

const testSkills: SkillMetadata[] = [{
  name: "Adding task to Todoist",
  description: "When the user asks you to add a task to their Todoist, use this skill.",
}];

const testHttpTokens: Record<string, HttpTokenConfig> = {
  vid2text: {
    description: "Token for the video transcription API.",
    value: "secret",
  },
};

// ---- helpers for building AppServerEvent sequences ----

function buildTurnEvents(finalResponse: string): AppServerEvent[] {
  return [
    { method: "item/completed", params: { item: { type: "agentMessage", text: finalResponse, id: "item-1", phase: null, memoryCitation: null }, threadId: "thread-1", turnId: "turn-1", completedAtMs: 0 } },
    { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null } } },
  ];
}

function buildTurnEventsWithCompaction(finalResponse: string): AppServerEvent[] {
  return [
    { method: "item/started", params: { item: { type: "contextCompaction", id: "compaction-1" }, threadId: "thread-1", turnId: "turn-1", startedAtMs: 0 } },
    { method: "item/completed", params: { item: { type: "agentMessage", text: finalResponse, id: "item-1", phase: null, memoryCitation: null }, threadId: "thread-1", turnId: "turn-1", completedAtMs: 0 } },
    { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null } } },
  ];
}

// ---- test double ----

class FakeAppServerClient implements AgentClient {
  public readonly startedProfiles: ThreadStartParams[] = [];
  public readonly startedModels: Array<string | undefined> = [];
  public readonly threadInputs: string[][] = [];
  public readonly threadIds = new Map<string, string>();
  private nextThreadId = 1;
  private nextChatId = 0;

  constructor(private eventSequences: AppServerEvent[][] = []) {}

  async startThread(profile: ThreadStartParams, model?: string): Promise<string> {
    this.startedProfiles.push(profile);
    this.startedModels.push(model);
    const threadId = `thread-${this.nextThreadId++}`;
    this.threadIds.set(`chat-${this.nextChatId++}`, threadId);
    return threadId;
  }

  async *streamTurn(
    _threadId: string,
    input: Input,
    _onAuthRefresh: AuthRefreshCallback,
    _abortSignal?: AbortSignal,
  ): AsyncGenerator<AppServerEvent> {
    const promptText = (Array.isArray(input) && input[0]?.type === "text")
      ? input[0].text
      : "";
    this.threadInputs.push([promptText]);

    const events = this.eventSequences.shift() ?? [];
    for (const event of events) {
      yield event;
    }
  }

  close(): void {
    // noop
  }
}

function makeContext(texts: string[], chatId = "chat-1"): DecideContext {
  return {
    chatId,
    newVisibleEntries: texts.map((text, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      kind: index % 2 === 0 ? "user_message" : "main_agent_reply",
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

// ---- tests ----

test("CodexMainAgentController starts threads with read-only sandbox and working directory", async () => {
  const appServer = new FakeAppServerClient([buildTurnEvents(replyDecision("hello"))]);
  const controller = new CodexMainAgentController(appServer);

  await controller.decide(makeContext(["hello"]));

  assert.equal(appServer.startedProfiles.length, 1);
  assert.equal(appServer.startedProfiles[0]?.sandbox, "read-only");
  assert.equal(appServer.startedProfiles[0]?.personality, "none");
  assert.match(appServer.startedProfiles[0]?.cwd ?? "", /^.+sandy-main-agent-/);
});

test("CodexMainAgentController includes a model override when configured", async () => {
  const appServer = new FakeAppServerClient([buildTurnEvents(replyDecision("hello"))]);
  const controller = new CodexMainAgentController(appServer, "gpt-5.4-mini");

  await controller.decide(makeContext(["hello"]));

  assert.equal(appServer.startedModels[0], "gpt-5.4-mini");
});

test("buildMainAgentPrompt includes only the new visible entries for incremental turns without full instructions", () => {
  const initialPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["hello"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: true,
    skills: [],
    workerMcpServerIds: [],
    httpTokens: {},
  });
  const deltaPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["follow-up"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: false,
    skills: [],
    workerMcpServerIds: [],
    httpTokens: {},
  });

  assert.match(initialPrompt, /Visible chat entries for this decision:/);
  assert.match(deltaPrompt, /New visible chat entries since your last decision:/);
  assert.doesNotMatch(deltaPrompt, /Visible chat entries for this first decision:/);
  assert.match(initialPrompt, /telegram_html/);
  assert.match(initialPrompt, /"allowedTags"/);
});

test("buildMainAgentPrompt includes full instructions on incremental turn when includeFullInstructions is true", () => {
  const deltaPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["follow-up"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: true,
    skills: [],
    workerMcpServerIds: [],
    httpTokens: {},
  });

  assert.match(deltaPrompt, /Visible chat entries for this decision:/);
  assert.match(deltaPrompt, /You are Sandy's main orchestration controller/);
  assert.match(deltaPrompt, /retain prior visible context from earlier turns/);
});

test("buildMainAgentPrompt includes current date and time on every turn", () => {
  const initialPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["hello"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: true,
    skills: [],
    workerMcpServerIds: [],
    httpTokens: {},
  });
  const deltaPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["follow-up"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: false,
    skills: [],
    workerMcpServerIds: [],
    httpTokens: {},
  });

  assert.match(initialPrompt, /Current date and time: [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}/);
  assert.match(deltaPrompt, /Current date and time: [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}/);
});

test("buildMainAgentPrompt includes the precise decision schema", () => {
  const prompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["hello"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: true,
    skills: [],
    workerMcpServerIds: [],
    httpTokens: {},
  });

  assert.match(prompt, /Required JSON schema:/);
  assert.match(prompt, /"oneOf"/);
  assert.match(prompt, /"reply"/);
  assert.match(prompt, /"launch_task"/);
  assert.match(prompt, /"taskLanguage"/);
  assert.match(prompt, /"taskPolicy"/);
  assert.match(prompt, /autoApproveMcpServers/);
  assert.match(prompt, /autoApproveHttpTokens/);
});

test("CodexMainAgentController sends only the entries provided for each decision", async () => {
  const appServer = new FakeAppServerClient([
    buildTurnEvents(replyDecision("hello")),
    buildTurnEvents(replyDecision("world")),
  ]);
  const controller = new CodexMainAgentController(appServer);

  await controller.decide(makeContext(["hello"]));
  await controller.decide(makeContext(["world"]));

  assert.equal(appServer.threadInputs.length, 2);
  const [firstInput, secondInput] = appServer.threadInputs;
  assert.ok(firstInput);
  assert.ok(secondInput);
  assert.match(firstInput[0] ?? "", /"text": "hello"/);
  assert.doesNotMatch(firstInput[0] ?? "", /"text": "world"/);
  assert.match(secondInput[0] ?? "", /"text": "world"/);
  assert.doesNotMatch(secondInput[0] ?? "", /"text": "hello"/);
});

test("CodexMainAgentController retries when the model returns invalid JSON", async () => {
  const appServer = new FakeAppServerClient([
    buildTurnEvents("not json"),
    buildTurnEvents(replyDecision("hello")),
  ]);
  const controller = new CodexMainAgentController(appServer);

  const decision = await controller.decide(makeContext(["hello"]));

  assert.equal(decision.action, "reply");
  assert.equal(appServer.threadInputs.length, 2);
  assert.match(appServer.threadInputs[1]?.[0] ?? "", /Your last response was not valid JSON/);
});

test("CodexMainAgentController gives up after repeated validation failures", async () => {
  const appServer = new FakeAppServerClient([
    buildTurnEvents("{}"),
    buildTurnEvents("[]"),
    buildTurnEvents('{"action":"reply"}'), // valid Zod schema but missing replyText
  ]);
  const controller = new CodexMainAgentController(appServer);

  await assert.rejects(
    controller.decide(makeContext(["hello"])),
    /Main agent failed to return a valid decision after 3 attempts/,
  );
  assert.equal(appServer.threadInputs.length, 3);
});

test("CodexMainAgentController passes a configured model override into new threads", async () => {
  const appServer = new FakeAppServerClient([buildTurnEvents(replyDecision("hello"))]);
  const controller = new CodexMainAgentController(appServer, "gpt-5.4-mini");

  await controller.decide(makeContext(["hello"]));

  assert.equal(appServer.startedModels[0], "gpt-5.4-mini");
});

test("buildMainAgentPrompt includes configured skill metadata on every turn", () => {
  const initialPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["add milk to my shopping list"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: true,
    skills: testSkills,
    workerMcpServerIds: [],
    httpTokens: {},
  });
  const deltaPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["another request"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: false,
    skills: testSkills,
    workerMcpServerIds: [],
    httpTokens: {},
  });

  assert.match(initialPrompt, /Configured skills available to sub-agents:/);
  assert.match(initialPrompt, /Adding task to Todoist/);
  assert.match(initialPrompt, /must launch a sub-agent instead of replying directly/);
  assert.match(deltaPrompt, /Configured skills available to sub-agents:/);
  assert.match(deltaPrompt, /Adding task to Todoist/);
});

test("buildMainAgentPrompt does not include skill body text below the frontmatter", () => {
  const prompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["add bread"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: true,
    skills: testSkills,
    workerMcpServerIds: [],
    httpTokens: {},
  });

  assert.doesNotMatch(prompt, /Use the Todoist MCP/);
  assert.doesNotMatch(prompt, /Alexa Shopping List/);
});

test("buildMainAgentPrompt includes configured MCP server ids only when includeFullInstructions is true", () => {
  const initialPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["check my tasks"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: true,
    skills: [],
    workerMcpServerIds: ["github", "todoist"],
    httpTokens: {},
  });
  const deltaPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["follow up"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: false,
    skills: [],
    workerMcpServerIds: ["github", "todoist"],
    httpTokens: {},
  });

  assert.match(initialPrompt, /Configured MCP servers available to sub-agents:/);
  assert.match(initialPrompt, /- github/);
  assert.match(initialPrompt, /- todoist/);
  assert.doesNotMatch(deltaPrompt, /Configured MCP servers available to sub-agents:/);
});

test("buildMainAgentPrompt includes MCP server ids on incremental turn when includeFullInstructions is true", () => {
  const prompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["follow up"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: true,
    skills: [],
    workerMcpServerIds: ["github", "todoist"],
    httpTokens: {},
  });

  assert.match(prompt, /Configured MCP servers available to sub-agents:/);
  assert.match(prompt, /- github/);
  assert.match(prompt, /- todoist/);
});

test("buildMainAgentPrompt omits the MCP section when no servers are configured", () => {
  const prompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["hello"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: true,
    skills: [],
    workerMcpServerIds: [],
    httpTokens: {},
  });

  assert.doesNotMatch(prompt, /Configured MCP servers available to sub-agents:/);
});

test("buildMainAgentPrompt includes configured HTTP token ids and descriptions when includeFullInstructions is true", () => {
  const initialPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["transcribe this video"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: true,
    skills: [],
    workerMcpServerIds: [],
    httpTokens: testHttpTokens,
  });
  const deltaPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["follow up"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: false,
    skills: [],
    workerMcpServerIds: [],
    httpTokens: testHttpTokens,
  });

  assert.match(initialPrompt, /Configured HTTP tokens available to sub-agents:/);
  assert.match(initialPrompt, /vid2text: Token for the video transcription API\./);
  assert.doesNotMatch(deltaPrompt, /Configured HTTP tokens available to sub-agents:/);
});

test("buildMainAgentPrompt includes Sandy host-integration tools when includeFullInstructions is true", () => {
  const initialPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["send me a file"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: true,
    skills: [],
    workerMcpServerIds: [],
    httpTokens: {},
  });
  const deltaPrompt = buildMainAgentPrompt({
    newVisibleEntries: makeContext(["follow up"]).newVisibleEntries,
    activeTask: null,
    channelFormatting: testFormatting,
    includeFullInstructions: false,
    skills: [],
    workerMcpServerIds: [],
    httpTokens: {},
  });

  assert.match(initialPrompt, /MCP server "sandy" available to the worker\/sub-agent exposes these host-integration tools:/);
  assert.match(initialPrompt, /send_file_to_channel/);
  assert.doesNotMatch(deltaPrompt, /MCP server "sandy" exposes these host-integration tools:/);
});

// ---- compaction detection tests ----

test("CodexMainAgentController detects compaction events and triggers instruction refresh on next turn", async () => {
  const appServer = new FakeAppServerClient([
    buildTurnEvents(replyDecision("hello")),
    buildTurnEvents(replyDecision("world")),
    buildTurnEventsWithCompaction(replyDecision("compacted turn")),
    buildTurnEvents(replyDecision("after compaction")),
  ]);
  const controller = new CodexMainAgentController(appServer);

  // Turn 1: initial, should have full instructions
  await controller.decide(makeContext(["msg1"]));
  // Turn 2: normal incremental, no full instructions
  await controller.decide(makeContext(["msg2"]));
  // Turn 3: during this turn, compaction events are observed
  await controller.decide(makeContext(["msg3"]));
  // Turn 4: should have full instructions because compaction was detected on turn 3
  await controller.decide(makeContext(["msg4"]));

  assert.equal(appServer.threadInputs.length, 4);

  // Turn 1: initial → full instructions (visible chat entries for this decision)
  assert.match(appServer.threadInputs[0]?.[0] ?? "", /Visible chat entries for this decision:/);
  assert.match(appServer.threadInputs[0]?.[0] ?? "", /You are Sandy's main orchestration controller/);

  // Turn 2: normal incremental → no full instructions
  assert.match(appServer.threadInputs[1]?.[0] ?? "", /New visible chat entries since your last decision:/);
  assert.match(appServer.threadInputs[1]?.[0] ?? "", /Continue acting as Sandy's main orchestration controller/);

  // Turn 3: compaction happens during this turn → still normal incremental (flag set for next turn)
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /New visible chat entries since your last decision:/);

  // Turn 4: flag was set → full instructions reappear
  assert.match(appServer.threadInputs[3]?.[0] ?? "", /Visible chat entries for this decision:/);
  assert.match(appServer.threadInputs[3]?.[0] ?? "", /retain prior visible context from earlier turns/);
});

test("CodexMainAgentController does not re-include full instructions on subsequent normal turns after refresh", async () => {
  const appServer = new FakeAppServerClient([
    buildTurnEvents(replyDecision("hello")),
    buildTurnEventsWithCompaction(replyDecision("compacted")),
    buildTurnEvents(replyDecision("after refresh")),
    buildTurnEvents(replyDecision("normal again")),
  ]);
  const controller = new CodexMainAgentController(appServer);

  await controller.decide(makeContext(["msg1"]));
  await controller.decide(makeContext(["msg2"])); // compaction detected here
  await controller.decide(makeContext(["msg3"])); // full instructions due to flag
  await controller.decide(makeContext(["msg4"])); // back to normal

  assert.equal(appServer.threadInputs.length, 4);

  // Turn 3: refresh → full instructions
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /Visible chat entries for this decision:/);
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /You are Sandy's main orchestration controller/);

  // Turn 4: back to normal incremental
  assert.match(appServer.threadInputs[3]?.[0] ?? "", /New visible chat entries since your last decision:/);
  assert.match(appServer.threadInputs[3]?.[0] ?? "", /Continue acting as Sandy's main orchestration controller/);
});

test("CodexMainAgentController includes Sandy tools and MCP configs again after compaction refresh", async () => {
  const appServer = new FakeAppServerClient([
    buildTurnEvents(replyDecision("hello")),
    buildTurnEventsWithCompaction(replyDecision("compacted")),
    buildTurnEvents(replyDecision("refreshed")),
  ]);
  const controller = new CodexMainAgentController(
    appServer,
    null,
    () => testSkills,
    ["github", "todoist"],
    testHttpTokens,
  );

  await controller.decide(makeContext(["msg1"]));
  await controller.decide(makeContext(["msg2"])); // compaction detected
  await controller.decide(makeContext(["msg3"])); // full instructions

  assert.equal(appServer.threadInputs.length, 3);

  // Turn 2 (compaction happens): should NOT include full instructions
  assert.match(appServer.threadInputs[1]?.[0] ?? "", /New visible chat entries since your last decision:/);
  assert.doesNotMatch(appServer.threadInputs[1]?.[0] ?? "", /Configured MCP servers available to sub-agents:/);

  // Turn 3 (refresh): should include full instructions with MCP/token/tool config
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /Visible chat entries for this decision:/);
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /Configured MCP servers available to sub-agents:/);
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /- github/);
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /- todoist/);
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /Configured HTTP tokens available to sub-agents:/);
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /vid2text: Token for the video transcription API\./);
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /send_file_to_channel/);
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /Configured skills available to sub-agents:/);
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /Adding task to Todoist/);
});

test("CodexMainAgentController detects context_compaction in item events", async () => {
  // A single context_compaction event should trigger the flag
  const appServer = new FakeAppServerClient([
    buildTurnEvents(replyDecision("hello")),
    buildTurnEventsWithCompaction(replyDecision("turn after compaction")),
    buildTurnEvents(replyDecision("refreshed")),
  ]);
  const controller = new CodexMainAgentController(appServer);

  await controller.decide(makeContext(["msg1"]));
  await controller.decide(makeContext(["msg2"])); // context_compaction event → flag set
  await controller.decide(makeContext(["msg3"])); // should have full instructions

  assert.match(appServer.threadInputs[2]?.[0] ?? "", /Visible chat entries for this decision:/);
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /You are Sandy's main orchestration controller/);
});

test("CodexMainAgentController clears the instruction refresh flag after exactly one turn", async () => {
  // Compaction happens on the first turn. Flag is set.
  // Next turn includes full instructions and clears the flag.
  // The turn after that returns to normal incremental mode.
  const appServer = new FakeAppServerClient([
    buildTurnEventsWithCompaction(replyDecision("compacted turn")),
    buildTurnEvents(replyDecision("turn after compaction")),
    buildTurnEvents(replyDecision("turn after refresh")),
  ]);
  const controller = new CodexMainAgentController(appServer);

  await controller.decide(makeContext(["msg1"])); // compaction detected → flag set
  await controller.decide(makeContext(["msg2"])); // flag consumed → full instructions
  await controller.decide(makeContext(["msg3"])); // flag cleared → normal incremental

  assert.equal(appServer.threadInputs.length, 3);

  // Turn 1: initial (first call, isInitialTurn = true)
  assert.match(appServer.threadInputs[0]?.[0] ?? "", /Visible chat entries for this decision:/);
  // Turn 2: flag was set by compaction on turn 1 → full instructions
  assert.match(appServer.threadInputs[1]?.[0] ?? "", /Visible chat entries for this decision:/);
  assert.match(appServer.threadInputs[1]?.[0] ?? "", /retain prior visible context from earlier turns/);
  // Turn 3: flag cleared → normal incremental
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /New visible chat entries since your last decision:/);
  assert.match(appServer.threadInputs[2]?.[0] ?? "", /Continue acting as Sandy's main orchestration controller/);
});
