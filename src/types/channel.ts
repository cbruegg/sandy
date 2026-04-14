import { z } from "zod";

export const channelFormattingSchema = z.object({
  channelId: z.string().min(1),
  markup: z.enum(["telegram_html", "plain_text"]),
  allowedTags: z.array(z.string()),
  instructions: z.string(),
}).strict();

export type ChannelFormatting = z.infer<typeof channelFormattingSchema>;
