import { matrixStateRoot } from "../state-paths.js";
import { ImplicitChannelDestinationStore, PersistentChannelDestinationStore, type ChannelDestinationStore } from "./channel-destination-store.js";
import { LocalTestChannelAdapter } from "./local-test-adapter.js";
import { MatrixChannelAdapter } from "./matrix-adapter.js";
import { TelegramBotApiAdapter } from "./telegram-adapter.js";
import type { SandyConfig } from "../config.js";
import type { TranscriptionProvider } from "../transcription/transcription-provider.js";

export type CreatedChannel = {
  adapter: TelegramBotApiAdapter | MatrixChannelAdapter | LocalTestChannelAdapter;
  destinationStore: ChannelDestinationStore;
};

export function createChannelAdapter(
  config: SandyConfig,
  transcriptionProvider: TranscriptionProvider | null,
  matrixAccessToken: string | null,
): CreatedChannel {
  switch (config.channel.kind) {
    case "local_test":
      return {
        adapter: new LocalTestChannelAdapter({
          spoolRoot: config.channel.localTest.spoolRoot,
        }),
        destinationStore: new ImplicitChannelDestinationStore("local-test"),
      };
    case "matrix": {
      if (!matrixAccessToken) {
        throw new Error("Matrix access token is required but was not provided.");
      }
      return {
        adapter: new MatrixChannelAdapter({
          homeserverUrl: config.channel.matrix.homeserverUrl,
          accessToken: matrixAccessToken,
          allowedUserId: config.channel.matrix.allowedUserId,
          stateRoot: matrixStateRoot(config.configDirectory),
          transcriptionProvider: transcriptionProvider ?? undefined,
        }),
        destinationStore: new PersistentChannelDestinationStore(config.configDirectory, "matrix"),
      };
    }
    case "telegram":
      return {
        adapter: new TelegramBotApiAdapter({
          token: config.channel.telegram.botToken,
          allowedUser: config.channel.telegram.allowedUser,
          transcriptionProvider: transcriptionProvider ?? undefined,
        }),
        destinationStore: new PersistentChannelDestinationStore(config.configDirectory, "telegram"),
      };
  }
}
