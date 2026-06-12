import type { ChannelLayerInput, ChannelLayerResult } from "./types.js";
import { logger } from "../logger.js";
import { createChannelAdapter } from "../channel/create-channel.js";
import { createRetryingChannelAdapter } from "../channel/retrying-channel-adapter.js";

export function createChannelLayer(input: ChannelLayerInput): ChannelLayerResult {
  const { config, transcriptionProvider, matrixAccessToken } = input;

  const rawChannel = createChannelAdapter(config, transcriptionProvider, matrixAccessToken);

  let rejectFatalError: ((error: Error) => void) | null = null;
  const fatalErrorPromise = new Promise<never>((_, reject) => {
    rejectFatalError = (error: Error) => reject(error);
  });

  // The shutdown function is set later by app.ts via setShutdown()
  // once the composite shutdown is available.
  let compositeShutdown: (() => Promise<void>) | null = null;
  let fatalErrorTriggered = false;

  const triggerFatalChannelError = (error: unknown, source: string): void => {
    if (fatalErrorTriggered) {
      return;
    }
    fatalErrorTriggered = true;
    const wrappedError = error instanceof Error ? error : new Error(`Fatal channel error from ${source}.`);
    logger.error("app.fatal_channel_error", wrappedError, `Fatal channel error from ${source}.`, {
      source,
    });
    void compositeShutdown?.().finally(() => rejectFatalError?.(wrappedError));
  };

  const channel = createRetryingChannelAdapter(rawChannel, triggerFatalChannelError);
  const channelFormatting = channel.getFormatting();

  const stop = async (): Promise<void> => {
    await channel.stop();
  };

  /** Set the composite shutdown function so the channel can trigger it on fatal errors. */
  const setShutdown = (fn: () => Promise<void>): void => {
    compositeShutdown = fn;
  };

  return {
    name: "channel",
    rawChannel,
    channel,
    channelFormatting,
    triggerFatalChannelError,
    fatalErrorPromise,
    setShutdown,
    stop,
  };
}