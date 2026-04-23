export function calculateExponentialBackoffMs(
  attempt: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const safeInitialBackoffMs = Number.isFinite(initialBackoffMs) ? Math.max(1, Math.floor(initialBackoffMs)) : 1_000;
  const safeMaxBackoffMs = Number.isFinite(maxBackoffMs)
    ? Math.max(safeInitialBackoffMs, Math.floor(maxBackoffMs))
    : safeInitialBackoffMs;
  const exponential = safeInitialBackoffMs * (2 ** (safeAttempt - 1));
  return Math.min(exponential, safeMaxBackoffMs);
}
