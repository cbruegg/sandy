import { logger } from "../logger.js";
import type { JobStore } from "./job-store.js";

/**
 * Periodically deletes one-shot jobs whose lastRunAt is older than
 * `retentionMs` (default 14 days) and whose scheduled run was consumed.
 */
export class JobCleanupService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: JobStore,
    private readonly retentionMs: number = 14 * 24 * 60 * 60 * 1000,
    private readonly intervalMs: number = 24 * 60 * 60 * 1000,
  ) {}

  start(): void {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runOnce(): Promise<void> {
    try {
      const cutoff = Date.now() - this.retentionMs;
      const deleted = await this.store.deleteOldOneShots(cutoff);
      if (deleted > 0) {
        logger.info("job.cleanup", {
          deletedCount: deleted,
          cutoff: new Date(cutoff).toISOString(),
        });
      }
    } catch (error) {
      logger.error("job.cleanup_failed", error);
    }
  }
}
