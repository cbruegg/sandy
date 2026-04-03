import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  Codex,
  type CommandExecutionItem,
  type Thread,
  type ThreadEvent,
  type TodoListItem,
} from "@openai/codex-sdk";
import {
  type ChannelFormatting,
  type HostCommand,
  type PrivilegeRequest,
  type SubAgentEvent,
} from "../types.js";
import { sharedWorkspaceMountPath } from "../shared-workspace.js";
import {
  channelFilePrefix,
  parseChannelFileMessage,
  privilegeRequestPrefix,
  parsePrivilegeRequestMessage,
} from "./worker-protocol.js";
import {
  buildInitialTaskInput,
  buildInitialTaskInputWithCapabilities,
  buildPrivilegeResolutionInput,
} from "./worker-prompt.js";
type ThreadEventDisposition = "none" | "privilege_request" | "channel_file" | "terminal_error";
type PrivilegeParseResult =
  | { kind: "none" }
  | { kind: "parsed"; request: PrivilegeRequest }
  | { kind: "invalid"; message: string };
type ChannelFileParseResult =
  | { kind: "none" }
  | { kind: "parsed"; path: string; caption?: string }
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
  return `Next planned step: ${next.text}`;
}

function progressFromCommand(item: CommandExecutionItem): string {
  return `Command ${item.status}: ${item.command}`;
}

async function streamTurn(thread: Thread, input: string): Promise<void> {
  let sawPrivilegeRequest = false;
  let sawChannelFile = false;
  let sawTerminalError = false;
  const { events } = await thread.runStreamed(input);

  for await (const event of events) {
    const disposition = await handleThreadEvent(event);
    if (disposition === "privilege_request" && sawPrivilegeRequest) {
      throw new Error("Only one privilege request is allowed per turn.");
    }
    sawPrivilegeRequest = disposition === "privilege_request" || sawPrivilegeRequest;
    if (disposition === "channel_file" && sawChannelFile) {
      throw new Error("Only one channel file send request is allowed per turn.");
    }
    sawChannelFile = disposition === "channel_file" || sawChannelFile;
    sawTerminalError = disposition === "terminal_error" || sawTerminalError;
  }

  if (!sawPrivilegeRequest && !sawTerminalError) {
    send({ type: "task_done" });
  }
}

async function handleThreadEvent(event: ThreadEvent): Promise<ThreadEventDisposition> {
  switch (event.type) {
    case "item.completed":
    case "item.updated":
      if (event.item.type === "agent_message" && event.type === "item.completed") {
        const privilegeResult = tryParsePrivilegeRequestMessage(event.item.text);
        if (privilegeResult.kind === "parsed") {
          send({
            type: "privilege_request",
            request: privilegeResult.request,
          });
          return "privilege_request";
        }
        if (privilegeResult.kind === "invalid") {
          send({
            type: "task_error",
            message: privilegeResult.message,
          });
          return "terminal_error";
        }
        const channelFileResult = tryParseChannelFileMessage(event.item.text);
        if (channelFileResult.kind === "parsed") {
          send({
            type: "channel_file",
            path: channelFileResult.path,
            caption: channelFileResult.caption,
          });
          return "channel_file";
        }
        if (channelFileResult.kind === "invalid") {
          send({
            type: "task_error",
            message: channelFileResult.message,
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
          message: progressFromCommand(event.item),
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

function tryParsePrivilegeRequestMessage(text: string): PrivilegeParseResult {
  try {
    const request = parsePrivilegeRequestMessage(text);
    return request ? { kind: "parsed", request } : { kind: "none" };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown privilege request parse failure.";
    return {
      kind: "invalid",
      message: `Invalid privilege request payload: ${detail}`,
    };
  }
}

function tryParseChannelFileMessage(text: string): ChannelFileParseResult {
  try {
    const parsed = parseChannelFileMessage(text);
    if (!parsed) {
      return { kind: "none" };
    }

    return {
      kind: "parsed",
      path: parsed.path,
      caption: parsed.caption,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown channel file parse failure.";
    return {
      kind: "invalid",
      message: `Invalid channel file payload: ${detail}`,
    };
  }
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
        await streamTurn(thread, input);
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
export { parsePrivilegeRequestMessage } from "./worker-protocol.js";
export {
  buildInitialTaskInput,
  buildInitialTaskInputWithCapabilities,
  buildPrivilegeResolutionInput,
} from "./worker-prompt.js";
