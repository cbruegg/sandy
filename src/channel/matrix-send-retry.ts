import { logger } from "../logger.js";
import { calculateExponentialBackoffMs } from "./exponential-backoff.js";

const MATRIX_SEND_MAX_ATTEMPTS = 4;

export type MatrixSleep = (delayMs: number) => Promise<void>;

// While we have generic retry logic for sending messages, Matrix rate limit
// errors contain a desired backoff time from the server, so we handle Matrix
// rate limits in a dedicated way.
export async function runWithMatrixSendRetry<T>(
  operationName: string,
  operation: () => Promise<T>,
  sleep: MatrixSleep,
): Promise<T> {
  for (let attempt = 1; attempt <= MATRIX_SEND_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryAfterMs = extractMatrixRetryAfterMs(error);
      if (attempt >= MATRIX_SEND_MAX_ATTEMPTS || retryAfterMs === null) {
        throw error;
      }
      const fallbackBackoffMs = calculateExponentialBackoffMs(attempt, 2_000, 30_000);
      const backoffMs = Math.max(fallbackBackoffMs, retryAfterMs);
      logger.warn("matrix.send_retry_scheduled", {
        operationName,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: MATRIX_SEND_MAX_ATTEMPTS,
        backoffMs,
        retryAfterMs,
        message: error instanceof Error ? error.message : "Unknown Matrix send failure.",
      });
      await sleep(backoffMs);
    }
  }

  throw new Error(`Unreachable Matrix retry exhaustion for ${operationName}.`);
}

function extractMatrixRetryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const candidate = "retryAfterMs" in error
    ? (error as { retryAfterMs?: unknown }).retryAfterMs
    : "body" in error && error.body && typeof error.body === "object" && "retry_after_ms" in error.body
      ? (error.body as { retry_after_ms?: unknown }).retry_after_ms
      : null;

  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) {
    return null;
  }

  return Math.ceil(candidate);
}

export async function sleepMs(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
