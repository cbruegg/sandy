import { spawn } from "node:child_process";
import { logger } from "../logger.js";
import {
  MAX_RELEVANT_MEMORIES,
  MEMPALACE_PALACE_PATH,
  MEMORY_ROOM_CONVERSATION,
  MEMORY_ROOM_TASK_SUMMARY,
} from "./constants.js";
import type { MainAgentMemory, MemorySearchInput, RelevantMemory } from "./types.js";

type HelperSearchResult = {
  query: string;
  results: Array<{
    text: string;
    wing: string;
    room: string;
    similarity: number | null;
    source_file: string;
    created_at: string;
  }>;
};

type HelperAddResult = {
  success: boolean;
  reason?: string;
  drawer_id?: string;
  wing?: string;
  room?: string;
  error?: string;
};

type HelperErrorResult = {
  error: string;
  hint?: string;
};

function resolveHelperPath(): string {
  // Relative to this source file at runtime: src/memory/mempalace-memory.ts
  // -> ../../scripts/mempalace-helper.py
  const base = new URL("../../scripts/mempalace-helper.py", import.meta.url);
  return base.pathname;
}

function runHelper(args: string[]): Promise<string> {
  const helperPath = resolveHelperPath();
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [helperPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000, // 30-seconds — search and add are fast
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const detail = stderr.trim() || `exit code ${code}`;
        reject(new Error(`MemPalace helper failed: ${detail}`));
      }
    });

    child.on("error", (error) => {
      reject(new Error(`MemPalace helper spawn failed: ${error.message}`));
    });
  });
}

function parseHelperOutput<T>(stdout: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("MemPalace helper returned empty output.");
  }
  return JSON.parse(trimmed) as T;
}

/**
 * MemPalace-backed memory service that uses a Python helper script wrapping
 * the `mempalace` package for search and write operations.
 *
 * Per-chat wing strategy: each chat ID becomes its own wing in the palace.
 * Rooms separate conversation history from task summaries.
 */
export class MemPalaceMainAgentMemory implements MainAgentMemory {
  private readonly palacePath: string;

  constructor(palacePath: string = MEMPALACE_PALACE_PATH) {
    this.palacePath = palacePath;
  }

  async searchRelevantMemories(input: MemorySearchInput): Promise<RelevantMemory[]> {
    if (!input.query.trim()) {
      return [];
    }

    try {
      const args = [
        "search",
        "--palace", this.palacePath,
        "--query", input.query,
        "--wing", input.chatId,
        "--results", String(MAX_RELEVANT_MEMORIES),
      ];

      const stdout = await runHelper(args);
      // The search helper may return an error dict when the palace does not
      // exist yet — treat that as zero hits, not a host-level exception.
      let raw: HelperSearchResult | HelperErrorResult;
      try {
        raw = parseHelperOutput<HelperSearchResult | HelperErrorResult>(stdout);
      } catch {
        logger.warn("memory.search_parse_failed", {
          chatId: input.chatId,
          query: input.query.substring(0, 200),
        });
        return [];
      }

      if ("error" in raw) {
        logger.debug("memory.search_palace_unavailable", {
          chatId: input.chatId,
          error: raw.error,
        });
        return [];
      }

      return raw.results.map(mapHelperResult);
    } catch (error) {
      logger.warn("memory.search_failed", {
        chatId: input.chatId,
        query: input.query.substring(0, 200),
        message: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async storeTrustedEntry(params: {
    chatId: string;
    room: string;
    content: string;
    sourceLabel: string;
  }): Promise<void> {
    if (!params.content.trim()) {
      return;
    }

    try {
      const args = [
        "add",
        "--palace", this.palacePath,
        "--wing", params.chatId,
        "--room", params.room,
        "--content", params.content,
        "--source-file", params.sourceLabel,
      ];

      const stdout = await runHelper(args);
      let raw: HelperAddResult | HelperErrorResult;
      try {
        raw = parseHelperOutput<HelperAddResult | HelperErrorResult>(stdout);
      } catch {
        logger.warn("memory.store_parse_failed", {
          chatId: params.chatId,
          room: params.room,
        });
        return;
      }

      if ("error" in raw) {
        logger.warn("memory.store_failed", {
          chatId: params.chatId,
          room: params.room,
          error: raw.error,
        });
        return;
      }

      if (raw.reason === "already_exists") {
        logger.debug("memory.store_duplicate_skipped", {
          chatId: params.chatId,
          room: params.room,
          drawerId: raw.drawer_id,
        });
        return;
      }

      logger.debug("memory.store_succeeded", {
        chatId: params.chatId,
        room: params.room,
        drawerId: raw.drawer_id,
      });
    } catch (error) {
      logger.warn("memory.store_error", {
        chatId: params.chatId,
        room: params.room,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Convenience wrapper that stores a string into the conversation room using
 * a short source label.
 */
export async function storeConversationMemory(
  memory: MainAgentMemory,
  chatId: string,
  content: string,
  sourceLabel: string,
): Promise<void> {
  await memory.storeTrustedEntry({
    chatId,
    room: MEMORY_ROOM_CONVERSATION,
    content,
    sourceLabel,
  });
}

/**
 * Convenience wrapper that stores a task summary into the task_summary room.
 */
export async function storeTaskSummaryMemory(
  memory: MainAgentMemory,
  chatId: string,
  content: string,
  sourceLabel: string,
): Promise<void> {
  await memory.storeTrustedEntry({
    chatId,
    room: MEMORY_ROOM_TASK_SUMMARY,
    content,
    sourceLabel,
  });
}

function mapHelperResult(raw: HelperSearchResult["results"][number]): RelevantMemory {
  return {
    text: raw.text,
    wing: raw.wing,
    room: raw.room,
    similarity: raw.similarity,
    sourceFile: raw.source_file,
    createdAt: raw.created_at,
  };
}
