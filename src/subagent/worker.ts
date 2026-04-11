import {createInterface} from "node:readline";
import {pathToFileURL} from "node:url";
import {Codex, type Thread, type ThreadEvent, type TodoListItem,} from "@openai/codex-sdk";
import {type ChannelFormatting, type HostCommand, type SubAgentEvent,} from "../types.js";
import {sharedWorkspaceMountPath} from "../shared-workspace.js";
import {workerToolDefinitions} from "./worker-tools.js";
import {parseWorkerToolCall, workerToolCallToSubAgentEvent,} from "./worker-protocol.js";
import {buildInitialTaskInput, buildPrivilegeResolutionInput, buildTaskSummaryInput,} from "./worker-prompt.js";
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

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getOptionalEnv(name: string): string | null {
  const value = process.env[name];
  if (!value) {
    return null;
  }
  return value;
}

function parseChannelFormatting(raw: string | null): ChannelFormatting | null {
  if (!raw) {
    return null;
  }
  const parsed = JSON.parse(raw) as Partial<ChannelFormatting>;
  if (
    parsed.channel !== "telegram" ||
    parsed.markup !== "telegram_html" ||
    !Array.isArray(parsed.allowedTags) ||
    typeof parsed.instructions !== "string"
  ) {
    throw new Error("Invalid channel formatting metadata.");
  }
  return {
    channel: parsed.channel,
    markup: parsed.markup,
    allowedTags: parsed.allowedTags.filter((entry: unknown): entry is string => typeof entry === "string"),
    instructions: parsed.instructions,
  };
}

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

function progressFromTodoList(item: TodoListItem): string | null {
  const next = item.items.find((entry) => !entry.completed);
  if (!next) {
    return null;
  }
  return messages.nextPlannedStep(next.text);
}

async function streamTurn(thread: Thread, input: string, mode: TurnMode = "task"): Promise<StreamTurnResult> {
  let sawPrivilegedToolCall = false;
  let sawSendFileToChannel = false;
  let sawTaskDone = false;
  let sawTerminalError = false;
  const summaryChunks: string[] = [];
  const { events } = await thread.runStreamed(input);

  for await (const event of events) {
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
        send({
          type: "assistant_output",
          text: event.item.text,
        });
      }
      if (event.item.type === "command_execution") {
        send({
          type: "progress",
          message: messages.commandProgress(event.item.status, event.item.command),
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

async function emitTaskSummary(thread: Thread): Promise<void> {
  const result = await streamTurn(thread, buildTaskSummaryInput(), "summary");
  if (result.sawPrivilegedToolCall || result.sawTerminalError || !result.summaryText) {
    return;
  }

  send({
    type: "task_summary",
    summary: result.summaryText,
  });
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

async function main(): Promise<void> {
  const taskBrief = getRequiredEnv("SANDY_TASK_BRIEF");
  const apiKey = getOptionalEnv("OPENAI_API_KEY");
  const channelFormatting = parseChannelFormatting(getOptionalEnv("SANDY_CHANNEL_FORMATTING"));

  const codex = apiKey ? new Codex({ apiKey }) : new Codex();
  const thread = codex.startThread({
    workingDirectory: sharedWorkspaceMountPath,
    skipGitRepoCheck: true,
    // Docker is the actual isolation boundary for sub-agents; avoid nested bwrap sandboxing in-container.
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
  });

  let currentAbort: AbortController | null = null;
  let queue: Promise<void> = Promise.resolve();

  const enqueueTurn = (input: string) => {
    queue = queue.then(async () => {
      currentAbort = new AbortController();
      try {
        const result = await streamTurn(thread, input);
        if (result.sawTaskDone && !result.sawTerminalError) {
          await emitTaskSummary(thread);
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
        await emitTaskSummary(thread);
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
  enqueueTurn(buildInitialTaskInput(taskBrief, channelFormatting));

  input.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const command = parseHostCommand(trimmed);
      switch (command.type) {
        case "user_message":
          enqueueTurn(command.text);
          break;
        case "privilege_result":
          enqueueTurn(buildPrivilegeResolutionInput(command.result));
          break;
        case "mark_finished":
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
  parseWorkerToolCall,
  workerToolCallToSubAgentEvent,
} from "./worker-protocol.js";
export {
  buildInitialTaskInput,
  buildInitialTaskInputWithCapabilities,
  buildPrivilegeResolutionInput,
  buildTaskSummaryInput,
} from "./worker-prompt.js";
