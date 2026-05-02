import {mkdir, writeFile} from "node:fs/promises";
import {createInterface} from "node:readline";
import {pathToFileURL} from "node:url";
import {join} from "node:path";
import {type Input, type Thread, type ThreadEvent, type TodoListItem, type UserInput} from "@openai/codex-sdk";
import {createCodexClient} from "../codex-client.js";
import {configureLogger, logger} from "../logger.js";
import {type HostCommand, type SubAgentEvent, type ChatGPTExternalTokens} from "../types.js";
import {sharedWorkspaceMountPath} from "../shared-workspace.js";
import {applyWorkerCodexConfigPatch, buildWorkerCodexEnvironment, workerCodexHomePath,} from "./worker-codex-config.js";
import {workerToolDefinitions} from "./worker-tools.js";
import {parseWorkerToolCall, workerToolCallToSubAgentEvent,} from "./worker-protocol.js";

import {
  buildInitialTaskInput,
  buildPrivilegeResolutionInput,
  buildTaskSummaryInput,
  type ImageAttachment,
} from "./worker-prompt.js";
import {CodexAppServerClient} from "./app-server-client.js";
import {messages} from "../messages.js";

type ThreadEventDisposition = "none" | "privileged_tool_call" | "send_file_to_channel" | "task_done" | "terminal_error";
type TurnMode = "task" | "summary";
type StreamTurnResult = {
  sawPrivilegedToolCall: boolean;
  sawTaskDone: boolean;
  sawTerminalError: boolean;
  summaryText: string | null;
};
type WorkerToolEventParseResult =
  | { kind: "none" }
  | { kind: "parsed"; event: Extract<SubAgentEvent, { type: "tool_call" }> | Extract<SubAgentEvent, { type: "task_done" }> }
  | { kind: "invalid"; message: string };

type WorkerAuthMode = { kind: "api_key"; apiKey: string | null } | { kind: "chatgpt_appserver" };

// Auth refresh plumbing: when the worker needs fresh tokens from the host,
// it sends a chatgpt_auth_refresh_request event and waits for the host to
// respond with a chatgpt_auth_refresh_result command via stdin.
let pendingAuthRefreshResolver: ((tokens: ChatGPTExternalTokens | null) => void) | null = null;

function send(event: SubAgentEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function parseHostCommand(raw: string): HostCommand {
  const parsed = JSON.parse(raw) as HostCommand;
  if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
    throw new Error("Invalid host command.");
  }
  return parsed;
}

type WorkerCommandProcessorOptions = {
  sendEvent: (event: SubAgentEvent) => void;
  env: NodeJS.ProcessEnv;
  createCodexClient: typeof createCodexClient;
  applyWorkerCodexConfigPatch: typeof applyWorkerCodexConfigPatch;
  buildWorkerCodexEnvironment: typeof buildWorkerCodexEnvironment;
  onShutdown: () => void;
};

type WorkerCommandProcessor = {
  handleLine: (line: string) => Promise<void>;
};

function assertTaskStarted(taskStarted: boolean, commandType: HostCommand["type"]): void {
  if (!taskStarted) {
    throw new Error(`${commandType} command received before start_task`);
  }
}

function progressFromTodoList(item: TodoListItem): string | null {
  const next = item.items.find((entry) => !entry.completed);
  if (!next) {
    return null;
  }
  return messages.nextPlannedStep(next.text);
}

function truncateEventForLogging(event: ThreadEvent): ThreadEvent {
  if (event.type !== "item.started" && event.type !== "item.updated" && event.type !== "item.completed") {
    return event;
  }
  if (event.item.type !== "command_execution") {
    return event;
  }
  const { aggregated_output } = event.item;
  if (aggregated_output.length <= 1000) {
    return event;
  }
  const cloned = structuredClone(event) as ThreadEvent;
  if (cloned.type === "item.started" || cloned.type === "item.updated" || cloned.type === "item.completed") {
    const item = cloned.item;
    if (item.type === "command_execution") {
      item.aggregated_output = aggregated_output.slice(0, 1000) + "... (truncated)";
    }
  }
  return cloned;
}

