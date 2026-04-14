import { LocalTestChannelAdapter } from "./local-test-adapter.js";
import { TelegramBotApiAdapter } from "./telegram-adapter.js";
import type { SandyConfig } from "../config.js";
import type { TranscriptionProvider } from "../transcription/transcription-provider.js";

export function createChannelAdapter(
  config: SandyConfig,
  transcriptionProvider: TranscriptionProvider | null,
): TelegramBotApiAdapter | LocalTestChannelAdapter {
  switch (config.channel.kind) {
    case "local_test":
      return new LocalTestChannelAdapter({
        spoolRoot: config.channel.localTest.spoolRoot,
      });
    case "telegram":
      return new TelegramBotApiAdapter({
        token: config.channel.telegram.botToken,
        allowedUser: config.channel.telegram.allowedUser,
        transcriptionProvider: transcriptionProvider ?? undefined,
      });
  }
}
