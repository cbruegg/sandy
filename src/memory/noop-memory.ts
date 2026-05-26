import type { MainAgentMemory, MemorySearchInput, RelevantMemory } from "./types.js";

/**
 * No-op memory implementation that never retrieves or stores anything.
 * Used when MemPalace is not available or memory is disabled.
 */
export class NoopMainAgentMemory implements MainAgentMemory {
  async searchRelevantMemories(_input: MemorySearchInput): Promise<RelevantMemory[]> {
    return await Promise.resolve([]);
  }

  async storeTrustedEntry(_params: {
    chatId: string;
    room: string;
    content: string;
    sourceLabel: string;
  }): Promise<void> {
    // no-op
  }
}
