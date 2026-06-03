import { GrammyError } from "grammy";
import { logger } from "../logger.js";
import { calculateExponentialBackoffMs } from "./exponential-backoff.js";

const TELEGRAM_SEND_MAX_ATTEMPTS = 4;

export type TelegramSleep = (delayMs: number) => Promise<void>;

export async function runWithTelegramSendRetry<T>(
  operationName: string,
  operation: () => Promise<T>,
  sleep: TelegramSleep,
): Promise<T> {
  for (let attempt = 1; attempt <= TELEGRAM_SEND_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryAfterMs = extractTelegramRetryAfterMs(error);
      if (attempt >= TELEGRAM_SEND_MAX_ATTEMPTS || retryAfterMs === null) {
        throw error;
      }
      const fallbackBackoffMs = calculateExponentialBackoffMs(attempt, 2_000, 30_000);
      const backoffMs = retryAfterMs === undefined
        ? fallbackBackoffMs
        : Math.max(fallbackBackoffMs, retryAfterMs);
      logger.warn("telegram.send_retry_scheduled", {
        operationName,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: TELEGRAM_SEND_MAX_ATTEMPTS,
        backoffMs,
        retryAfterMs: retryAfterMs ?? null,
        message: error instanceof Error ? error.message : "Unknown Telegram send failure.",
      });
      await sleep(backoffMs);
    }
  }

  throw new Error(`Unreachable Telegram retry exhaustion for ${operationName}.`);
}

/**
 * Retry any error (not just 429) with exponential backoff.
 * Used for multi-chunk sends where the outer retry wrapper could duplicate
 * already-sent chunks if it restarts the whole operation.
 */
export async function runWithTelegramChunkRetry<T>(
  operationName: string,
  operation: () => Promise<T>,
  sleep: TelegramSleep,
): Promise<T> {
  for (let attempt = 1; attempt <= TELEGRAM_SEND_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= TELEGRAM_SEND_MAX_ATTEMPTS) {
        throw error;
      }
      const retryAfterMs = extractTelegramRetryAfterMs(error);
      const fallbackBackoffMs = calculateExponentialBackoffMs(attempt, 2_000, 30_000);
      const backoffMs = retryAfterMs === undefined || retryAfterMs === null
        ? fallbackBackoffMs
        : Math.max(fallbackBackoffMs, retryAfterMs);
      logger.warn("telegram.chunk_retry_scheduled", {
        operationName,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: TELEGRAM_SEND_MAX_ATTEMPTS,
        backoffMs,
        message: error instanceof Error ? error.message : "Unknown Telegram send failure.",
      });
      await sleep(backoffMs);
    }
  }

  throw new Error(`Unreachable Telegram chunk retry exhaustion for ${operationName}.`);
}

function extractTelegramRetryAfterMs(error: unknown): number | undefined | null {
  if (!(error instanceof GrammyError)) {
    return null;
  }

  if (error.error_code !== 429) {
    return null;
  }

  const retryAfter = error.parameters.retry_after;
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter <= 0) {
    return undefined;
  }

  return Math.ceil(retryAfter * 1_000);
}
