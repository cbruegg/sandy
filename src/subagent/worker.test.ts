import { test } from "bun:test";
import assert from "node:assert/strict";
import { type Input, type Thread } from "@openai/codex-sdk";
import { messages } from "../messages-to-user.js";
import { AppServerWorkerSession, type StreamTurnResult } from "./worker-app-server.js";
import {
  buildTaskBecameInteractiveInput,
  buildInitialTaskInput,
  buildInitialTaskInputWithCapabilities,
  buildPrivilegeResolutionInput,
  buildTaskSummaryInput,
  createWorkerCommandProcessor,
  streamAppServerTurn,
  streamTurn,
} from "./worker.js";
import type { ChannelFormatting, HostCommand, PrivilegeResolutionResult, SubAgentEvent } from "../types.js";
import { parseSubAgentEvent } from "../types.js";
import { parseWorkerToolPayload } from "./worker-tools.js";
import { sharedWorkspaceMountPath } from "../shared-workspace.js";

const testFormatting: ChannelFormatting = {
  channelId: "telegram",
  markup: "telegram_markdown",
  allowedTags: [],
  instructions: "Use simple Markdown.",
};

function createAppServerSessionStarter(session: {
  streamTurn: (input: Input, abortSignal?: AbortSignal) => Promise<StreamTurnResult>;
  steerActiveTurn?: (input: Input) => Promise<boolean>;
  emitTaskSummary: () => Promise<void>;
  close: () => void;
  cancelPendingAuthRefresh: () => void;
  handleAuthRefreshResult: (tokens: unknown) => void;
}): typeof AppServerWorkerSession.start {
  return async () => ({
    steerActiveTurn: async (input: Input) => await (session.steerActiveTurn?.(input) ?? false),
    ...session,
  }) as unknown as AppServerWorkerSession;
}

test("buildInitialTaskInput tells the sub-agent where the shared workspace is", () => {
  const formatting: ChannelFormatting = {
    channelId: "telegram",
    markup: "telegram_markdown",
    allowedTags: [],
    instructions: "Use simple Markdown.",
  };
  const input = buildInitialTaskInput(
    "Inspect the repository and leave a summary file.",
    "English",
    formatting,
    [{ tokenId: "vid2text", description: "Token for the video transcription API." }],
    "/usr/local/bin/sandy-http-proxy-exec",
  );

  const inputText = Array.isArray(input) && input[0]?.type === "text" ? input[0].text : "";
  assert.match(inputText, /\/workspace\/share/);
  assert.match(inputText, /shared workspace is mounted/);
  assert.match(inputText, /send the user-visible text first and then call the tool separately/i);
  assert.match(inputText, /MCP server "sandy" exposes additional host-integration tools/i);
  assert.match(inputText, /Use MCP tool discovery to list its tools/i);
  assert.match(inputText, /simple Markdown/i);
  assert.match(inputText, /Use English for user-visible replies unless the host provides a later instruction that overrides it\./);
  assert.match(inputText, /Configured HTTP tokens available to this task:/);
  assert.match(inputText, /vid2text: Token for the video transcription API\./);
  assert.match(inputText, /sandy\.request_http_token/);
  assert.match(inputText, /do not ask the user in plain text/i);
  assert.match(inputText, /sandy-http-proxy-exec/);
  assert.match(inputText, /always run it through \/usr\/local\/bin\/sandy-http-proxy-exec/i);
  assert.match(inputText, /placeholder will not be injected/i);
  assert.match(inputText, /not limited to curl/i);
  assert.match(inputText, /any executable that respects proxy environment variables/i);
  assert.match(inputText, /Example pattern: \/usr\/local\/bin\/sandy-http-proxy-exec curl/);
  assert.match(inputText, /leave a summary file\./);
});

