import { Codex, type Thread } from "@openai/codex-sdk";
import { logger } from "../logger.js";
import type { DecideContext, MainAgentDecision } from "../types.js";
import { parseMainAgentDecision } from "../types.js";

export interface MainAgentController {
  decide(context: DecideContext): Promise<MainAgentDecision>;
}

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
  private readonly codex: Codex;
  private readonly threads = new Map<string, Thread>();

  constructor(codex?: Codex) {
    this.codex = codex ?? new Codex();
  }

  async decide(context: DecideContext): Promise<MainAgentDecision> {
    const thread = this.getThread(context.chatId);
    logger.info("main_agent.decision_requested", {
      chatId: context.chatId,
      transcriptLength: context.transcript.length,
      hasActiveTask: context.activeTask !== null,
    });
    const turn = await thread.run(buildMainAgentPrompt(context), {
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

  private getThread(chatId: string): Thread {
    const existing = this.threads.get(chatId);
    if (existing) {
      return existing;
    }
    const thread = this.codex.startThread({
      skipGitRepoCheck: true,
    });
    this.threads.set(chatId, thread);
    logger.debug("main_agent.thread_started", {
      chatId,
    });
    return thread;
  }
}

export function buildMainAgentPrompt(context: DecideContext): string {
  return [
    "You are Sandy's main orchestration controller.",
    "Decide whether Sandy should launch a new sub-agent task or reply directly.",
    "You only receive the normalized chat transcript plus host-side task metadata.",
    "If some earlier sub-agent output or privilege request details are not present in this prompt, treat them as unavailable and do not invent them.",
    "Return JSON that matches the provided schema.",
    "",
    "Normalized chat transcript:",
    JSON.stringify(context.transcript, null, 2),
    "",
    "Active task metadata:",
    JSON.stringify(context.activeTask, null, 2),
    "",
    "Decision rules:",
    "- Choose between replying directly and launching a task based on the user's likely intent and the current conversation state.",
    "- It is acceptable to launch a task proactively when that is the best way for Sandy to investigate, inspect, or execute something for the user.",
    "- Reply directly for purely conversational requests or when no sub-agent work is useful.",
    "- Task names must be short, stable, and descriptive.",
    "- Task briefs must contain only the minimum instructions needed by the sub-agent.",
  ].join("\n");
}