function buildCodexInputWithImages(text: string, images: ImageAttachment[]): Input {
  if (images.length === 0) {
    return text;
  }

  const inputs: UserInput[] = [];

  if (text.trim()) {
    inputs.push({ type: "text", text: text.trim() });
  }

  for (const image of images) {
    inputs.push({ type: "local_image", path: image.sharePath });
  }

  return inputs;
}

function joinTaskSections(taskBrief: string, text: string): string {
  const sections = [taskBrief.trim(), text.trim()].filter((section) => section.length > 0);
  return sections.join("\n\n");
}

// ---- codex exec helpers ----

async function streamTurn(thread: Thread, input: Input, mode: TurnMode = "task"): Promise<StreamTurnResult> {
  let sawPrivilegedToolCall = false;
  let sawSendFileToChannel = false;
  let sawTaskDone = false;
  let sawTerminalError = false;
  const summaryChunks: string[] = [];
  const { events } = await thread.runStreamed(input);

  for await (const event of events) {
    logger.debug("thread.event_received", { eventType: event.type, event: truncateEventForLogging(event) });
    const disposition = mode === "summary"
      ? handleSummaryTurnEvent(event, summaryChunks)
      : handleTaskTurnEvent(event);
    if (disposition === "privileged_tool_call" && sawPrivilegedToolCall) {
      throw new Error("Only one privileged tool call is allowed per turn.");
    }
    sawPrivilegedToolCall = disposition === "privileged_tool_call" || sawPrivilegedToolCall;
    if (disposition === "send_file_to_channel" && sawSendFileToChannel) {
      throw new Error("Only one channel file send request is allowed per turn.");
    }
    sawSendFileToChannel = disposition === "send_file_to_channel" || sawSendFileToChannel;
    if (disposition === "task_done" && sawTaskDone) {
      throw new Error("Only one task completion signal is allowed per turn.");
    }
    sawTaskDone = disposition === "task_done" || sawTaskDone;
    sawTerminalError = disposition === "terminal_error" || sawTerminalError;

    if (disposition === "privileged_tool_call" || disposition === "task_done" || disposition === "terminal_error") {
      break;
    }
  }

  return {
    sawPrivilegedToolCall,
    sawTaskDone,
    sawTerminalError,
    summaryText: mode === "summary" ? normalizeSummaryText(summaryChunks) : null,
  };
}

function handleTaskTurnEvent(event: ThreadEvent): ThreadEventDisposition {
  switch (event.type) {
    case "item.completed":
    case "item.updated":
      if (event.item.type === "agent_message" && event.type === "item.completed") {
        const toolEventResult = tryParseWorkerToolEvent(event.item.text);
        if (toolEventResult.kind === "parsed") {
          send(toolEventResult.event);
          return classifyToolEventDisposition(toolEventResult.event);
        }
        if (toolEventResult.kind === "invalid") {
          send({
            type: "task_error",
            message: toolEventResult.message,
          });
          return "terminal_error";
        }
        if (!event.item.text.trim()) {
          return "none";
        }
        send({
          type: "assistant_output",
          text: event.item.text,
        });
      }

      if (event.item.type === "todo_list") {
        const message = progressFromTodoList(event.item);
        if (message) {
          send({
            type: "progress",
            message,
          });
        }
      }
      if (event.item.type === "mcp_tool_call") {
        send({
          type: "progress",
          message: messages.mcpToolProgress(event.item.status, event.item.server, event.item.tool, event.item.arguments),
        });
      }
      return "none";
    case "turn.completed":
      return "none";
    case "turn.failed":
      send({
        type: "task_error",
        message: event.error.message,
      });
      return "terminal_error";
    case "error":
      send({
        type: "task_error",
        message: event.message,
      });
      return "terminal_error";
    case "thread.started":
    case "turn.started":
    case "item.started":
      return "none";
  }
}

