import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
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
  parsePrivilegeRequest,
  type ChannelFormatting,
  type HostCommand,
  type PrivilegeRequest,
  type PrivilegeResolutionResult,
  type SubAgentEvent,
} from "../types.js";

const privilegeRequestPrefix = "SANDY_PRIVILEGE_REQUEST ";
type ThreadEventDisposition = "none" | "privilege_request" | "terminal_error";
type PrivilegeParseResult =
  | { kind: "none" }
  | { kind: "parsed"; request: PrivilegeRequest }
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
    allowedTags: parsed.allowedTags.filter((entry): entry is string => typeof entry === "string"),
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
  let sawTerminalError = false;
  const { events } = await thread.runStreamed(input);

  for await (const event of events) {
    const disposition = await handleThreadEvent(event);
    if (disposition === "privilege_request" && sawPrivilegeRequest) {
      throw new Error("Only one privilege request is allowed per turn.");
    }
    sawPrivilegeRequest = disposition === "privilege_request" || sawPrivilegeRequest;
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

export function buildInitialTaskInput(taskBrief: string, channelFormatting: ChannelFormatting | null): string {
  return buildInitialTaskInputWithCapabilities(taskBrief, channelFormatting, detectRuntimeCapabilities());
}

export function buildInitialTaskInputWithCapabilities(
  taskBrief: string,
  channelFormatting: ChannelFormatting | null,
  runtimeCapabilities: string[],
): string {
  const lines = [
    "You are running inside a Sandy sub-agent container.",
    "Your shared workspace is mounted at /workspace/share.",
    "Use /workspace/share for files that should remain available to the host after your task finishes.",
    "Inside this container you may use the filesystem, network, and installed tools freely.",
    "If you need the host to copy files into or out of /workspace/share, do not ask the user directly.",
    `Instead, output exactly one line in this format and no surrounding text: ${privilegeRequestPrefix}{...json...}`,
    "Allowed host-mediated request types are copy_into_share and copy_out_of_share.",
    "For any host-mediated request, use absolute paths. Any shared-workspace path must stay under /workspace/share.",
    `Example for copying a result file to Downloads: ${privilegeRequestPrefix}{"type":"copy_out_of_share","sourcePath":"/workspace/share/result.txt","targetPath":"~/Downloads/result.txt","reason":"Need to deliver the generated file to the user."}`,
    `Example for copying a host file in: ${privilegeRequestPrefix}{"type":"copy_into_share","sourcePath":"~/Downloads/input.txt","targetPath":"/workspace/share/input.txt","reason":"Need the user-provided input file inside the task workspace."}`,
    "After emitting a host-mediated request, stop and wait for the next host message before continuing.",
  ];

  if (runtimeCapabilities.length > 0) {
    lines.push(...runtimeCapabilities);
  }

  if (channelFormatting) {
    lines.push(
      `User-visible output must follow this channel formatting contract: ${channelFormatting.instructions}`,
      `Allowed formatting tags: ${channelFormatting.allowedTags.map((tag) => `<${tag}>`).join(", ")}`,
    );
  }

  lines.push("", taskBrief);
  return lines.join("\n");
}

function detectRuntimeCapabilities(): string[] {
  const capabilities: string[] = [];
  const zypperVersion = spawnSync("zypper", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (zypperVersion.status === 0) {
    capabilities.push(
      "Detected package manager: zypper.",
      "You can install or update openSUSE Tumbleweed packages in this container with zypper when needed.",
    );
  }

  const brewVersion = spawnSync("brew", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (brewVersion.status === 0) {
    capabilities.push(
      "Detected package manager: Homebrew.",
      "Use brew for fast-moving CLI and developer tools; the container's brew command runs under the dedicated linuxbrew user automatically.",
    );
  }

  return capabilities;
}

export function buildPrivilegeResolutionInput(result: PrivilegeResolutionResult): string {
  return [
    `Host privilege request ${result.requestId} finished with outcome "${result.outcome}".`,
    result.message,
    "Continue the task from here.",
  ].join("\n");
}

export function parsePrivilegeRequestMessage(text: string): PrivilegeRequest | null {
  const rawPayload = extractPrivilegeRequestPayload(text);
  if (!rawPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawPayload) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Privilege request payload must be a JSON object.");
    }
    return parsePrivilegeRequest({
      ...(parsed as Record<string, unknown>),
      requestId: randomUUID(),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown privilege request parse failure.";
    throw new Error(`${detail} Payload: ${rawPayload}`);
  }
}

function extractPrivilegeRequestPayload(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(privilegeRequestPrefix)) {
    return null;
  }
  return trimmed.slice(privilegeRequestPrefix.length).trim();
}

function tryParsePrivilegeRequestMessage(text: string): PrivilegeParseResult {
  const rawPayload = extractPrivilegeRequestPayload(text);
  if (!rawPayload) {
    return { kind: "none" };
  }

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

async function main(): Promise<void> {
  const taskBrief = getRequiredEnv("SANDY_TASK_BRIEF");
  const apiKey = getOptionalEnv("OPENAI_API_KEY");
  const channelFormatting = parseChannelFormatting(getOptionalEnv("SANDY_CHANNEL_FORMATTING"));

  const codex = apiKey ? new Codex({ apiKey }) : new Codex();
  const thread = codex.startThread({
    workingDirectory: "/workspace/share",
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
  enqueueTurn(buildInitialTaskInputWithCapabilities(taskBrief, channelFormatting, detectRuntimeCapabilities()));

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
