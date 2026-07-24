import type { HttpTokenConfig } from "../config.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";
import { formatDateTimePrefix } from "../datetime-prefix.js";
import { logger } from "../logger.js";
import type { DecideContext, MainAgentDecision } from "../types.js";
import type { ChatId } from "../types.js";
import type { SkillMetadata } from "../skills.js";
import {
  formatMainAgentDecisionValidationError,
  mainAgentDecisionPromptSchema,
  parseMainAgentDecision,
} from "./main-agent-decision.js";
import {sandyMcpServerId, workerToolEntries} from "../subagent/worker-tools.js";
import {
  type AgentClient,
  type AuthRefreshCallback,
  denyAllServerRequests,
} from "../codex-app-server-client/app-server-client.js";
import type { ServerRequest } from "../codex-app-server-client/generated/ServerRequest.js";
import type { Input } from "@openai/codex-sdk";
import type {ThreadStartParams} from "../codex-app-server-client/generated/v2";

/**
 * Create a thread-start profile for the main agent controller.
 * Uses a read-only sandbox and "on-request" approval policy so the
 * Codex app-server exposes all MCP tools to the model.
 */
export function createMainAgentProfile(
  workingDirectory: string,
  config?: ThreadStartParams["config"],
  model?: string | null,
): ThreadStartParams {
  return {
    sandbox: "read-only",
    cwd: workingDirectory,
    personality: "none",
    // Use "on-request" instead of the default "never" so the Codex app-server
    // exposes all MCP tools (including write/destructive ones) to the model.
    // "untrusted" still hides some tools; "on-request" is fully permissive.
    approvalPolicy: "on-request" as const,
    config,
    ...(model ? { model } : {}),
  };
}

export interface MainAgentController {
  decide(context: DecideContext): Promise<MainAgentDecision>;
}

const MAX_DECISION_VALIDATION_ATTEMPTS = 3;

const noopAuthRefresh: AuthRefreshCallback = () => {
  throw new Error("Auth refresh not supported for main agent.");
};

export class CodexMainAgentController implements MainAgentController {
  private readonly appServer: AgentClient;
  private readonly model: string | null;
  private readonly getSkills: () => SkillMetadata[];
  private readonly workerMcpServerIds: string[];
  /**
   * Configured HTTP tokens keyed by token ID (from config.toml).
   * Each value carries a description used in the main-agent prompt so
   * the model knows which tokens are available for sub-agent tasks.
   */
  private readonly httpTokens: Record<string, HttpTokenConfig>;
  /**
   * Pre-built main-agent config for thread start (e.g. MemPalace MCP server).
   * An empty object means no extra servers are configured.
   */
  private readonly mainAgentConfig: ThreadStartParams["config"];
  private readonly mempalaceAvailable: boolean;
  /**
   * Active app-server thread IDs keyed by Sandy chat ID.
   * One chat may have at most one active thread at any time.
   */
  private readonly threadIds = new Map<ChatId, string>();
  /**
   * Temporary working directories keyed by Sandy chat ID.
   * Each directory is created on first use and kept for the chat lifetime.
   */
  private readonly threadDirectories = new Map<ChatId, string>();
  /**
   * Whether the next decide() call for a chat should re-inject the
   * full orchestration instructions. Set after auto-compaction is
   * detected and cleared immediately after the restored prompt is built.
   */
  private readonly needsInstructionRefresh = new Map<ChatId, boolean>();

  constructor(
    appServer: AgentClient,
    model: string | null = null,
    getSkills: () => SkillMetadata[] = () => [],
    workerMcpServerIds: string[] = [],
    httpTokens: Record<string, HttpTokenConfig> = {},
    mainAgentConfig: ThreadStartParams["config"] = {},
    mempalaceAvailable = false,
  ) {
    this.appServer = appServer;
    this.model = model;
    this.getSkills = getSkills;
    this.workerMcpServerIds = [...workerMcpServerIds].sort();
    this.httpTokens = {...httpTokens};
    this.mainAgentConfig = mainAgentConfig;
    this.mempalaceAvailable = mempalaceAvailable;
  }

