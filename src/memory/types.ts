export type RelevantMemory = {
  text: string;
  wing: string;
  room: string;
  similarity: number | null;
  sourceFile: string;
  createdAt: string;
};

export type MemorySearchInput = {
  chatId: string;
  query: string;
  activeTaskName?: string;
};

export interface MainAgentMemory {
  searchRelevantMemories(input: MemorySearchInput): Promise<RelevantMemory[]>;
  storeTrustedEntry(params: {
    chatId: string;
    room: string;
    content: string;
    sourceLabel: string;
  }): Promise<void>;
}
