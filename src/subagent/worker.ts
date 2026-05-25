import { type Input, type Thread, type ThreadEvent, type TodoListItem, type UserInput } from "@openai/codex-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {createCodexClient, SANDY_CODEX_PATH_ENV} from "../codex-client.js";
import { configureLogger, logger } from "../logger.js";
import { messages } from "../messages.js";
import { type HostCommand, type SubAgentEvent } from "../types.js";
import { buildCodexExecThreadOptions } from "./codex-task-runtime.js";
import {
  buildInitialTaskInput,
  buildPrivilegeResolutionInput,
  buildTaskSummaryInput,
  type ImageAttachment,
} from "./worker-prompt.js";
import { AppServerWorkerSession, streamAppServerTurn } from "./worker-app-server.js";
import {
  applyWorkerCodexConfigPatch,
  buildWorkerCodexEnvironment,
  workerCodexHomePath,
} from "./worker-codex-config.js";
import { writeSubAgentEvent } from "./subagent-event-writer.js";

type ThreadEventDisposition = "none" | "terminal_error";

type WorkerAuthMode = { kind: "api_key"; apiKey: string | null } | { kind: "chatgpt_appserver" };

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

function requireConfiguredCodexPath(env: NodeJS.ProcessEnv): string {
  const codexPath = env[SANDY_CODEX_PATH_ENV]?.trim();
  if (!codexPath) {
    throw new Error("SANDY_CODEX_PATH must be configured for app-server workers.");
  }
  return codexPath;
}

// ---- codex exec helpers ----

async function streamTurn(thread: Thread, input: Input): Promise<boolean> {
  let sawTerminalError = false;
  const { events } = await thread.runStreamed(input);

  for await (const event of events) {
    logger.debug("thread.event_received", { eventType: event.type, event: truncateEventForLogging(event) });
    const disposition = handleTaskTurnEvent(event);
    sawTerminalError = disposition === "terminal_error" || sawTerminalError;

    if (disposition === "terminal_error") {
      break;
    }
  }

  return sawTerminalError;
}