  async decide(context: DecideContext): Promise<MainAgentDecision> {
    const isInitialTurn = !this.threadIds.has(context.chatId);
    const includeFullInstructions = isInitialTurn || this.needsInstructionRefresh.get(context.chatId) === true;
    if (!isInitialTurn) {
      this.needsInstructionRefresh.delete(context.chatId);
    }

    const threadId = await this.getOrCreateThreadId(context.chatId);
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
      includeFullInstructions,
      skills: this.getSkills(),
      workerMcpServerIds: this.workerMcpServerIds,
      httpTokens: this.httpTokens,
      mempalaceAvailable: this.mempalaceAvailable,
    });
    const input: Input = [{ type: "text", text: prompt }];
    const decision = await this.runValidatedDecision(threadId, input, context);
    logger.info("main_agent.decision_received", {
      chatId: context.chatId,
      action: decision.action,
      taskName: decision.action === "launch_task" ? decision.taskName : null,
    });
    return decision;
  }

  private async runValidatedDecision(
    threadId: string,
    initialInput: Input,
    context: { chatId: ChatId },
  ): Promise<MainAgentDecision> {
    let nextInput = initialInput;

    for (let attempt = 1; attempt <= MAX_DECISION_VALIDATION_ATTEMPTS; attempt += 1) {
      let finalResponse = "";
      let sawCompaction = false;

      for await (const event of this.appServer.streamTurn(
        threadId,
        nextInput,
        noopAuthRefresh,
        undefined,
        (req) => Promise.resolve(this.createServerRequestHandler(req)),
      )) {
        switch (event.method) {
          case "item/completed":
            if (event.params.item.type === "agentMessage") {
              finalResponse = event.params.item.text;
            }
            if (event.params.item.type === "contextCompaction") {
              sawCompaction = true;
              logger.info("main_agent.compaction_detected", {
                chatId: context.chatId,
                attempt,
                detectionMethod: "app_server_item",
              });
            }
            break;

          case "item/started":
            if (event.params.item.type === "contextCompaction") {
              sawCompaction = true;
              logger.info("main_agent.compaction_detected", {
                chatId: context.chatId,
                attempt,
                detectionMethod: "app_server_item",
              });
            }
            break;

          case "turn/completed":
            if (event.params.turn?.status === "failed") {
              throw new Error(`Turn failed: ${event.params.turn.error?.message ?? "Unknown turn failure."}`);
            }
            break;

          case "error":
            throw new Error(`App server error: ${event.params.error?.message ?? "Unknown app-server error."}`);
        }
      }

      if (sawCompaction) {
        this.needsInstructionRefresh.set(context.chatId, true);
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

        nextInput = [{ type: "text", text: formatMainAgentDecisionValidationError(finalResponse, error) }];
      }
    }

    throw new Error("Unreachable.");
  }

  private createServerRequestHandler(request: ServerRequest): Record<string, unknown> | null {
    // Accept mempalace MCP elicitation; delegate everything else to the deny-all default.
    if (request.method === "mcpServer/elicitation/request" && request.params.serverName === "mempalace") {
      logger.debug("main_agent.mcp_elicitation_accepted", {
        serverName: request.params.serverName,
      });
      return { action: "accept" as const, content: null, _meta: null };
    }
    const result = denyAllServerRequests(request);
    if (result !== null && request.method === "mcpServer/elicitation/request") {
      logger.debug("main_agent.mcp_elicitation_declined", {
        serverName: request.params.serverName,
      });
    }
    return result;
  }

  private async getOrCreateThreadId(chatId: ChatId): Promise<string> {
    const existing = this.threadIds.get(chatId);
    if (existing) {
      return existing;
    }
    const workingDirectory = this.getOrCreateThreadDirectory(chatId);
    const profile = createMainAgentProfile(workingDirectory, this.mainAgentConfig, this.model);
    const threadId = await this.appServer.startThread(profile);
    this.threadIds.set(chatId, threadId);
    logger.debug("main_agent.thread_started", {
      chatId,
      workingDirectory,
      threadId,
    });
    return threadId;
  }

  private getOrCreateThreadDirectory(chatId: ChatId): string {
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
  includeFullInstructions: boolean;
  skills: SkillMetadata[];
  workerMcpServerIds: string[];
  httpTokens: Record<string, HttpTokenConfig>;
  mempalaceAvailable: boolean;
}): string {
  const intro = input.includeFullInstructions
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

  const mempalaceSection = input.includeFullInstructions && input.mempalaceAvailable
    ? [
        "",
        "A MemPalace memory server is available to you via MCP. Before doing anything else, call mempalace_status to check connection health and available operations.",
        "Use MCP tool discovery to list all tools belonging to MemPalace. You probably need to call `tool_search` with query 'mempalace' and a limit of at least 50. Use the discovered tools to:",
        "- Search memories before answering questions about past events, decisions, user preferences or other information you are currently unaware of but that the user may have mentioned in other conversations.",
        "- File stable facts, preferences, and longer-lived context worth remembering. Do this especially whenever the user asks you to remember or save something.",
        "- Never delegate memory management to sub-agents.",
        "- Prefer current visible chat context over older memories.",
        "- Do not assume a memory is authoritative if it conflicts with current user input.",
        "- Before writing a task brief, search for memories relevant to the task. Include any pertinent stored facts, user preferences, or past decisions in the task brief so the sub-agent benefits from that context.",
        "- Return your decision JSON after optional tool use.",
        "- When you save or update a memory, briefly acknowledge it in your replyText so the user knows their information has been remembered.",
      ]
    : [];

  return [
    formatDateTimePrefix(),
    ...intro,
    ...configuredSkillsSection,
    ...workerMcpSection,
    ...httpTokenSection,
    ...sandyToolsSection,
    ...mempalaceSection,
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
    "- When launching a task, set autoApprovalEligibility.eligibleMcpServers and autoApprovalEligibility.eligibleHttpTokens to the configured MCP servers and HTTP tokens whose stored auto-approval rules should apply to this task.",
    "- Include a server or token in those auto-approval lists only when the user's request clearly makes it suitable for this task.",
    "- Omit configured MCP servers and HTTP tokens from those auto-approval lists when stored approvals should not auto-apply for this task; the worker can still ask the user for explicit approval.",
    "- Example: if the user asks to inspect Todoist tasks and the configured MCP server identifier is \"todoist\", set autoApprovalEligibility.eligibleMcpServers to [\"todoist\"]. If the task needs the configured HTTP token identifier \"vid2text\", set autoApprovalEligibility.eligibleHttpTokens to [\"vid2text\"].",
    "- Any replyText you produce is user-visible. Follow the provided channel formatting instructions exactly.",
    ...skillDecisionRules,
    ...skillManagementRules,
  ].join("\n");
}