test("buildInitialTaskInputWithCapabilities includes package-manager guidance when detected during init", () => {
  const input = buildInitialTaskInputWithCapabilities(
    "Install dependencies if needed.",
    "Spanish",
    null,
    [
      "Detected JavaScript runtime and package manager: Bun.",
      "Use bun run, bun test, bun install, and bunx for JavaScript or TypeScript tasks in this container.",
      "Detected package manager: zypper.",
      "You can install or update openSUSE Tumbleweed packages in this container with zypper when needed.",
      "Detected package manager: Homebrew.",
      "Use brew for fast-moving CLI and developer tools; the container's brew command runs under the dedicated linuxbrew user automatically.",
    ],
    [{ tokenId: "vid2text", description: "Token for the video transcription API." }],
    "/usr/local/bin/sandy-http-proxy-exec",
  );

  assert.match(input, /Detected JavaScript runtime and package manager: Bun\./);
  assert.match(input, /Use Spanish for user-visible replies unless the host provides a later instruction that overrides it\./);
  assert.match(input, /Use bun run, bun test, bun install, and bunx/);
  assert.match(input, /Detected package manager: zypper\./);
  assert.match(input, /openSUSE Tumbleweed packages/);
  assert.match(input, /Detected package manager: Homebrew\./);
  assert.match(input, /brew command runs under the dedicated linuxbrew user/);
  assert.match(input, /HTTP_PROXY\/HTTPS_PROXY are set only for that process/);
  assert.match(input, /must use \/usr\/local\/bin\/sandy-http-proxy-exec unless the host explicitly tells you otherwise/i);
});

test("buildPrivilegeResolutionInput explains the host privilege result to the sub-agent", () => {
  const result: PrivilegeResolutionResult = {
    requestId: "req-1",
    outcome: "approved",
    message: "Copied /tmp/input.txt into the shared workspace.",
  };

  const input = buildPrivilegeResolutionInput(result);

  assert.match(input, /req-1/);
  assert.match(input, /approved/);
  assert.match(input, /Copied \/tmp\/input.txt into the shared workspace\./);
  assert.match(input, /Continue the task from here\./);
});

test("buildTaskBecameInteractiveInput tells the worker that the task is now visible", () => {
  const input = buildTaskBecameInteractiveInput();

  assert.match(input, /scheduled job task is now interactive/i);
  assert.match(input, /user can now see subsequent user-visible output/i);
});

test("buildTaskSummaryInput requests a host-facing handoff summary", () => {
  const input = buildTaskSummaryInput();

  assert.match(input, /host-facing handoff summary/);
  assert.match(input, /Do not emit any Sandy tool calls/);
  assert.match(input, /Artifacts:/);
  assert.match(input, /Potential memories:/);
});

test("buildInitialTaskInput includes current date and time", () => {
  const formatting: ChannelFormatting = {
    channelId: "telegram",
    markup: "telegram_markdown",
    allowedTags: [],
    instructions: "Use simple Markdown.",
  };
  const input = buildInitialTaskInput(
    "Inspect the repository and leave a summary file.",
    "English",
    formatting,
  );

  const inputText = Array.isArray(input) && input[0]?.type === "text" ? input[0].text : "";
  assert.match(inputText, /Current date and time: [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}/);
});

test("buildInitialTaskInput always returns a user-input sequence", () => {
  const input = buildInitialTaskInput("Inspect the repository.", "English", testFormatting);
  const inputText = Array.isArray(input) && input[0]?.type === "text" ? input[0].text : "";

  assert.equal(Array.isArray(input), true);
  assert.deepEqual(input, [{ type: "text", text: inputText }]);
  assert.match(inputText, /Inspect the repository\./);
});

test("buildInitialTaskInput uses the SDK local_image variant for images", () => {
  const input = buildInitialTaskInput(
    "Inspect the repository.",
    "English",
    testFormatting,
    [],
    null,
    [{ sharePath: "/workspace/share/cover.png", fileName: "cover.png" }],
  );

  assert.deepEqual(input.at(-1), { type: "local_image", path: "/workspace/share/cover.png" });
});

