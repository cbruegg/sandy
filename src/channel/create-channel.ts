import { matrixStateRoot } from "../state-paths.js";
import { LocalTestChannelAdapter } from "./local-test-adapter.js";
import { MatrixChannelAdapter } from "./matrix-adapter.js";
import { TelegramBotApiAdapter } from "./telegram-adapter.js";
import type { SandyConfig } from "../config.js";
import type { TranscriptionProvider } from "../transcription/transcription-provider.js";

export function createChannelAdapter(
  config: SandyConfig,
  transcriptionProvider: TranscriptionProvider | null,
  matrixAccessToken: string | null,
): TelegramBotApiAdapter | MatrixChannelAdapter | LocalTestChannelAdapter {
  switch (config.channel.kind) {
    case "local_test":
      return new LocalTestChannelAdapter({
        spoolRoot: config.channel.localTest.spoolRoot,
      });
    case "matrix": {
      if (!matrixAccessToken) {
        throw new Error("Matrix access token is required but was not provided.");
      }
      return new MatrixChannelAdapter({
        homeserverUrl: config.channel.matrix.homeserverUrl,
        accessToken: matrixAccessToken,
        allowedUserId: config.channel.matrix.allowedUserId,
        stateRoot: matrixStateRoot(config.configDirectory),
        transcriptionProvider: transcriptionProvider ?? undefined,
      });
    }
    case "telegram":
      return new TelegramBotApiAdapter({
        token: config.channel.telegram.botToken,
        allowedUser: config.channel.telegram.allowedUser,
        transcriptionProvider: transcriptionProvider ?? undefined,
      });
  }
}