function handleSummaryTurnEvent(event: ThreadEvent, summaryChunks: string[]): ThreadEventDisposition {
  switch (event.type) {
    case "item.completed":
    case "item.updated":
      if (event.item.type === "agent_message" && event.type === "item.completed") {
        const toolEventResult = tryParseWorkerToolEvent(event.item.text);
        if (toolEventResult.kind !== "none") {
          return "terminal_error";
        }
        summaryChunks.push(event.item.text);
      }
      return "none";
    case "turn.completed":
      return "none";
    case "turn.failed":
    case "error":
      return "terminal_error";
    case "thread.started":
    case "turn.started":
    case "item.started":
      return "none";
  }
}

function normalizeSummaryText(chunks: string[]): string | null {
  const summary = chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0).join("\n\n").trim();
  return summary.length > 0 ? summary : null;
}

async function emitTaskSummary(thread: Thread, sendEvent: (event: SubAgentEvent) => void = send): Promise<void> {
  const result = await streamTurn(thread, buildTaskSummaryInput(), "summary");
  if (result.sawPrivilegedToolCall || result.sawTerminalError || !result.summaryText) {
    return;
  }

  sendEvent({
    type: "task_summary",
    summary: result.summaryText,
  });
}

// ---- app-server helpers ----

function createAuthRefreshCallback(): (previousAccountId: string | null) => Promise<{
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
}> {
  return async (previousAccountId: string | null) => {
    send({
      type: "chatgpt_auth_refresh_request",
      previousAccountId,
    });

    const tokens: ChatGPTExternalTokens | null = await new Promise((resolve) => {
      pendingAuthRefreshResolver = resolve;
    });

    pendingAuthRefreshResolver = null;

    if (!tokens) {
      throw new Error("Auth refresh failed: host did not provide new tokens.");
    }

    return {
      accessToken: tokens.accessToken,
      chatgptAccountId: tokens.chatgptAccountId,
      chatgptPlanType: tokens.chatgptPlanType,
    };
  };
}

function classifyAppServerToolEventDisposition(
  event: Extract<SubAgentEvent, { type: "tool_call" }> | Extract<SubAgentEvent, { type: "task_done" }>,
): ThreadEventDisposition {
  if (event.type === "task_done") return "task_done";
  const toolType = event.call.type;
  if (toolType === "send_file_to_channel") return "send_file_to_channel";
  return workerToolDefinitions[toolType].requiresPrivilegeEscalation ? "privileged_tool_call" : "none";
}

