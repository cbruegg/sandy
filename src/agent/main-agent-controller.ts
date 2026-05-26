import type { HttpTokenConfig } from "../config.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadOptions } from "@openai/codex-sdk";
import { ZodError } from "zod";
import { formatDateTimePrefix } from "../datetime-prefix.js";
import { logger } from "../logger.js";
import type { DecideContext, MainAgentDecision } from "../types.js";
import type { SkillMetadata } from "../skills.js";
import {
  formatMainAgentDecisionValidationError,
  mainAgentDecisionPromptSchema,
  parseMainAgentDecision,
} from "./main-agent-decision.js";
import {sandyMcpServerId, workerToolEntries} from "../subagent/worker-tools.js";

export interface MainAgentController {
  decide(context: DecideContext): Promise<MainAgentDecision>;
}

// ---- streamed event types (narrow local contract, decoupled from @openai/codex-sdk) ----

type StreamedThreadEventItem = {
  type: string;
  text?: string;
  id?: string;
};

export type StreamedThreadEvent = {
  type: string;
  item?: StreamedThreadEventItem;
};

type MainAgentStreamedTurn = {
  events: AsyncGenerator<StreamedThreadEvent>;
};

type MainAgentThread = {
  runStreamed(input: string): Promise<MainAgentStreamedTurn>;
};

type CodexClient = {
  startThread(options?: ThreadOptions): MainAgentThread;
};

// ---- end streamed types ----

const COMPACTION_ITEM_TYPE = "context_compaction";
const AGENT_MESSAGE_ITEM_TYPE = "agent_message";

function isContextCompactionItem(item: StreamedThreadEventItem): boolean {
  return item.type === COMPACTION_ITEM_TYPE;
}

const MAX_DECISION_VALIDATION_ATTEMPTS = 3;

export class CodexMainAgentController implements MainAgentController {
  private readonly codex: CodexClient;
  private readonly model: string | null;
  private readonly getSkills: () => SkillMetadata[];
  private readonly workerMcpServerIds: string[];
  private readonly httpTokens: Record<string, HttpTokenConfig>;
  private readonly threads = new Map<string, MainAgentThread>();
  private readonly threadDirectories = new Map<string, string>();
  private readonly needsInstructionRefresh = new Map<string, boolean>();

  constructor(
    codex: CodexClient,
    model: string | null = null,
    getSkills: () => SkillMetadata[] = () => [],
    workerMcpServerIds: string[] = [],
    httpTokens: Record<string, HttpTokenConfig> = {},
  ) {
    this.codex = codex;
    this.model = model;
    this.getSkills = getSkills;
    this.workerMcpServerIds = [...workerMcpServerIds].sort();
    this.httpTokens = {...httpTokens};
  }

  async decide(context: DecideContext): Promise<MainAgentDecision> {
    const isInitialTurn = !this.threads.has(context.chatId);
    const includeFullInstructions = isInitialTurn || this.needsInstructionRefresh.get(context.chatId) === true;
    if (!isInitialTurn) {
      this.needsInstructionRefresh.delete(context.chatId);
    }

    const thread = this.getOrCreateThread(context.chatId);
    logger.info("main_agent.decision_requested", {
      chatId: context.chatId,
      newVisibleEntryCount: context.newVisibleEntries.length,
      hasActiveTask: context.activeTask !== null,
      includeFullInstructions,
      isInitialTurn,
    });
    const prompt = buildMainAgentPrompt({
      activeTask: context.activeTask,
      channelFormatting: context.channelFormatting,
      newVisibleEntries: context.newVisibleEntries,
      isInitialTurn,
      includeFullInstructions,
      skills: this.getSkills(),
      workerMcpServerIds: this.workerMcpServerIds,
      httpTokens: this.httpTokens,
    });
    const decision = await this.runValidatedDecision(thread, prompt, context);
    logger.info("main_agent.decision_received", {
      chatId: context.chatId,
      action: decision.action,
      taskName: decision.action === "launch_task" ? decision.taskName : null,
    });
    return decision;
  }

