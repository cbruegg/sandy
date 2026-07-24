import { z } from "zod";
import type { ChannelFormatting } from "./channel.js";
import type { ActiveTaskState } from "./task-state.js";
import type { TranscriptEntry } from "./transcript.js";
import type { ChatId } from "./chat-events.js";

const taskAutoApprovalEligibilitySchema = z.object({
  eligibleMcpServers: z.array(z.string().min(1)).default([]),
  eligibleHttpTokens: z.array(z.string().min(1)).default([]),
}).strict();

export const mainAgentDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("reply"),
    replyText: z.string(),
  }).strict(),
  z.object({
    action: z.literal("launch_task"),
    taskBrief: z.string(),
    taskName: z.string(),
    taskLanguage: z.string().min(1),
    autoApprovalEligibility: taskAutoApprovalEligibilitySchema.default({ eligibleMcpServers: [], eligibleHttpTokens: [] }),
  }).strict(),
]);

export type MainAgentDecision = z.input<typeof mainAgentDecisionSchema>;
export type TaskAutoApprovalEligibility = z.infer<typeof taskAutoApprovalEligibilitySchema>;
export type TaskAutoApprovalEligibilityInput = z.input<typeof taskAutoApprovalEligibilitySchema>;

export type DecideContext = {
  chatId: ChatId;
  newVisibleEntries: TranscriptEntry[];
  activeTask: ActiveTaskState | null;
  channelFormatting: ChannelFormatting;
};
