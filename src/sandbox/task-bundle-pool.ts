import {logger} from "../logger.js";
import type {ReservedTaskBundle, TaskBundle, TaskBundleLauncher, TaskBundlePool} from "./task-bundle-types.js";

export class TaskBundlePoolImpl implements TaskBundlePool {
  private standby: TaskBundle | null = null;
  private warming: Promise<TaskBundle> | null = null;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly activeBundles = new Map<string, ReservedTaskBundle>();
  private acquireLock: Promise<void> = Promise.resolve();

  constructor(private readonly launcher: TaskBundleLauncher) {}

  start(): void {
    if (this.shuttingDown) {
      return;
    }
    this.scheduleReplenish();
  }

  async acquire(taskId: string): Promise<ReservedTaskBundle> {
    if (this.shuttingDown) {
      throw new Error("Pool is shutting down");
    }

    const previousLock = this.acquireLock;
    let releaseLock: () => void;
    this.acquireLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previousLock;

    try {
      if (this.shuttingDown) {
        throw new Error("Pool is shutting down");
      }

      let bundle: TaskBundle;
      if (this.standby) {
        bundle = this.standby;
        this.standby = null;
      } else if (this.warming) {
        try {
          bundle = await this.warming;
        } catch {
          if (this.shuttingDown) {
            throw new Error("Pool is shutting down");
          }
          bundle = await this.launcher.createBundle();
        }
        if (this.standby === bundle) {
          this.standby = null;
        }
      } else {
        bundle = await this.launcher.createBundle();
      }

      const reserved: ReservedTaskBundle = {...bundle, taskId};
      this.activeBundles.set(taskId, reserved);
      this.scheduleReplenish();
      return reserved;
    } finally {
      releaseLock!();
    }
  }

  async retireBundle(bundle: ReservedTaskBundle): Promise<void> {
    this.activeBundles.delete(bundle.taskId);
    await this.launcher.terminateBundle(bundle);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shuttingDown = true;

    this.shutdownPromise = (async () => {
      await this.acquireLock;

      if (this.standby) {
        await this.launcher.destroyBundle(this.standby);
        this.standby = null;
      }

      if (this.warming) {
        try {
          const bundle = await this.warming;
          await this.launcher.destroyBundle(bundle);
        } catch {
          // Ignore warming failures during shutdown.
        }
        this.warming = null;
      }

      const active = Array.from(this.activeBundles.values());
      this.activeBundles.clear();
      await Promise.all(active.map((b) => this.launcher.terminateBundle(b)));
    })();

    return this.shutdownPromise;
  }

  private scheduleReplenish(): void {
    if (this.shuttingDown) {
      return;
    }
    if (this.standby || this.warming) {
      return;
    }

    const warmingPromise = this.launcher
      .createBundle()
      .then((bundle) => {
        if (this.shuttingDown) {
          void this.launcher.destroyBundle(bundle);
          throw new Error("Pool is shutting down");
        }
        this.standby = bundle;
        return bundle;
      })
      .catch((error) => {
        if (!this.shuttingDown) {
          logger.error("pool.standby_warm_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          setTimeout(() => {
            this.scheduleReplenish();
          }, 5_000);
        }
        throw error;
      })
      .finally(() => {
        if (this.warming === warmingPromise) {
          this.warming = null;
        }
      });

    this.warming = warmingPromise;
    void warmingPromise.catch(() => {});
  }
}
