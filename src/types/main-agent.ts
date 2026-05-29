import { z } from "zod";
import type { ChannelFormatting } from "./channel.js";
import type { ActiveTaskState } from "./task-state.js";
import type { TranscriptEntry } from "./transcript.js";

const mainAgentTaskPolicySchema = z.object({
  autoApproveMcpServers: z.array(z.string().min(1)).default([]),
  autoApproveHttpTokens: z.array(z.string().min(1)).default([]),
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
    taskPolicy: mainAgentTaskPolicySchema.default({ autoApproveMcpServers: [], autoApproveHttpTokens: [] }),
  }).strict(),
]);

export type MainAgentDecision = z.input<typeof mainAgentDecisionSchema>;
export type MainAgentTaskPolicy = z.infer<typeof mainAgentTaskPolicySchema>;
export type MainAgentTaskPolicyInput = z.input<typeof mainAgentTaskPolicySchema>;

export type DecideContext = {
  chatId: string;
  newVisibleEntries: TranscriptEntry[];
  activeTask: ActiveTaskState | null;
  channelFormatting: ChannelFormatting;
};
