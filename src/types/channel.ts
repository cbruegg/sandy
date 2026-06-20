export type ChannelFormatting = {
  channelId: string;
  markup: "markdown" | "plain_text";
  allowedTags: string[];
  instructions: string;
};