test("worker processes follow-up commands after start_task initialization finishes", async () => {
  const { promise: sessionReady, resolve: resolveSession } = Promise.withResolvers<void>();
  const sentEvents: SubAgentEvent[] = [];
  const turnInputs: Input[] = [];
  const startTaskCommand: Extract<HostCommand, { type: "start_task" }> = {
    type: "start_task",
    taskId: "task-1",
    taskBrief: "Add the track to the DJ collection.",
    input: { text: "Initial request", images: [] },
    taskLanguage: "English",
    config: {
      auth: { mode: "ambient_auth_file" },
      codexModel: null,
      channelFormatting: testFormatting,
      httpTokens: [],
      httpProxyWrapper: null,
    },
    environment: {},
    codexConfigToml: null,
    httpProxyUrl: null,
  };
  const followUpCommand: Extract<HostCommand, { type: "user_message" }> = {
    type: "user_message",
    input: { text: "Use https://example.com/set", images: [] },
  };
  const processor = createWorkerCommandProcessor({
    sendEvent: (event) => sentEvents.push(event),
    env: { SANDY_CODEX_PATH: "/usr/local/bin/codex" },
    applyWorkerCodexConfigPatch: async () => {},
    startAppServerWorkerSession: async () => {
      await sessionReady;
      return {
        async streamTurn(input: Input) {
          turnInputs.push(input);
          return { sawTerminalError: false };
        },
        async steerActiveTurn() {
          return false;
        },
        async emitTaskSummary() {},
        close() {},
        cancelPendingAuthRefresh() {},
        handleAuthRefreshResult() {},
      } as unknown as AppServerWorkerSession;
    },
    onShutdown: () => {},
  });

  const startPromise = processor.handleLine(JSON.stringify(startTaskCommand));
  const followUpPromise = processor.handleLine(JSON.stringify(followUpCommand));
  await Promise.resolve();

  assert.equal(sentEvents.length, 0);
  assert.equal(turnInputs.length, 0);

  resolveSession();
  await startPromise;
  await followUpPromise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sentEvents.some((event) => event.type === "task_error"), false);
  assert.equal(turnInputs.length, 2);
  assert.equal(Array.isArray(turnInputs[0]), true);
  assert.deepEqual(turnInputs[1], [{ type: "text", text: "Use https://example.com/set" }]);
  assert.match(JSON.stringify(turnInputs[0]), /Add the track to the DJ collection/);
});

test("worker requires SANDY_CODEX_PATH for app-server tasks", async () => {
  const sentEvents: SubAgentEvent[] = [];
  const processor = createWorkerCommandProcessor({
    sendEvent: (event) => sentEvents.push(event),
    env: {},
    applyWorkerCodexConfigPatch: async () => {},
    startAppServerWorkerSession: async () => {
      throw new Error("startAppServerWorkerSession should not be called");
    },
    onShutdown: () => {},
  });

  await processor.handleLine(JSON.stringify({
    type: "start_task",
    taskId: "task-1",
    taskBrief: "Inspect the collection.",
    input: { text: "Initial request", images: [] },
    taskLanguage: "English",
    config: {
      auth: {
        mode: "external_tokens",
        tokens: {
          accessToken: "access-token",
          chatgptAccountId: "acct-123",
          chatgptPlanType: "plus",
        },
      },
      codexModel: null,
      channelFormatting: testFormatting,
      httpTokens: [],
      httpProxyWrapper: null,
    },
    environment: {},
    codexConfigToml: null,
    httpProxyUrl: null,
  } satisfies Extract<HostCommand, { type: "start_task" }>));

  assert.deepEqual(sentEvents, [{
    type: "task_error",
    message: "SANDY_CODEX_PATH must be configured for app-server workers.",
  }]);
});

test("worker starts ambient app-server auth for api key mode and exports CODEX_API_KEY", async () => {
  const sessionStarts: Array<Parameters<typeof AppServerWorkerSession.start>[0]> = [];
  const env: NodeJS.ProcessEnv = {
    SANDY_CODEX_PATH: "/usr/local/bin/codex",
  };
  const processor = createWorkerCommandProcessor({
    sendEvent: () => {},
    env,
    applyWorkerCodexConfigPatch: async () => {},
    startAppServerWorkerSession: async (options) => {
      sessionStarts.push(options);
      return {
        async streamTurn() {
          return { sawTerminalError: false };
        },
        async emitTaskSummary() {},
        close() {},
        cancelPendingAuthRefresh() {},
        handleAuthRefreshResult() {},
      } as unknown as AppServerWorkerSession;
    },
    onShutdown: () => {},
  });

  await processor.handleLine(JSON.stringify({
    type: "start_task",
    taskId: "task-1",
    taskBrief: "Inspect the collection.",
    input: { text: "Initial request", images: [] },
    taskLanguage: "English",
    config: {
      auth: { mode: "ambient_api_key", openAiApiKey: "api-key-123" },
      codexModel: null,
      channelFormatting: testFormatting,
      httpTokens: [],
      httpProxyWrapper: null,
    },
    environment: {},
    codexConfigToml: null,
    httpProxyUrl: null,
  } satisfies Extract<HostCommand, { type: "start_task" }>));

  assert.equal(env["CODEX_API_KEY"], "api-key-123");
  assert.equal(sessionStarts.length, 1);
  assert.equal(sessionStarts[0]?.codexPath, "/usr/local/bin/codex");
  assert.deepEqual(sessionStarts[0]?.authMode, { kind: "ambient" });
  assert.equal(sessionStarts[0]?.model, undefined);
});

