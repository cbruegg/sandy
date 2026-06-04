export type ChannelFormatting = {
  channelId: string;
  markup: "telegram_markdown" | "matrix_html" | "plain_text";
  allowedTags: string[];
  instructions: string;
};
