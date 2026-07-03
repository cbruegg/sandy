import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Input } from "@openai/codex-sdk";
import { createMainAgentProfile } from "../agent/main-agent-controller.js";
import {
  type AgentClient,
  type AuthRefreshCallback,
  denyAllServerRequests,
} from "../codex-app-server-client/app-server-client.js";
import type { ThreadStartParams } from "../codex-app-server-client/generated/v2";
import type { ServerRequest } from "../codex-app-server-client/generated/ServerRequest.js";
import { formatDateTimePrefix } from "../datetime-prefix.js";
import type { JobDefinition } from "../jobs/job-validation.js";
import { logger } from "../logger.js";
import type { SkillDetails, SkillService } from "../skills.js";

export type JobTaskMemoryContextInput = {
  readonly job: JobDefinition;
  readonly workspacePath: string | null;
};

export interface TaskMemoryContextCollector {
  collectForJobTask(input: JobTaskMemoryContextInput): Promise<string | null>;
}

export class NoopTaskMemoryContextCollector implements TaskMemoryContextCollector {
  collectForJobTask(_input: JobTaskMemoryContextInput): Promise<string | null> {
    return Promise.resolve(null);
  }
}

const noopAuthRefresh: AuthRefreshCallback = () => {
  throw new Error("Auth refresh not supported for memory context collection.");
};

const MAX_MEMORY_CONTEXT_LENGTH = 10_000;

export class MempalaceTaskMemoryContextCollector implements TaskMemoryContextCollector {
  private readonly appServer: AgentClient;
  private readonly model: string | null;
  private readonly mainAgentConfig: ThreadStartParams["config"];
  private readonly skillService: SkillService;
  private threadId: string | null = null;
  private readonly workingDirectory: string;

  constructor(
    appServer: AgentClient,
    model: string | null,
    mainAgentConfig: ThreadStartParams["config"],
    skillService: SkillService,
  ) {
    this.appServer = appServer;
    this.model = model;
    this.mainAgentConfig = mainAgentConfig;
    this.skillService = skillService;
    this.workingDirectory = mkdtempSync(join(tmpdir(), "sandy-memory-context-"));
  }

  async collectForJobTask(input: JobTaskMemoryContextInput): Promise<string | null> {
    const threadId = await this.getOrCreateThreadId();
    const skill = this.skillService.getSkill(input.job.skillId);
    const prompt = buildJobTaskMemoryContextPrompt(input, skill);
    const agentInput: Input = [{ type: "text", text: prompt }];
    let finalResponse = "";

    try {
      for await (const event of this.appServer.streamTurn(
        threadId,
        agentInput,
        noopAuthRefresh,
        undefined,
        (request) => Promise.resolve(handleMempalaceMemoryServerRequest(request)),
      )) {
        switch (event.method) {
          case "item/completed":
            if (event.params.item.type === "agentMessage") {
              finalResponse = event.params.item.text;
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
    } catch (error) {
      logger.warn("memory.job_context_collection_failed", {
        jobId: input.job.id,
        message: error instanceof Error ? error.message : "Unknown memory context collection failure.",
      });
      return null;
    }

    const normalized = normalizeCollectedMemoryContext(finalResponse);
    logger.info("memory.job_context_collection_completed", {
      jobId: input.job.id,
      hasContext: normalized !== null,
    });
    return normalized;
  }

  private async getOrCreateThreadId(): Promise<string> {
    if (this.threadId) {
      return this.threadId;
    }

    const profile = createMainAgentProfile(this.workingDirectory, this.mainAgentConfig, this.model);
    this.threadId = await this.appServer.startThread(profile);
    logger.debug("memory.context_thread_started", {
      workingDirectory: this.workingDirectory,
      threadId: this.threadId,
    });
    return this.threadId;
  }
}

function buildJobTaskMemoryContextPrompt(input: JobTaskMemoryContextInput, skill: SkillDetails | null): string {
  return [
    formatDateTimePrefix(),
    "A MemPalace memory server is available to you via MCP.",
    "Use MCP tool discovery to find the MemPalace tools, then search for memories relevant to this scheduled Sandy job.",
    "Return only concise facts, user preferences, prior decisions, recurring context, or other stable background that may help the worker complete this exact job.",
    "Do not include irrelevant memories. Do not invent context. Do not update or save memories.",
    "If nothing relevant is found, return exactly: none",
    "",
    "Scheduled job:",
    `- id: ${input.job.id}`,
    `- name: ${input.job.name}`,
    `- skill id: ${input.job.skillId}`,
    skill ? `- skill name: ${skill.name}` : "- skill name: unknown",
    skill ? `- skill description: ${skill.description}` : "- skill description: unknown",
    skill ? `- skill instructions: ${skill.body}` : "- skill instructions: unknown",
    `- schedule: ${JSON.stringify(input.job.schedule)}`,
    input.workspacePath ? `- persistent workspace path: ${input.workspacePath}` : "- persistent workspace path: none",
  ].join("\n");
}

function handleMempalaceMemoryServerRequest(request: ServerRequest): Record<string, unknown> | null {
  if (request.method === "mcpServer/elicitation/request" && request.params.serverName === "mempalace") {
    logger.debug("memory.mcp_elicitation_accepted", {
      serverName: request.params.serverName,
    });
    return { action: "accept" as const, content: null, _meta: null };
  }
  const result = denyAllServerRequests(request);
  if (result !== null && request.method === "mcpServer/elicitation/request") {
    logger.debug("memory.mcp_elicitation_declined", {
      serverName: request.params.serverName,
    });
  }
  return result;
}

function normalizeCollectedMemoryContext(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /^none\.?$/i.test(trimmed)) {
    return null;
  }
  if (trimmed.length <= MAX_MEMORY_CONTEXT_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_MEMORY_CONTEXT_LENGTH).trimEnd()}\n[Memory context truncated by Sandy.]`;
}