test("worker passes image attachments through app-server user_message turns", async () => {
  const turnInputs: Input[] = [];
  const processor = createWorkerCommandProcessor({
    sendEvent: () => {},
    env: { SANDY_CODEX_PATH: "/usr/local/bin/codex" },
    applyWorkerCodexConfigPatch: async () => {},
    startAppServerWorkerSession: createAppServerSessionStarter({
      async streamTurn(input) {
        turnInputs.push(input);
        return { sawTerminalError: false };
      },
      async emitTaskSummary() {},
      close() {},
      cancelPendingAuthRefresh() {},
      handleAuthRefreshResult() {},
    }),
    onShutdown: () => {},
  });

  await processor.handleLine(JSON.stringify({
    type: "start_task",
    taskId: "task-1",
    taskBrief: "Inspect the collection.",
    input: {
      text: "Initial request",
      images: [{ sharePath: "/workspace/share/cover.png", fileName: "cover.png" }],
    },
    taskLanguage: "English",
    config: {
      auth: { mode: "ambient_auth_file" },
      codexModel: null,
      channelFormatting: testFormatting,
      httpTokens: [],
      httpProxyWrapper: null,
    },
    environment: {},
    codexConfigToml: null,
    httpProxyUrl: null,
  } satisfies Extract<HostCommand, { type: "start_task" }>));

  await processor.handleLine(JSON.stringify({
    type: "user_message",
    input: {
      text: "Look at this image too",
      images: [{ sharePath: "/workspace/share/photo.jpg", fileName: "photo.jpg" }],
    },
  } satisfies Extract<HostCommand, { type: "user_message" }>));

  assert.equal(turnInputs.length, 2);
  const initialInputJson = JSON.stringify(turnInputs[0]);
  assert.match(initialInputJson, /"type":"text"/);
  assert.match(initialInputJson, /Initial request/);
  assert.match(initialInputJson, /"type":"local_image"/);
  assert.match(initialInputJson, /"path":"\/workspace\/share\/cover\.png"/);
  assert.deepEqual(turnInputs[1], [
    { type: "text", text: "Look at this image too" },
    { type: "local_image", path: "/workspace/share/photo.jpg" },
  ]);
});

test("worker steers user messages into the active app-server turn", async () => {
  const turnInputs: Input[] = [];
  const steerInputs: Input[] = [];
  const { promise: releaseInitialTurn, resolve: resolveInitialTurn } = Promise.withResolvers<void>();
  let activeTurnRunning = false;
  const processor = createWorkerCommandProcessor({
    sendEvent: () => {},
    env: { SANDY_CODEX_PATH: "/usr/local/bin/codex" },
    applyWorkerCodexConfigPatch: async () => {},
    startAppServerWorkerSession: createAppServerSessionStarter({
      async streamTurn(input) {
        turnInputs.push(input);
        activeTurnRunning = true;
        await releaseInitialTurn;
        activeTurnRunning = false;
        return { sawTerminalError: false };
      },
      async steerActiveTurn(input) {
        if (!activeTurnRunning) {
          return false;
        }
        steerInputs.push(input);
        return true;
      },
      async emitTaskSummary() {},
      close() {},
      cancelPendingAuthRefresh() {},
      handleAuthRefreshResult() {},
    }),
    onShutdown: () => {},
  });

  await processor.handleLine(JSON.stringify({
    type: "start_task",
    taskId: "task-1",
    taskBrief: "Inspect the collection.",
    input: { text: "Initial request", images: [] },
    taskLanguage: "English",
    config: {
      auth: { mode: "ambient_auth_file" },
      codexModel: null,
      channelFormatting: testFormatting,
      httpTokens: [],
      httpProxyWrapper: null,
    },
    environment: {},
    codexConfigToml: null,
    httpProxyUrl: null,
  } satisfies Extract<HostCommand, { type: "start_task" }>));
  await new Promise((resolve) => setImmediate(resolve));

  await processor.handleLine(JSON.stringify({
    type: "user_message",
    input: { text: "Focus on the failing test first.", images: [] },
  } satisfies Extract<HostCommand, { type: "user_message" }>));

  assert.equal(turnInputs.length, 1);
  assert.deepEqual(steerInputs, [[{ type: "text", text: "Focus on the failing test first." }]]);

  resolveInitialTurn();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(turnInputs.length, 1);
});

