import { Codex, type Thread } from "@openai/codex-sdk";
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
    const turn = await thread.run(buildMainAgentPrompt(context), {
      outputSchema: decisionSchema,
    });

    return parseMainAgentDecision(turn.finalResponse);
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
    return thread;
  }
}

export function buildMainAgentPrompt(context: DecideContext): string {
  return [
    "You are Sandy's main orchestration controller.",
    "Decide whether Sandy should launch a new sub-agent task or reply directly.",
    "You only receive the normalized chat transcript plus host-side task metadata.",
    "Never assume access to hidden sub-agent output or privilege request text.",
    "Return JSON that matches the provided schema.",
    "",
    "Normalized chat transcript:",
    JSON.stringify(context.transcript, null, 2),
    "",
    "Active task metadata:",
    JSON.stringify(context.activeTask, null, 2),
    "",
    "Decision rules:",
    "- Reply directly for conversational requests, unsupported follow-ups, or when no sandboxed task is needed.",
    "- Launch a task only when the user is asking Sandy to execute or inspect something in a sandbox.",
    "- Task names must be short, stable, and descriptive.",
    "- Task briefs must contain only the minimum instructions needed by the sub-agent.",
  ].join("\n");
}
