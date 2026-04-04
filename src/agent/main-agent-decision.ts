import { z } from "zod";
import type { MainAgentDecision } from "../types.js";

const mainAgentDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("reply"),
    replyText: z.string(),
  }).strict(),
  z.object({
    action: z.literal("launch_task"),
    taskBrief: z.string(),
    taskName: z.string(),
  }).strict(),
]);
export const mainAgentDecisionOutputSchema = z.toJSONSchema(mainAgentDecisionSchema);

export function parseMainAgentDecision(raw: string): MainAgentDecision {
  return mainAgentDecisionSchema.parse(JSON.parse(raw));
}
