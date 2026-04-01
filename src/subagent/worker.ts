import { createInterface } from "node:readline";
import {
  Codex,
  type CommandExecutionItem,
  type Thread,
  type ThreadEvent,
  type TodoListItem,
} from "@openai/codex-sdk";
import type { HostCommand, SubAgentEvent } from "../types.js";

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
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
  const { events } = await thread.runStreamed(input);

  for await (const event of events) {
    await handleThreadEvent(event);
  }
}

async function handleThreadEvent(event: ThreadEvent): Promise<void> {
  switch (event.type) {
    case "item.completed":
    case "item.updated":
      if (event.item.type === "agent_message" && event.type === "item.completed") {
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
      break;
    case "turn.completed":
      send({ type: "task_done" });
      break;
    case "turn.failed":
      send({
        type: "task_error",
        message: event.error.message,
      });
      break;
    case "error":
      send({
        type: "task_error",
        message: event.message,
      });
      break;
    case "thread.started":
    case "turn.started":
    case "item.started":
      break;
  }
}

async function main(): Promise<void> {
  const taskBrief = getRequiredEnv("SANDY_TASK_BRIEF");
  const apiKey = getRequiredEnv("OPENAI_API_KEY");

  const codex = new Codex({ apiKey });
  const thread = codex.startThread({
    workingDirectory: "/workspace/share",
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    networkAccessEnabled: true,
    approvalPolicy: "on-request",
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

  enqueueTurn(taskBrief);

  const input = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

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
        case "privilege_decision":
          send({
            type: "progress",
            message: `Privilege request ${command.requestId} was ${command.decision}.`,
          });
          break;
        case "cancel":
          currentAbort?.abort();
          process.exit(0);
      }
    } catch (error) {
      send({
        type: "task_error",
        message: error instanceof Error ? error.message : "Failed to parse host command.",
      });
    }
  });
}

await main();