test("worker turns a task_became_interactive host command into follow-up input", async () => {
  const turnInputs: Input[] = [];
  const processor = createWorkerCommandProcessor({
    sendEvent: () => {},
    env: { SANDY_CODEX_PATH: "/usr/local/bin/codex" },
    applyWorkerCodexConfigPatch: async () => {},
    startAppServerWorkerSession: createAppServerSessionStarter({
      async streamTurn(input) {
        turnInputs.push(input);
        return { sawTerminalError: false };
      },
      async emitTaskSummary() {},
      close() {},
      cancelPendingAuthRefresh() {},
      handleAuthRefreshResult() {},
    }),
    onShutdown: () => {},
  });

  await processor.handleLine(JSON.stringify({
    type: "start_task",
    taskId: "task-1",
    taskBrief: "Inspect the collection.",
    input: { text: "Initial request", images: [] },
    taskLanguage: "English",
    config: {
      auth: { mode: "ambient_auth_file" },
      codexModel: null,
      channelFormatting: testFormatting,
      httpTokens: [],
      httpProxyWrapper: null,
    },
    environment: {},
    codexConfigToml: null,
    httpProxyUrl: null,
  } satisfies Extract<HostCommand, { type: "start_task" }>));

  await processor.handleLine(JSON.stringify({
    type: "task_became_interactive",
  } satisfies Extract<HostCommand, { type: "task_became_interactive" }>));

  assert.equal(turnInputs.length, 2);
  assert.deepEqual(turnInputs[1], [{ type: "text", text: buildTaskBecameInteractiveInput() }]);
});

test("mcpToolProgress includes payloads for completed MCP calls", () => {
  assert.equal(
    messages.mcpToolProgress("completed", "filesystem", "read_file", { path: "/tmp/report.txt" }),
    'MCP completed: filesystem.read_file {"path":"/tmp/report.txt"}',
  );
});

test("commandProgress formats command execution updates", () => {
  assert.equal(
    messages.commandProgress("completed", "npm test", null),
    "Command completed: npm test",
  );
  assert.equal(
    messages.commandProgress("completed", "npm test", testFormatting),
    "Command completed: `npm test`",
  );
});

test("nextPlannedStep formats todo-list progress updates", () => {
  assert.equal(
    messages.nextPlannedStep("Run the final verification"),
    "Next planned step: Run the final verification",
  );
});

test("parseWorkerToolPayload parses privilege-escalated worker tools", () => {
  const payload = parseWorkerToolPayload("copy_out_of_share", {
    sourcePath: `${sharedWorkspaceMountPath}/random_numbers.txt`,
    targetPath: "~/Downloads/random_numbers.txt",
    reason: "Deliver the generated file.",
  });

  assert.deepEqual(payload, {
    type: "copy_out_of_share",
    sourcePath: `${sharedWorkspaceMountPath}/random_numbers.txt`,
    targetPath: "~/Downloads/random_numbers.txt",
    reason: "Deliver the generated file.",
  });
});

test("parseWorkerToolPayload throws a helpful error for invalid payloads", () => {
  assert.throws(
    () => parseWorkerToolPayload("copy_out_of_share", {
      source: "random_numbers.txt",
      destinationPath: "~/Downloads/random_numbers.txt",
    }),
    /sourcePath|targetPath/,
  );
});

