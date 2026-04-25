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
    taskLanguage: z.string().min(1),
  }).strict(),
]);

export const mainAgentDecisionPromptSchema = z.toJSONSchema(mainAgentDecisionSchema);

export function formatMainAgentDecisionValidationError(raw: string, error: z.ZodError | SyntaxError): string {
  if (error instanceof SyntaxError) {
    return [
      "Your last response was not valid JSON.",
      "Return exactly one JSON object with no Markdown fences or surrounding commentary.",
      `Invalid response: ${raw}`,
      `Parser error: ${error.message}`,
      "Schema:",
      JSON.stringify(mainAgentDecisionPromptSchema, null, 2),
    ].join("\n");
  }

  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `- ${path}: ${issue.message}`;
  });

  return [
    "Your last response did not match the required schema.",
    "Return exactly one JSON object with no Markdown fences or surrounding commentary.",
    `Invalid response: ${raw}`,
    "Validation errors:",
    ...issues,
    "Schema:",
    JSON.stringify(mainAgentDecisionPromptSchema, null, 2),
  ].join("\n");
}

export function parseMainAgentDecision(raw: string): MainAgentDecision {
  return mainAgentDecisionSchema.parse(JSON.parse(raw));
}
