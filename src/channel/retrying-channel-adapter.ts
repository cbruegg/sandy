import { logger } from "../logger.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import { calculateExponentialBackoffMs } from "./exponential-backoff.js";

const CHANNEL_SEND_MAX_ATTEMPTS = 5;

type RetryingChannelAdapterOptions = {
  maxSendAttempts?: number;
  calculateBackoffMs?: (attempt: number) => number;
  sleep?: (delayMs: number) => Promise<void>;
};

export function createRetryingChannelAdapter(
  adapter: ChannelAdapter,
  onFailure: (error: unknown, source: string) => void,
  options: RetryingChannelAdapterOptions = {},
): ChannelAdapter {
  const maxSendAttempts = options.maxSendAttempts ?? CHANNEL_SEND_MAX_ATTEMPTS;
  const calculateBackoffMs = options.calculateBackoffMs ?? ((attempt: number) => calculateExponentialBackoffMs(attempt, 1_000, 30_000));
  const sleep = options.sleep ?? sleepMs;

  const failFast = async <T>(source: string, operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      onFailure(error, source);
      throw error;
    }
  };

  const retrySend = async <T>(source: string, operation: () => Promise<T>): Promise<T> => {
    const safeMaxAttempts = Number.isFinite(maxSendAttempts)
      ? Math.max(1, Math.floor(maxSendAttempts))
      : CHANNEL_SEND_MAX_ATTEMPTS;

    for (let attempt = 1; attempt <= safeMaxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= safeMaxAttempts) {
          onFailure(error, source);
          throw error;
        }
        const backoffMs = calculateBackoffMs(attempt);
        logger.warn("channel.send_retry_scheduled", {
          source,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: safeMaxAttempts,
          backoffMs,
          message: error instanceof Error ? error.message : "Unknown channel send failure.",
        });
        await sleep(backoffMs);
      }
    }

    throw new Error(`Unreachable retry exhaustion for ${source}.`);
  };

  return {
    getFormatting: () => adapter.getFormatting(),
    start: (handler) => failFast("channel.start", () => adapter.start(handler)),
    stop: () => failFast("channel.stop", () => adapter.stop()),
    saveAttachments: (chatId, attachments, targetDirectory) =>
      failFast("channel.saveAttachments", () => adapter.saveAttachments(chatId, attachments, targetDirectory)),
    sendFile: (chatId, filePath, caption) =>
      retrySend("channel.sendFile", () => adapter.sendFile(chatId, filePath, caption)),
    sendText: (chatId, text) =>
      retrySend("channel.sendText", () => adapter.sendText(chatId, text)),
    sendTaskUpdate: (chatId, text) =>
      retrySend("channel.sendTaskUpdate", () => adapter.sendTaskUpdate(chatId, text)),
    sendReportableText: (chatId, text) =>
      retrySend("channel.sendReportableText", () => adapter.sendReportableText(chatId, text)),
    sendPrivilegeRequest: (chatId, request) =>
      retrySend("channel.sendPrivilegeRequest", () => adapter.sendPrivilegeRequest(chatId, request)),
    sendShareDeletionRequest: (chatId, requestId, taskName, summary) =>
      retrySend(
        "channel.sendShareDeletionRequest",
        () => adapter.sendShareDeletionRequest(chatId, requestId, taskName, summary),
      ),
  };
}

async function sleepMs(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
