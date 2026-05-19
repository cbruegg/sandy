import { test } from "bun:test";
import assert from "node:assert/strict";
import { type Codex, type Thread } from "@openai/codex-sdk";
import { messages } from "../messages.js";
import {
  buildInitialTaskInput,
  buildInitialTaskInputWithCapabilities,
  buildPrivilegeResolutionInput,
  buildTaskSummaryInput,
  createWorkerCommandProcessor,
  streamTurn,
} from "./worker.js";
import type { ChannelFormatting, HostCommand, PrivilegeResolutionResult, SubAgentEvent } from "../types.js";
import { parseSubAgentEvent } from "../types.js";
import { parseWorkerToolPayload } from "./worker-tools.js";
import { sharedWorkspaceMountPath } from "../shared-workspace.js";

const testFormatting: ChannelFormatting = {
  channelId: "telegram",
  markup: "telegram_html",
  allowedTags: ["b", "i", "code", "pre"],
  instructions: "Use simple Telegram HTML.",
};

test("buildInitialTaskInput tells the sub-agent where the shared workspace is", () => {
  const formatting: ChannelFormatting = {
    channelId: "telegram",
    markup: "telegram_html",
    allowedTags: ["b", "i", "code", "pre"],
    instructions: "Use simple Telegram HTML.",
  };
  const input = buildInitialTaskInput(
    "Inspect the repository and leave a summary file.",
    "English",
    formatting,
    [{ tokenId: "vid2text", description: "Token for the video transcription API." }],
    "/usr/local/bin/sandy-http-proxy-exec",
  );

  const inputText: string = typeof input === "string" ? input : (Array.isArray(input) && input[0]?.type === "text" ? input[0].text : "");
  assert.match(inputText, /\/workspace\/share/);
  assert.match(inputText, /shared workspace is mounted/);
  assert.match(inputText, /send the user-visible text first and then call the tool separately/i);
  assert.match(inputText, /MCP server "sandy" exposes additional host-integration tools/i);
  assert.match(inputText, /Use MCP tool discovery to list its tools/i);
  assert.match(inputText, /Telegram HTML/);
  assert.match(inputText, /<code>/);
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

test("buildTaskSummaryInput requests a host-facing handoff summary", () => {
  const input = buildTaskSummaryInput();

  assert.match(input, /host-facing handoff summary/);
  assert.match(input, /Do not emit any Sandy tool calls/);
  assert.match(input, /Artifacts:/);
});

test("buildInitialTaskInput includes current date and time", () => {
  const formatting: ChannelFormatting = {
    channelId: "telegram",
    markup: "telegram_html",
    allowedTags: ["b", "i", "code", "pre"],
    instructions: "Use simple Telegram HTML.",
  };
  const input = buildInitialTaskInput(
    "Inspect the repository and leave a summary file.",
    "English",
    formatting,
  );

  const inputText: string = typeof input === "string" ? input : (Array.isArray(input) && input[0]?.type === "text" ? input[0].text : "");
  assert.match(inputText, /Current date and time: [A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4}/);
});

test("worker processes follow-up commands after start_task initialization finishes", async () => {
  const { promise: codexReady, resolve: resolveCodex } = Promise.withResolvers<void>();
  const sentEvents: SubAgentEvent[] = [];
  const turnInputs: unknown[] = [];
  const thread = {
    async runStreamed(input: unknown) {
      turnInputs.push(input);
      return {
        events: (async function* () {})(),
      };
    },
  } as unknown as Thread;
  const startTaskCommand: Extract<HostCommand, { type: "start_task" }> = {
    type: "start_task",
    taskId: "task-1",
    taskBrief: "Add the track to the DJ collection.",
    input: { text: "Initial request", images: [] },
    taskLanguage: "English",
    config: {
      openAiApiKey: null,
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
    env: {},
    applyWorkerCodexConfigPatchImpl: async () => {},
    buildWorkerCodexEnvironmentImpl: () => ({}),
    createCodexClientImpl: async () => {
      await codexReady;
      return {
        startThread: () => thread,
      } as unknown as Codex;
    },
  });

  const startPromise = processor.handleLine(JSON.stringify(startTaskCommand));
  const followUpPromise = processor.handleLine(JSON.stringify(followUpCommand));
  await Promise.resolve();

  assert.equal(sentEvents.length, 0);
  assert.equal(turnInputs.length, 0);

  resolveCodex();
  await startPromise;
  await followUpPromise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sentEvents.some((event) => event.type === "task_error"), false);
  assert.equal(turnInputs.length, 2);
  assert.match(String(turnInputs[0]), /Add the track to the DJ collection/);
  assert.match(String(turnInputs[1]), /Use https:\/\/example\.com\/set/);
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

    const result = await streamTurn(thread, "Inspect the reel.");

    assert.equal(result.sawTaskDone, false);
    assert.equal(result.sawTerminalError, false);
    assert.deepEqual(writes, []);
  } finally {
    process.stdout.write = originalWrite;
  }
});