test("parseWorkerToolPayload parses terminate_task", () => {
  const payload = parseWorkerToolPayload("terminate_task", {});

  assert.deepEqual(payload, {
    type: "terminate_task",
  });
});

test("parseSubAgentEvent accepts task-summary events", () => {
  const event = parseSubAgentEvent('{"type":"task_summary","summary":"Task completed successfully"}');

  assert.deepEqual(event, {
    type: "task_summary",
    summary: "Task completed successfully",
  });
});

test("streamTurn ignores empty assistant messages", async () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const mockWrite: typeof process.stdout.write = (
    chunk,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    if (typeof encodingOrCallback === "function") {
      encodingOrCallback();
    } else {
      callback?.();
    }
    return true;
  };
  process.stdout.write = mockWrite;

  try {
    const thread = {
      async runStreamed() {
        return {
          events: (async function* () {
            yield {
              type: "item.completed",
              item: {
                type: "agent_message",
                text: "",
              },
            };
          })(),
        };
      },
    } as unknown as Thread;

    const sawTerminalError = await streamTurn(thread, "Inspect the reel.");

    assert.equal(sawTerminalError.sawTerminalError, false);
    assert.deepEqual(writes, []);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("worker emits task_done only after mark_finished", async () => {
  const sentEvents: SubAgentEvent[] = [];
  const processor = createWorkerCommandProcessor({
    sendEvent: (event) => sentEvents.push(event),
    env: { SANDY_CODEX_PATH: "/usr/local/bin/codex" },
    applyWorkerCodexConfigPatch: async () => {},
    startAppServerWorkerSession: createAppServerSessionStarter({
      async streamTurn() {
        return { sawTerminalError: false };
      },
      async emitTaskSummary() {
        sentEvents.push({
          type: "task_summary",
          summary: "Summary for the host.",
        });
      },
      close() {},
      cancelPendingAuthRefresh() {},
      handleAuthRefreshResult() {},
    }),
    onShutdown: () => {},
  });

  await processor.handleLine(JSON.stringify({
    type: "start_task",
    taskId: "task-1",
    taskBrief: "Inspect the collection.",
    input: { text: "Initial request", images: [] },
    taskLanguage: "English",
    config: {
      auth: { mode: "ambient_auth_file" },
      codexModel: null,
      channelFormatting: testFormatting,
      httpTokens: [],
      httpProxyWrapper: null,
    },
    environment: {},
    codexConfigToml: null,
    httpProxyUrl: null,
  } satisfies Extract<HostCommand, { type: "start_task" }>));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sentEvents.some((event) => event.type === "task_done"), false);

  await processor.handleLine(JSON.stringify({
    type: "mark_finished",
  } satisfies Extract<HostCommand, { type: "mark_finished" }>));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sentEvents.slice(-2), [
    {
      type: "task_summary",
      summary: "Summary for the host.",
    },
    {
      type: "task_done",
    },
  ]);
});

