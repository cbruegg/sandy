export type ChannelFormatting = {
  channelId: string;
  markup: "telegram_html" | "matrix_html" | "plain_text";
  allowedTags: string[];
  instructions: string;
};
