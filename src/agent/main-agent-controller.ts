import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex, type ThreadOptions } from "@openai/codex-sdk";
import { logger } from "../logger.js";
import type { DecideContext, MainAgentDecision } from "../types.js";
import { parseMainAgentDecision } from "../types.js";

export interface MainAgentController {
  decide(context: DecideContext): Promise<MainAgentDecision>;
}

type MainAgentTurn = {
  finalResponse: string;
};

type MainAgentThread = {
  run(input: string, options?: { outputSchema?: object }): Promise<MainAgentTurn>;
};
type CodexClient = {
  startThread(options?: ThreadOptions): MainAgentThread;
};

const decisionSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["launch_task", "reply"],
    },
    taskBrief: {
      type: ["string", "null"],
    },
    taskName: {
      type: ["string", "null"],
    },
    replyText: {
      type: ["string", "null"],
    },
  },
  required: ["action", "taskBrief", "taskName", "replyText"],
  additionalProperties: false,
} as const;

export class CodexMainAgentController implements MainAgentController {
  private readonly codex: CodexClient;
  private readonly threads = new Map<string, MainAgentThread>();
  private readonly threadDirectories = new Map<string, string>();

  constructor(codex?: CodexClient) {
    this.codex = codex ?? new Codex();
  }

  async decide(context: DecideContext): Promise<MainAgentDecision> {
    const isInitialTurn = !this.threads.has(context.chatId);
    const thread = this.getOrCreateThread(context.chatId);
    logger.info("main_agent.decision_requested", {
      chatId: context.chatId,
      newVisibleEntryCount: context.newVisibleEntries.length,
      hasActiveTask: context.activeTask !== null,
    });
    const prompt = buildMainAgentPrompt({
      activeTask: context.activeTask,
      channelFormatting: context.channelFormatting,
      newVisibleEntries: context.newVisibleEntries,
      isInitialTurn,
    });
    const turn = await thread.run(prompt, {
      outputSchema: decisionSchema,
    });

    const decision = parseMainAgentDecision(turn.finalResponse);
    logger.info("main_agent.decision_received", {
      chatId: context.chatId,
      action: decision.action,
      taskName: decision.action === "launch_task" ? decision.taskName : null,
    });
    return decision;
  }

  private getOrCreateThread(chatId: string): MainAgentThread {
    const existing = this.threads.get(chatId);
    if (existing) {
      return existing;
    }
    const created = this.createThread(chatId);
    this.threads.set(chatId, created);
    return created;
  }

  private createThread(chatId: string): MainAgentThread {
    const workingDirectory = this.getOrCreateThreadDirectory(chatId);
    const thread = this.codex.startThread(buildMainAgentThreadOptions(workingDirectory));
    logger.debug("main_agent.thread_started", {
      chatId,
      workingDirectory,
    });
    return thread;
  }

  private getOrCreateThreadDirectory(chatId: string): string {
    const existing = this.threadDirectories.get(chatId);
    if (existing) {
      return existing;
    }

    const directory = mkdtempSync(join(tmpdir(), "sandy-main-agent-"));
    this.threadDirectories.set(chatId, directory);
    logger.debug("main_agent.working_directory_created", {
      chatId,
      workingDirectory: directory,
    });
    return directory;
  }
}

export function buildMainAgentThreadOptions(workingDirectory: string): ThreadOptions {
  return {
    approvalPolicy: "never",
    sandboxMode: "read-only",
    workingDirectory,
    skipGitRepoCheck: true,
  };
}

export function buildMainAgentPrompt(input: {
  newVisibleEntries: DecideContext["newVisibleEntries"];
  activeTask: DecideContext["activeTask"];
  channelFormatting: DecideContext["channelFormatting"];
  isInitialTurn: boolean;
}): string {
  const intro = input.isInitialTurn
    ? [
        "You are Sandy's main orchestration controller.",
        "Decide whether Sandy should launch a new sub-agent task or reply directly.",
        "This thread persists across decisions for one chat, so retain prior visible context from earlier turns in this thread.",
        "If some earlier sub-agent output or privilege request details are not present in this thread, treat them as unavailable and do not invent them.",
        "Return JSON that matches the provided schema.",
      ]
    : [
        "Continue acting as Sandy's main orchestration controller for this chat.",
        "Use the prior visible context already present in this thread plus only the new visible entries below.",
        "If some earlier sub-agent output or privilege request details are not present in this thread, treat them as unavailable and do not invent them.",
        "Return JSON that matches the provided schema.",
      ];

  return [
    ...intro,
    "",
    input.isInitialTurn ? "Visible chat entries for this first decision:" : "New visible chat entries since your last decision:",
    JSON.stringify(input.newVisibleEntries, null, 2),
    "",
    "Current active task metadata:",
    JSON.stringify(input.activeTask, null, 2),
    "",
    "Channel formatting metadata:",
    JSON.stringify(input.channelFormatting, null, 2),
    "",
    "Decision rules:",
    "- Choose between replying directly and launching a task based on the user's likely intent and the current conversation state.",
    "- It is acceptable to launch a task proactively when that is the best way for Sandy to investigate, inspect, or execute something for the user.",
    "- Reply directly for purely conversational requests or when no sub-agent work is useful.",
    "- Task names must be short, stable, and descriptive.",
    "- Task briefs must contain only the minimum instructions needed by the sub-agent.",
    "- Any replyText you produce is user-visible. Follow the provided channel formatting instructions exactly.",
  ].join("\n");
}