test("streamAppServerTurn emits completed assistant messages", async () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const mockWrite: typeof process.stdout.write = (
    chunk,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    if (typeof encodingOrCallback === "function") {
      encodingOrCallback();
    } else {
      callback?.();
    }
    return true;
  };
  process.stdout.write = mockWrite;

  try {
    const appServer = {
      async steerActiveTurn() {
        return false;
      },
      async *streamTurn() {
        yield { method: "item/completed", params: { item: { type: "agentMessage", id: "item-1", text: "Using the Todoist skill.", phase: null, memoryCitation: null }, threadId: "thread-1", turnId: "turn-1", completedAtMs: 0 } };
        yield { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null } } };
      },
    };

    const sawTerminalError = await streamAppServerTurn({
      appServer: appServer as Parameters<typeof streamAppServerTurn>[0]["appServer"],
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
      onAuthRefresh: async () => {
        throw new Error("unexpected auth refresh");
      },
    });

    const events = writes.map((entry) => JSON.parse(entry.trim()) as SubAgentEvent);
    assert.equal(sawTerminalError.sawTerminalError, false);
    assert.deepEqual(events, [{ type: "assistant_output", text: "Using the Todoist skill." }]);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("streamAppServerTurn ignores blank completed assistant messages", async () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const mockWrite: typeof process.stdout.write = (
    chunk,
    encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    if (typeof encodingOrCallback === "function") {
      encodingOrCallback();
    } else {
      callback?.();
    }
    return true;
  };
  process.stdout.write = mockWrite;

  try {
    const appServer = {
      async steerActiveTurn() {
        return false;
      },
      async *streamTurn() {
        yield { method: "item/completed", params: { item: { type: "agentMessage", id: "item-1", text: "   ", phase: null, memoryCitation: null }, threadId: "thread-1", turnId: "turn-1", completedAtMs: 0 } };
        yield { method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", items: [], itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null } } };
      },
    };

    const sawTerminalError = await streamAppServerTurn({
      appServer: appServer as Parameters<typeof streamAppServerTurn>[0]["appServer"],
      threadId: "thread-1",
      input: [{ type: "text", text: "hello" }],
      onAuthRefresh: async () => {
        throw new Error("unexpected auth refresh");
      },
    });

    const events = writes.map((entry) => JSON.parse(entry.trim()) as SubAgentEvent);
    assert.equal(sawTerminalError.sawTerminalError, false);
    assert.deepEqual(events, []);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("AppServerWorkerSession accepts a synchronous auth refresh response", async () => {
  const sentEvents: SubAgentEvent[] = [];
  const refreshedTokens = {
    accessToken: "refreshed-access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };

  const appServer = {
    close(): void {},
    async steerActiveTurn() {
      return false;
    },
    async *streamTurn(
      _threadId: string,
      _input: Input,
      onAuthRefresh: (previousAccountId: string | null) => Promise<typeof refreshedTokens>,
    ) {
      const tokens = await onAuthRefresh("acct-123");
      assert.deepEqual(tokens, refreshedTokens);
      yield { method: "turn/completed" as const, params: { threadId: "thread-1", turn: { id: "turn-1", items: [], itemsView: "full" as const, status: "completed" as const, error: null, startedAt: null, completedAt: null, durationMs: null } } };
    },
  };

  const session = new AppServerWorkerSession(appServer, "thread-1", (event) => {
    sentEvents.push(event);
    if (event.type === "chatgpt_auth_refresh_request") {
      session.handleAuthRefreshResult(refreshedTokens);
    }
  }, true);

  const sawTerminalError = await session.streamTurn("hello");

  assert.equal(sawTerminalError.sawTerminalError, false);
  assert.deepEqual(sentEvents, [{
    type: "chatgpt_auth_refresh_request",
    previousAccountId: "acct-123",
  }]);
});

test("AppServerWorkerSession reports a clear auth message after refresh failure leads to a 401 stream error", async () => {
  const sentEvents: SubAgentEvent[] = [];

  const appServer = {
    close(): void {},
    async steerActiveTurn() {
      return false;
    },
    async *streamTurn(
      _threadId: string,
      _input: Input,
      onAuthRefresh: (previousAccountId: string | null) => Promise<{
        accessToken: string;
        chatgptAccountId: string;
        chatgptPlanType: string | null;
      }>,
    ) {
      try {
        await onAuthRefresh("acct-123");
      } catch {
        // The app-server converts the failed auth refresh into a later stream error.
      }

      yield {
        method: "error" as const,
        params: {
          error: {
            message: "Reconnecting... 2/5",
            codexErrorInfo: {
              responseStreamDisconnected: {
                httpStatusCode: 401,
              },
            },
            additionalDetails: "unexpected status 401 Unauthorized",
          },
          willRetry: true,
          threadId: "thread-1",
          turnId: "turn-1",
        },
      };
    },
  };

  const session = new AppServerWorkerSession(appServer, "thread-1", (event) => {
    sentEvents.push(event);
    if (event.type === "chatgpt_auth_refresh_request") {
      session.handleAuthRefreshResult(null);
    }
  }, true);

  const result = await session.streamTurn("hello");

  assert.equal(result.sawTerminalError, true);
  assert.deepEqual(sentEvents, [
    {
      type: "chatgpt_auth_refresh_request",
      previousAccountId: "acct-123",
    },
    {
      type: "task_error",
      message: "ChatGPT authentication expired on the host and could not be refreshed. Sign in again on the host, then retry the task.",
    },
  ]);
});
