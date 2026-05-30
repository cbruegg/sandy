import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type {ThreadStartParams} from "./codex-app-server-client/generated/v2";
import { logger } from "./logger.js";

let cachedAvailable: boolean | null = null;
let palaceInitAttempted = false;

const PALACE_INIT_TIMEOUT = 30000;

function ensurePalaceInitialized(palacePath: string): boolean {
  if (existsSync(join(palacePath, "chroma.sqlite3"))) {
    return true;
  }

  if (palaceInitAttempted) {
    return false;
  }

  const tempDir = mkdtempSync(join(tmpdir(), "sandy-mempalace-"));

  try {
    logger.info("mempalace.init_starting", { palacePath });

    // The `--yes` flag skips entity detection prompts but NOT the
    // "Mine this directory now?" prompt. Pipe "y\n" to auto-confirm it.
    const result = spawnSync("uv", [
      "run", "--with", "mempalace", "mempalace", "--palace", palacePath, "init", tempDir, "--auto-mine", "--yes", "--no-llm"
    ], {
      input: "y\n",
      encoding: "utf-8",
      timeout: PALACE_INIT_TIMEOUT,
    });

    palaceInitAttempted = true;

    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim() || "";
      logger.error("mempalace.init_failed", null, undefined, {
        palacePath,
        exitCode: result.status,
        stderr: stderr || "(no output)",
      });
      return false;
    }

    const created = existsSync(join(palacePath, "chroma.sqlite3"));
    if (created) {
      logger.info("mempalace.init_succeeded", { palacePath });
    } else {
      // The init command exited successfully but the palace wasn't created.
      // This can happen if the env var is not respected by this version.
      logger.error("mempalace.init_no_palace_created", { palacePath });
    }
    return created;
  } catch (error) {
    palaceInitAttempted = true;
    logger.error("mempalace.init_failed", null, undefined, {
      palacePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export function isMemPalaceAvailable(): boolean {
  if (cachedAvailable !== null) {
    return cachedAvailable;
  }

  const result = spawnSync("uv", ["--version"], {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 5000,
  });

  cachedAvailable = result.status === 0;
  return cachedAvailable;
}

export function buildMainAgentConfig(configDirectory: string, enabled: boolean): ThreadStartParams["config"] {
  if (!enabled || !isMemPalaceAvailable()) {
    return {};
  }

  const palacePath = join(configDirectory, "mempalace", "palace");

  if (!ensurePalaceInitialized(palacePath)) {
    return {};
  }

  return {
    mcp_servers: {
      mempalace: {
        command: "uv",
        args: ["run", "--with", "mempalace", "python3", "-m", "mempalace.mcp_server", "--palace", palacePath],
      },
    },
  };
}
