export type ChannelFormatting = {
  channelId: string;
  markup: "markdown" | "matrix_html" | "plain_text";
  allowedTags: string[];
  instructions: string;
};
