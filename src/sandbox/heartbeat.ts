import { statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";

export const HEARTBEAT_FILE = "heartbeat";
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_TIMEOUT_MS = 30_000;
/** Path inside containers where the heartbeat file is mounted. */
export const CONTROLLER_CONTROL_MOUNT_PATH = "/run/sandy-controller";

export type HeartbeatHandle = {
  stop: () => void;
};

/**
 * Start a heartbeat writer that refreshes the heartbeat file every
 * `HEARTBEAT_INTERVAL_MS` milliseconds.
 *
 * Returns a handle whose `stop()` method cancels the timer and removes the
 * control directory.
 */
export function startHeartbeat(
  controlDir: string,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
  setTimeoutImpl: typeof setTimeout = setTimeout,
  clearTimeoutImpl: typeof clearTimeout = clearTimeout,
): HeartbeatHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      // writeFile with an empty string for content is fine — we only need mtime.
      await writeFile(`${controlDir}/${HEARTBEAT_FILE}`, String(Date.now()));
    } catch {
      // Best-effort; a transient write failure should not kill the controller.
    }
    if (!stopped) {
      timer = setTimeoutImpl(() => { void tick(); }, intervalMs);
    }
  }

  void tick();

  return {
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearTimeoutImpl(timer);
        timer = null;
      }
    },
  };
}

export async function createControlDir(controlRoot: string, controlName: string): Promise<string> {
  const controlDir = `${controlRoot}/.sandy-control/${controlName}`;
  await mkdir(controlDir, { recursive: true });
  // Create the initial heartbeat file so containers see a fresh lease immediately.
  await writeFile(`${controlDir}/${HEARTBEAT_FILE}`, String(Date.now()));
  return controlDir;
}

/**
 * Remove a control directory.
 */
export async function removeControlDir(controlDir: string): Promise<void> {
  await rm(controlDir, { recursive: true, force: true }).catch(() => {
    // Best-effort cleanup; the directory will be cleaned up by the OS eventually.
  });
}

/**
 * Check whether a heartbeat file's mtime is within `timeoutMs`.
 * Throws if the file does not exist, so callers can distinguish stale (file
 * exists but too old) from missing (file not found).
 */
export function isHeartbeatFreshSync(heartbeatPath: string, timeoutMs: number = HEARTBEAT_TIMEOUT_MS): boolean {
  const stats = statSync(heartbeatPath);
  return Date.now() - stats.mtimeMs <= timeoutMs;
}