async function* streamAppServerTurn(
  appServer: CodexAppServerClient,
  threadId: string,
  input: string,
  mode: TurnMode = "task",
  abortSignal?: AbortSignal,
): AsyncGenerator<{
  result: StreamTurnResult;
  events: SubAgentEvent[];
}> {
  let sawPrivilegedToolCall = false;
  let sawTaskDone = false;
  let sawTerminalError = false;
  const summaryChunks: string[] = [];

  try {
    for await (const event of appServer.streamTurn(threadId, input, createAuthRefreshCallback(), abortSignal)) {
      logger.debug("appserver.event_received", { eventType: event.type, event });

      switch (event.type) {
        case "agent_message": {
          if (mode === "summary") {
            summaryChunks.push(event.text);
            break;
          }

          const toolEventResult = tryParseWorkerToolEvent(event.text);
          if (toolEventResult.kind === "parsed") {
            const disposition = classifyAppServerToolEventDisposition(toolEventResult.event);
            send(toolEventResult.event);
            sawPrivilegedToolCall = disposition === "privileged_tool_call" || sawPrivilegedToolCall;
            sawTaskDone = disposition === "task_done" || sawTaskDone;
            if (sawPrivilegedToolCall || sawTaskDone) {
              yield {
                result: { sawPrivilegedToolCall, sawTaskDone, sawTerminalError, summaryText: null },
                events: [],
              };
              return;
            }
          } else if (toolEventResult.kind === "invalid") {
            send({ type: "task_error", message: toolEventResult.message });
            sawTerminalError = true;
            yield {
              result: { sawPrivilegedToolCall: false, sawTaskDone: false, sawTerminalError: true, summaryText: null },
              events: [],
            };
            return;
          } else if (event.text.trim()) {
            send({ type: "assistant_output", text: event.text });
          }
          break;
        }

        case "turn_completed":
          break;

        case "turn_failed":
          send({ type: "task_error", message: event.error });
          sawTerminalError = true;
          yield {
            result: { sawPrivilegedToolCall: false, sawTaskDone: false, sawTerminalError: true, summaryText: null },
            events: [],
          };
          return;

        case "error":
          send({ type: "task_error", message: event.message });
          sawTerminalError = true;
          yield {
            result: { sawPrivilegedToolCall: false, sawTaskDone: false, sawTerminalError: true, summaryText: null },
            events: [],
          };
          return;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "App-server turn failed.";
    send({ type: "task_error", message });
    sawTerminalError = true;
  }

  yield {
    result: {
      sawPrivilegedToolCall,
      sawTaskDone,
      sawTerminalError,
      summaryText: mode === "summary" ? normalizeSummaryText(summaryChunks) : null,
    },
    events: [],
  };
}

async function emitAppServerTaskSummary(
  appServer: CodexAppServerClient,
  threadId: string,
): Promise<void> {
  for await (const { result } of streamAppServerTurn(appServer, threadId, buildTaskSummaryInput(), "summary")) {
    if (result.sawPrivilegedToolCall || result.sawTerminalError || !result.summaryText) {
      return;
    }
    send({ type: "task_summary", summary: result.summaryText });
    return;
  }
}

function tryParseWorkerToolEvent(text: string): WorkerToolEventParseResult {
  try {
    const call = parseWorkerToolCall(text);
    if (!call) {
      return { kind: "none" };
    }
    return {
      kind: "parsed",
      event: workerToolCallToSubAgentEvent(call),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown worker tool parse failure.";
    return {
      kind: "invalid",
      message: `Invalid worker tool payload: ${detail}`,
    };
  }
}

function classifyToolEventDisposition(
  event: Extract<SubAgentEvent, { type: "tool_call" }> | Extract<SubAgentEvent, { type: "task_done" }>,
): ThreadEventDisposition {
  if (event.type === "task_done") {
    return "task_done";
  }

  const toolType = event.call.type;
  if (toolType === "send_file_to_channel") {
    return "send_file_to_channel";
  }
  return workerToolDefinitions[toolType].requiresPrivilegeEscalation ? "privileged_tool_call" : "none";
}

function createWorkerCommandProcessor(options: WorkerCommandProcessorOptions): WorkerCommandProcessor {
  let thread: Thread | null = null;
  let appServer: CodexAppServerClient | null = null;
  let appServerThreadId: string | null = null;
  let authMode: WorkerAuthMode | null = null;
  let currentAbort: AbortController | null = null;
  let turnQueue: Promise<void> = Promise.resolve();
  let commandQueue: Promise<void> = Promise.resolve();
  let taskStarted = false;

  const requireThread = (): Thread => {
    if (!thread) {
      throw new Error("Task thread has not been initialized.");
    }
    return thread;
  };

  const requireAppServer = (): CodexAppServerClient => {
    if (!appServer) throw new Error("App-server has not been initialized.");
    return appServer;
  };

  const requireAppServerThreadId = (): string => {
    if (!appServerThreadId) throw new Error("App-server thread has not been started.");
    return appServerThreadId;
  };

  const enqueueCodexExecTurn = (input: Input) => {
    turnQueue = turnQueue.then(async () => {
      currentAbort = new AbortController();
      try {
        const result = await streamTurn(requireThread(), input);
        if (result.sawTaskDone && !result.sawTerminalError) {
          await emitTaskSummary(requireThread(), options.sendEvent);
          options.sendEvent({ type: "task_done" });
        }
      } finally {
        currentAbort = null;
      }
    }).catch((error) => {
      options.sendEvent({
        type: "task_error",
        message: error instanceof Error ? error.message : "Sub-agent worker turn failed.",
      });
    });
  };

  const enqueueCodexExecMarkedFinish = () => {
    turnQueue = turnQueue.then(async () => {
      currentAbort = new AbortController();
      try {
        await emitTaskSummary(requireThread(), options.sendEvent);
        options.sendEvent({ type: "task_done" });
      } finally {
        currentAbort = null;
      }
    }).catch((error) => {
      options.sendEvent({
        type: "task_error",
        message: error instanceof Error ? error.message : "Sub-agent worker finalization failed.",
      });
    });
  };

  const enqueueAppServerTurn = (inputText: string, mode: TurnMode = "task") => {
    turnQueue = turnQueue.then(async () => {
      currentAbort = new AbortController();
      try {
        for await (const { result } of streamAppServerTurn(
          requireAppServer(),
          requireAppServerThreadId(),
          inputText,
          mode,
          currentAbort.signal,
        )) {
          if (result.sawTaskDone && !result.sawTerminalError) {
            await emitAppServerTaskSummary(requireAppServer(), requireAppServerThreadId());
            send({ type: "task_done" });
          }
        }
      } finally {
        currentAbort = null;
      }
    }).catch((error) => {
      send({
        type: "task_error",
        message: error instanceof Error ? error.message : "Sub-agent worker turn failed.",
      });
    });
  };

  const enqueueAppServerMarkedFinish = () => {
    turnQueue = turnQueue.then(async () => {
      currentAbort = new AbortController();
      try {
        await emitAppServerTaskSummary(requireAppServer(), requireAppServerThreadId());
        send({ type: "task_done" });
      } finally {
        currentAbort = null;
      }
    }).catch((error) => {
      send({
        type: "task_error",
        message: error instanceof Error ? error.message : "Sub-agent worker finalization failed.",
      });
    });
  };

  const handleCommandLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const command = parseHostCommand(trimmed);
      switch (command.type) {
        case "start_task": {
          if (taskStarted) {
            throw new Error("start_task command received after task already started");
          }
          for (const [name, value] of Object.entries(command.environment)) {
            options.env[name] = value;
          }
          if (command.httpProxyUrl) {
            options.env["SANDY_HTTP_PROXY_URL"] = command.httpProxyUrl;
          }
          if (command.codexConfigToml) {
            await mkdir(workerCodexHomePath, {recursive: true});
            await writeFile(join(workerCodexHomePath, "config.toml"), command.codexConfigToml, "utf8");
          }
          await options.applyWorkerCodexConfigPatch();
          const workerCodexEnvironment = options.buildWorkerCodexEnvironment();

          if (command.config.chatgptExternalTokens) {
            const tokens = command.config.chatgptExternalTokens;
            authMode = { kind: "chatgpt_appserver" };

            const codexPath = process.env["SANDY_CODEX_PATH"]?.trim() || "codex";
            appServer = new CodexAppServerClient(codexPath);
            await appServer.initialize();
            await appServer.loginWithTokens(tokens);

            const model = command.config.codexModel ?? undefined;
            appServerThreadId = await appServer.startThread(model);

            taskStarted = true;
            const initialInput = buildInitialTaskInput(
              joinTaskSections(command.taskBrief, command.input.text),
              command.taskLanguage,
              command.config.channelFormatting,
              command.config.httpTokens,
              command.config.httpProxyWrapper,
              command.input.images,
            );
            const inputText = typeof initialInput === "string" ? initialInput : joinTaskSections(command.taskBrief, command.input.text);
            enqueueAppServerTurn(inputText);
          } else {
            authMode = { kind: "api_key", apiKey: command.config.openAiApiKey };

            const codex = command.config.openAiApiKey
              ? await options.createCodexClient({ apiKey: command.config.openAiApiKey, env: workerCodexEnvironment })
              : await options.createCodexClient({ env: workerCodexEnvironment });
            thread = codex.startThread({
              model: command.config.codexModel ?? undefined,
              workingDirectory: sharedWorkspaceMountPath,
              skipGitRepoCheck: true,
              // Docker is the actual isolation boundary for sub-agents; avoid nested bwrap sandboxing in-container.
              sandboxMode: "danger-full-access",
              networkAccessEnabled: true,
            });
            taskStarted = true;
            enqueueCodexExecTurn(buildInitialTaskInput(
              joinTaskSections(command.taskBrief, command.input.text),
              command.taskLanguage,
              command.config.channelFormatting,
              command.config.httpTokens,
              command.config.httpProxyWrapper,
              command.input.images,
            ));
          }
          break;
        }
        case "user_message":
          assertTaskStarted(taskStarted, command.type);

          if (authMode?.kind === "chatgpt_appserver") {
            enqueueAppServerTurn(command.input.text);
          } else {
            enqueueCodexExecTurn(buildCodexInputWithImages(command.input.text, command.input.images));
          }
          break;
        case "privilege_result":
          assertTaskStarted(taskStarted, command.type);

          if (authMode?.kind === "chatgpt_appserver") {
            enqueueAppServerTurn(buildPrivilegeResolutionInput(command.result));
          } else {
            enqueueCodexExecTurn(buildPrivilegeResolutionInput(command.result));
          }
          break;
        case "mark_finished":
          assertTaskStarted(taskStarted, command.type);

          if (authMode?.kind === "chatgpt_appserver") {
            enqueueAppServerMarkedFinish();
          } else {
            enqueueCodexExecMarkedFinish();
          }
          break;
        case "cancel":
          currentAbort?.abort();
          if (pendingAuthRefreshResolver) {
            pendingAuthRefreshResolver(null);
            pendingAuthRefreshResolver = null;
          }
          void appServer?.close();
          options.onShutdown();
          break;
        case "chatgpt_auth_refresh_result": {
          if (pendingAuthRefreshResolver) {
            pendingAuthRefreshResolver(command.tokens);
            pendingAuthRefreshResolver = null;
          }
          break;
        }
      }
    } catch (error) {
      options.sendEvent({
        type: "task_error",
        message: error instanceof Error ? error.message : "Failed to parse host command.",
      });
    }
  };

  return {
    handleLine: (line: string) => {
      commandQueue = commandQueue.then(() => handleCommandLine(line)).catch((error) => {
        logger.error("worker.command_queue_failed", {
          message: error instanceof Error ? error.message : "Worker command queue failed.",
        });
      });
      return commandQueue;
    },
  };
}

export async function main(): Promise<void> {
  configureLogger({
    forwardLog: (payload) => {
      send({
        type: "worker_log",
        level: payload.level,
        event: payload.event,
        data: payload.data,
      });
    },
  });

  const input = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  let shutdownResolver: (() => void) | null = null;
  const waitForShutdown = new Promise<void>((resolve) => {
    shutdownResolver = resolve;
  });

  // Keep the worker process alive after a turn finishes so the host can reply
  // to privilege requests and send follow-up task input over stdin.
  process.stdin.resume();

  send({ type: "worker_connected" });

  const processor = createWorkerCommandProcessor({
    sendEvent: send,
    env: process.env,
    createCodexClient,
    applyWorkerCodexConfigPatch,
    buildWorkerCodexEnvironment,
    onShutdown: () => {
      shutdownResolver?.();
      process.exit(0);
    },
  });

  input.on("line", (line) => {
    void processor.handleLine(line);
  });

  input.on("close", () => {
    shutdownResolver?.();
  });

  await waitForShutdown;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
export {
  createWorkerCommandProcessor,
  streamTurn,
};
export {
  buildInitialTaskInput,
  buildInitialTaskInputWithCapabilities,
  buildPrivilegeResolutionInput,
  buildTaskSummaryInput,
} from "./worker-prompt.js";
