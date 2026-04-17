import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadOptions } from "@openai/codex-sdk";
import { ZodError } from "zod";
import { logger } from "../logger.js";
import type { DecideContext, MainAgentDecision } from "../types.js";
import type { SkillMetadata } from "../skills.js";
import {
  formatMainAgentDecisionValidationError,
  mainAgentDecisionPromptSchema,
  parseMainAgentDecision,
} from "./main-agent-decision.js";

export interface MainAgentController {
  decide(context: DecideContext): Promise<MainAgentDecision>;
}

type MainAgentTurn = {
  finalResponse: string;
};

type MainAgentThread = {
  run(input: string): Promise<MainAgentTurn>;
};
type CodexClient = {
  startThread(options?: ThreadOptions): MainAgentThread;
};

const MAX_DECISION_VALIDATION_ATTEMPTS = 3;

export class CodexMainAgentController implements MainAgentController {
  private readonly codex: CodexClient;
  private readonly skills: SkillMetadata[];
  private readonly threads = new Map<string, MainAgentThread>();
  private readonly threadDirectories = new Map<string, string>();

  constructor(codex: CodexClient, skills: SkillMetadata[] = []) {
    this.codex = codex;
    this.skills = skills;
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
      skills: this.skills,
    });
    const decision = await this.runValidatedDecision(thread, prompt, context.chatId);
    logger.info("main_agent.decision_received", {
      chatId: context.chatId,
      action: decision.action,
      taskName: decision.action === "launch_task" ? decision.taskName : null,
    });
    return decision;
  }

  private async runValidatedDecision(thread: MainAgentThread, prompt: string, chatId: string): Promise<MainAgentDecision> {
    let nextInput = prompt;

    for (let attempt = 1; attempt <= MAX_DECISION_VALIDATION_ATTEMPTS; attempt += 1) {
      const turn = await thread.run(nextInput);
      logger.debugContent("main_agent.model_response", {
        chatId,
        attempt,
        response: turn.finalResponse,
      });
      try {
        return parseMainAgentDecision(turn.finalResponse);
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof ZodError)) {
          throw error;
        }

        logger.warn("main_agent.decision_validation_failed", {
          chatId,
          attempt,
          maxAttempts: MAX_DECISION_VALIDATION_ATTEMPTS,
          message: error.message,
        });

        if (attempt === MAX_DECISION_VALIDATION_ATTEMPTS) {
          throw new Error(
            `Main agent failed to return a valid decision after ${MAX_DECISION_VALIDATION_ATTEMPTS} attempts: ${error.message}`,
            { cause: error },
          );
        }

        nextInput = formatMainAgentDecisionValidationError(turn.finalResponse, error);
      }
    }

    throw new Error("Unreachable.");
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
  skills: SkillMetadata[];
}): string {
  const intro = input.isInitialTurn
    ? [
        "You are Sandy's main orchestration controller.",
        "Decide whether Sandy should launch a new sub-agent task or reply directly.",
        "This thread persists across decisions for one chat, so retain prior visible context from earlier turns in this thread.",
        "If some earlier sub-agent output or privilege request details are not present in this thread, treat them as unavailable and do not invent them.",
        "Return exactly one JSON object that matches the provided schema.",
      ]
    : [
        "Continue acting as Sandy's main orchestration controller for this chat.",
        "Use the prior visible context already present in this thread plus only the new visible entries below.",
        "If some earlier sub-agent output or privilege request details are not present in this thread, treat them as unavailable and do not invent them.",
        "Return exactly one JSON object that matches the provided schema.",
      ];

  const configuredSkillsSection = input.isInitialTurn && input.skills.length > 0
    ? [
        "",
        "Configured skills available to sub-agents:",
        ...input.skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ]
    : [];

  const skillDecisionRules = input.isInitialTurn && input.skills.length > 0
    ? [
        "- You know configured skills only by the name and description listed above. Do not assume any other skill content.",
        "- If the user's request requires one of the configured skills, you must launch a sub-agent instead of replying directly.",
        "- When launching a task for a configured skill, mention the relevant skill name in the task brief when useful.",
      ]
    : [];

  return [
    ...intro,
    ...configuredSkillsSection,
    "",
    "Required JSON schema:",
    JSON.stringify(mainAgentDecisionPromptSchema, null, 2),
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
    "- Task briefs must be self-contained: include relevant context such as URLs, file paths, or specific values the user provided. The sub-agent does not see the conversation history.",
    "- Any replyText you produce is user-visible. Follow the provided channel formatting instructions exactly.",
    ...skillDecisionRules,
  ].join("\n");
}