function handleTaskTurnEvent(event: ThreadEvent): ThreadEventDisposition {
  switch (event.type) {
    case "item.completed":
    case "item.updated":
      if (event.item.type === "agent_message" && event.type === "item.completed") {
        if (!event.item.text.trim()) {
          return "none";
        }
        writeSubAgentEvent({
          type: "assistant_output",
          text: event.item.text,
        });
      }

      if (event.item.type === "todo_list") {
        const message = progressFromTodoList(event.item);
        if (message) {
          writeSubAgentEvent({
            type: "progress",
            message,
          });
        }
      }
      if (event.item.type === "mcp_tool_call") {
        writeSubAgentEvent({
          type: "progress",
          message: messages.mcpToolProgress(event.item.status, event.item.server, event.item.tool, event.item.arguments),
        });
      }
      return "none";
    case "turn.completed":
      return "none";
    case "turn.failed":
      writeSubAgentEvent({
        type: "task_error",
        message: event.error.message,
      });
      return "terminal_error";
    case "error":
      writeSubAgentEvent({
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

async function collectTaskSummary(thread: Thread): Promise<{ sawTerminalError: boolean; summaryText: string | null }> {
  let sawTerminalError = false;
  const summaryChunks: string[] = [];
  const { events } = await thread.runStreamed(buildTaskSummaryInput());

  for await (const event of events) {
    logger.debug("thread.event_received", { eventType: event.type, event: truncateEventForLogging(event) });
    const disposition = handleSummaryTurnEvent(event, summaryChunks);
    sawTerminalError = disposition === "terminal_error" || sawTerminalError;

    if (disposition === "terminal_error") {
      break;
    }
  }

  return {
    sawTerminalError,
    summaryText: normalizeSummaryText(summaryChunks),
  };
}

async function emitTaskSummary(thread: Thread, sendEvent: (event: SubAgentEvent) => void = writeSubAgentEvent): Promise<void> {
  const result = await collectTaskSummary(thread);
  if (result.sawTerminalError || !result.summaryText) {
    return;
  }

  sendEvent({
    type: "task_summary",
    summary: result.summaryText,
  });
}

function createWorkerCommandProcessor(options: WorkerCommandProcessorOptions): WorkerCommandProcessor {
  let thread: Thread | null = null;
  let appServerSession: AppServerWorkerSession | null = null;
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

  const requireAppServerSession = (): AppServerWorkerSession => {
    if (!appServerSession) {
      throw new Error("App-server has not been initialized.");
    }
    return appServerSession;
  };

  const enqueueCodexExecTurn = (input: Input): void => {
    turnQueue = turnQueue.then(async () => {
      currentAbort = new AbortController();
      try {
        await streamTurn(requireThread(), input);
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

  const enqueueCodexExecMarkedFinish = (): void => {
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

  const enqueueAppServerTurn = (inputText: string): void => {
    turnQueue = turnQueue.then(async () => {
      currentAbort = new AbortController();
      try {
        await requireAppServerSession().streamTurn(inputText, currentAbort.signal);
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

  const enqueueAppServerMarkedFinish = (): void => {
    turnQueue = turnQueue.then(async () => {
      currentAbort = new AbortController();
      try {
        await requireAppServerSession().emitTaskSummary();
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
            await mkdir(workerCodexHomePath, { recursive: true });
            await writeFile(join(workerCodexHomePath, "config.toml"), command.codexConfigToml, "utf8");
          }
          await options.applyWorkerCodexConfigPatch();
          const workerCodexEnvironment = options.buildWorkerCodexEnvironment();

          if (command.config.chatgptExternalTokens) {
            const tokens = command.config.chatgptExternalTokens;
            authMode = { kind: "chatgpt_appserver" };

            const codexPath = requireConfiguredCodexPath(options.env);
            appServerSession = await AppServerWorkerSession.start({
              codexPath,
              initialTokens: tokens,
              model: command.config.codexModel ?? undefined,
              sendEvent: options.sendEvent,
            });

            taskStarted = true;
            const initialInput = buildInitialTaskInput(
              joinTaskSections(command.taskBrief, command.input.text),
              command.taskLanguage,
              command.config.channelFormatting,
              command.config.httpTokens,
              command.config.httpProxyWrapper,
              command.input.images,
            );
            const inputText = typeof initialInput === "string"
              ? initialInput
              : joinTaskSections(command.taskBrief, command.input.text);
            enqueueAppServerTurn(inputText);
          } else {
            authMode = { kind: "api_key", apiKey: command.config.openAiApiKey };

            const codex = command.config.openAiApiKey
              ? await options.createCodexClient({ apiKey: command.config.openAiApiKey, env: workerCodexEnvironment })
              : await options.createCodexClient({ env: workerCodexEnvironment });
            thread = codex.startThread(buildCodexExecThreadOptions(command.config.codexModel ?? undefined));
            taskStarted = true;
            enqueueCodexExecTurn(
              buildInitialTaskInput(
                joinTaskSections(command.taskBrief, command.input.text),
                command.taskLanguage,
                command.config.channelFormatting,
                command.config.httpTokens,
                command.config.httpProxyWrapper,
                command.input.images,
              ),
            );
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
          appServerSession?.cancelPendingAuthRefresh();
          appServerSession?.close();
          options.onShutdown();
          break;
        case "chatgpt_auth_refresh_result": {
          appServerSession?.handleAuthRefreshResult(command.tokens);
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
      writeSubAgentEvent({
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

  writeSubAgentEvent({ type: "worker_connected" });

  const processor = createWorkerCommandProcessor({
    sendEvent: writeSubAgentEvent,
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
  streamAppServerTurn,
};
export {
  buildInitialTaskInput,
  buildInitialTaskInputWithCapabilities,
  buildPrivilegeResolutionInput,
  buildTaskSummaryInput,
} from "./worker-prompt.js";