  private async runValidatedDecision(
    thread: MainAgentThread,
    prompt: string,
    context: { chatId: string },
  ): Promise<MainAgentDecision> {
    let nextInput = prompt;

    for (let attempt = 1; attempt <= MAX_DECISION_VALIDATION_ATTEMPTS; attempt += 1) {
      const turn = await thread.runStreamed(nextInput);
      let finalResponse = "";
      let sawCompaction = false;

      for await (const event of turn.events) {
        if (event.type === "item.started" || event.type === "item.completed") {
          if (event.item && isContextCompactionItem(event.item)) {
            sawCompaction = true;
          }
          if (
            event.type === "item.completed" &&
            event.item?.type === AGENT_MESSAGE_ITEM_TYPE &&
            event.item.text !== undefined
          ) {
            finalResponse = event.item.text;
          }
        }
      }

      if (sawCompaction) {
        this.needsInstructionRefresh.set(context.chatId, true);
        logger.info("main_agent.compaction_detected", {
          chatId: context.chatId,
          attempt,
        });
      }

      logger.debugContent("main_agent.model_response", {
        chatId: context.chatId,
        attempt,
        response: finalResponse,
      });
      try {
        return parseMainAgentDecision(finalResponse);
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof ZodError)) {
          throw error;
        }

        logger.warn("main_agent.decision_validation_failed", {
          chatId: context.chatId,
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

        nextInput = formatMainAgentDecisionValidationError(finalResponse, error);
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
    const thread = this.codex.startThread(buildMainAgentThreadOptions(workingDirectory, this.model));
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

export function buildMainAgentThreadOptions(workingDirectory: string, model: string | null = null): ThreadOptions {
  return {
    approvalPolicy: "never",
    ...(model ? { model } : {}),
    sandboxMode: "read-only",
    workingDirectory,
    skipGitRepoCheck: true,
  };
}

function buildSandyToolsPromptSection(): string {
  const lines = [
    `The MCP server "${sandyMcpServerId}" available to the worker/sub-agent exposes these host-integration tools:`,
    ...workerToolEntries.map((tool) => {
      return `- ${tool.name}: ${tool.description}`;
    }),
  ];
  return lines.join("\n");
}

export function buildMainAgentPrompt(input: {
  newVisibleEntries: DecideContext["newVisibleEntries"];
  activeTask: DecideContext["activeTask"];
  channelFormatting: DecideContext["channelFormatting"];
  isInitialTurn: boolean;
  includeFullInstructions: boolean;
  skills: SkillMetadata[];
  workerMcpServerIds: string[];
  httpTokens: Record<string, HttpTokenConfig>;
}): string {
  const intro = input.includeFullInstructions
    ? [
        "You are Sandy's main orchestration controller.",
        "Decide whether Sandy should launch a new sub-agent task or reply directly.",
        "This thread persists across decisions for one chat. Some prior context may have been compacted; use only the visible entries below plus any prior context still present in this thread.",
        "If some earlier sub-agent output or privilege request details are not present in this thread, treat them as unavailable and do not invent them.",
        "Return exactly one JSON object that matches the provided schema.",
      ]
    : [
        "Continue acting as Sandy's main orchestration controller for this chat.",
        "Use the prior visible context already present in this thread plus only the new visible entries below.",
        "If some earlier sub-agent output or privilege request details are not present in this thread, treat them as unavailable and do not invent them.",
        "Return exactly one JSON object that matches the provided schema.",
      ];

  const configuredSkillsSection = input.skills.length > 0
    ? [
        "",
        "Configured skills available to sub-agents:",
        ...input.skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ]
    : [];

  const workerMcpSection = input.includeFullInstructions && input.workerMcpServerIds.length > 0
    ? [
        "",
        "Configured MCP servers available to sub-agents:",
        ...input.workerMcpServerIds.map((serverId) => `- ${serverId}`),
      ]
    : [];

  const httpTokenEntries = Object.entries(input.httpTokens);
  const httpTokenSection = input.includeFullInstructions && httpTokenEntries.length > 0
    ? [
        "",
        "Configured HTTP tokens available to sub-agents:",
        ...httpTokenEntries.map(([tokenId, token]) => `- ${tokenId}: ${token.description}`),
      ]
    : [];

  const sandyToolsSection = input.includeFullInstructions
    ? [
        "",
        buildSandyToolsPromptSection(),
      ]
    : [];

  const skillDecisionRules = input.includeFullInstructions && input.skills.length > 0
    ? [
        "- You know configured skills only by the name and description listed above. Do not assume any other skill content.",
        "- If the user's request requires one of the configured skills, you must launch a sub-agent instead of replying directly.",
        "- When launching a task for a configured skill, mention the relevant skill name in the task brief when useful.",
      ]
    : [];

  const skillManagementRules = input.includeFullInstructions
    ? [
        "- If the user asks to list, add, edit, or remove Sandy skills, you must launch a sub-agent task instead of replying directly.",
        "- The sub-agent can use the create_skill, update_skill, and delete_skill host tools to perform skill changes.",
        "- Every skill mutation requires explicit user approval and cannot be auto-approved.",
      ]
    : [];

  return [
    formatDateTimePrefix(),
    ...intro,
    ...configuredSkillsSection,
    ...workerMcpSection,
    ...httpTokenSection,
    ...sandyToolsSection,
    "",
    "Required JSON schema:",
    JSON.stringify(mainAgentDecisionPromptSchema, null, 2),
    "",
    input.includeFullInstructions ? "Visible chat entries for this decision:" : "New visible chat entries since your last decision:",
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
    "- If you cannot handle a task yourself, try to launch a task to let a sub-agent try.",
    "- Reply directly for purely conversational requests or when no sub-agent work is useful.",
    "- Task names must be short, stable, and descriptive.",
    "- When launching a task, set taskLanguage to the language the sub-agent should use for user-facing output.",
    "- Choose taskLanguage using the visible conversation history and the task about to be started (for example: English, Spanish, French).",
    "- Task briefs must contain only the minimum instructions needed by the sub-agent.",
    "- Task briefs must be self-contained: include relevant context such as URLs, file paths, or specific values the user provided. The sub-agent does not see the conversation history.",
    "- When launching a task, set taskPolicy.autoApproveMcpServers and taskPolicy.autoApproveHttpTokens to the configured MCP servers and HTTP tokens whose stored auto-approval rules should apply to this task.",
    "- Include a server or token in those auto-approval lists only when the user's request clearly makes it suitable for this task.",
    "- Omit configured MCP servers and HTTP tokens from those auto-approval lists when stored approvals should not auto-apply for this task; the worker can still ask the user for explicit approval.",
    "- Example: if the user asks to inspect Todoist tasks and the configured MCP server identifier is \"todoist\", set taskPolicy.autoApproveMcpServers to [\"todoist\"]. If the task needs the configured HTTP token identifier \"vid2text\", set taskPolicy.autoApproveHttpTokens to [\"vid2text\"].",
    "- Any replyText you produce is user-visible. Follow the provided channel formatting instructions exactly.",
    ...skillDecisionRules,
    ...skillManagementRules,
  ].join("\n");
}
