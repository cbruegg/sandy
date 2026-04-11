import type { ChannelFormatting } from "./channel.js";
import type { ActiveTaskState } from "./task-state.js";
import type { TranscriptEntry } from "./transcript.js";

export type MainAgentDecision =
  | {
      action: "reply";
      replyText: string;
    }
  | {
      action: "launch_task";
      taskBrief: string;
      taskName: string;
    };

export type DecideContext = {
  chatId: string;
  newVisibleEntries: TranscriptEntry[];
  activeTask: ActiveTaskState | null;
  channelFormatting: ChannelFormatting;
};
