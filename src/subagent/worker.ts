import {mkdir, writeFile} from "node:fs/promises";
import {createInterface} from "node:readline";
import {pathToFileURL} from "node:url";
import {join} from "node:path";
import {type Input, type Thread, type ThreadEvent, type TodoListItem, type UserInput} from "@openai/codex-sdk";
import {createCodexClient} from "../codex-client.js";
import {configureLogger, logger} from "../logger.js";
import {type HostCommand, type SubAgentEvent,} from "../types.js";
import {sharedWorkspaceMountPath} from "../shared-workspace.js";
import {applyWorkerCodexConfigPatch, buildWorkerCodexEnvironment, workerCodexHomePath,} from "./worker-codex-config.js";

import {
  buildInitialTaskInput,
  buildPrivilegeResolutionInput,
  buildTaskSummaryInput,
  type ImageAttachment,
} from "./worker-prompt.js";
import { formatDateTimePrefix } from "../datetime-prefix.js";
import {messages} from "../messages.js";

type ThreadEventDisposition = "none" | "task_done" | "terminal_error";
type TurnMode = "task" | "summary";
type StreamTurnResult = {
  sawTaskDone: boolean;
  sawTerminalError: boolean;
  summaryText: string | null;
};

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

async function streamTurn(thread: Thread, input: Input, mode: TurnMode = "task"): Promise<StreamTurnResult> {
  let sawTaskDone = false;
  let sawTerminalError = false;
  const summaryChunks: string[] = [];
  const { events } = await thread.runStreamed(input);

  for await (const event of events) {
    logger.debug("thread.event_received", { eventType: event.type, event: truncateEventForLogging(event) });
    const disposition = mode === "summary"
      ? handleSummaryTurnEvent(event, summaryChunks)
      : handleTaskTurnEvent(event);
    if (disposition === "task_done" && sawTaskDone) {
      throw new Error("Only one task completion signal is allowed per turn.");
    }
    sawTaskDone = disposition === "task_done" || sawTaskDone;
    sawTerminalError = disposition === "terminal_error" || sawTerminalError;

    if (disposition === "task_done" || disposition === "terminal_error") {
      break;
    }
  }

  return {
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

async function emitTaskSummary(thread: Thread): Promise<void> {
  const result = await streamTurn(thread, buildTaskSummaryInput(), "summary");
  if (result.sawTerminalError || !result.summaryText) {
    return;
  }

  send({
    type: "task_summary",
    summary: result.summaryText,
  });
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

  let thread: Thread | null = null;

  let currentAbort: AbortController | null = null;
  let queue: Promise<void> = Promise.resolve();
  let taskStarted = false;

  const requireThread = (): Thread => {
    if (!thread) {
      throw new Error("Task thread has not been initialized.");
    }
    return thread;
  };

  const enqueueTurn = (input: Input) => {
    queue = queue.then(async () => {
      currentAbort = new AbortController();
      try {
        const result = await streamTurn(requireThread(), input);
        if (result.sawTaskDone && !result.sawTerminalError) {
          await emitTaskSummary(requireThread());
          send({ type: "task_done" });
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

  const enqueueMarkedFinish = () => {
    queue = queue.then(async () => {
      currentAbort = new AbortController();
      try {
        await emitTaskSummary(requireThread());
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

  const handleLine = async (line: string): Promise<void> => {
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
            process.env[name] = value;
          }
          if (command.httpProxyUrl) {
            process.env["SANDY_HTTP_PROXY_URL"] = command.httpProxyUrl;
          }
          if (command.codexConfigToml) {
            await mkdir(workerCodexHomePath, {recursive: true});
            await writeFile(join(workerCodexHomePath, "config.toml"), command.codexConfigToml, "utf8");
          }
          await applyWorkerCodexConfigPatch();
          const workerCodexEnvironment = buildWorkerCodexEnvironment();
          const codex = command.config.openAiApiKey
            ? await createCodexClient({ apiKey: command.config.openAiApiKey, env: workerCodexEnvironment })
            : await createCodexClient({ env: workerCodexEnvironment });
          thread = codex.startThread({
            model: command.config.codexModel ?? undefined,
            workingDirectory: sharedWorkspaceMountPath,
            skipGitRepoCheck: true,
            // Docker is the actual isolation boundary for sub-agents; avoid nested bwrap sandboxing in-container.
            sandboxMode: "danger-full-access",
            networkAccessEnabled: true,
          });
          taskStarted = true;
          enqueueTurn(buildInitialTaskInput(
            joinTaskSections(command.taskBrief, command.input.text),
            command.taskLanguage,
            command.config.channelFormatting,
            command.config.httpTokens,
            command.config.httpProxyWrapper,
            command.input.images,
          ));
          break;
        }
        case "user_message":
          assertTaskStarted(taskStarted, command.type);
          enqueueTurn(buildCodexInputWithImages(
            `${formatDateTimePrefix()}\n\n${command.input.text}`,
            command.input.images,
          ));
          break;
        case "privilege_result":
          assertTaskStarted(taskStarted, command.type);
          enqueueTurn(buildPrivilegeResolutionInput(command.result));
          break;
        case "mark_finished":
          assertTaskStarted(taskStarted, command.type);
          enqueueMarkedFinish();
          break;
        case "cancel":
          currentAbort?.abort();
          shutdownResolver?.();
          process.exit(0);
        }
    } catch (error) {
      send({
        type: "task_error",
        message: error instanceof Error ? error.message : "Failed to parse host command.",
      });
    }
  };

  input.on("line", (line) => {
    void handleLine(line);
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
  streamTurn,
};
export {
  buildInitialTaskInput,
  buildInitialTaskInputWithCapabilities,
  buildPrivilegeResolutionInput,
  buildTaskSummaryInput,
} from "./worker-prompt.js";
