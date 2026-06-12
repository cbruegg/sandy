import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { channelStateFile } from "../state-paths.js";
import type { ChatId } from "../types.js";

const channelDestinationStateSchema = z.object({
  defaultChatIds: z.record(z.string(), z.string().min(1)).default({}),
}).strict();

export type ChannelDestinationState = z.infer<typeof channelDestinationStateSchema>;

export interface ChannelDestinationStore {
  getDefaultChatId(): Promise<ChatId | null>;
  setDefaultChatId(chatId: ChatId): Promise<void>;
}

export class PersistentChannelDestinationStore implements ChannelDestinationStore {
  private readonly filePath: string;

  constructor(configDirectory: string, private readonly channelId: string) {
    this.filePath = channelStateFile(configDirectory);
  }

  async getDefaultChatId(): Promise<ChatId | null> {
    return (await this.load()).defaultChatIds[this.channelId] ?? null;
  }

  async setDefaultChatId(chatId: ChatId): Promise<void> {
    const state = await this.load();
    state.defaultChatIds[this.channelId] = chatId;
    await this.save(state);
  }

  private async load(): Promise<ChannelDestinationState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return channelDestinationStateSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { defaultChatIds: {} };
      }
      throw error;
    }
  }

  private async save(state: ChannelDestinationState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

export class ImplicitChannelDestinationStore implements ChannelDestinationStore {
  constructor(private readonly chatId: ChatId) {}

  getDefaultChatId(): Promise<ChatId | null> {
    return Promise.resolve(this.chatId);
  }

  setDefaultChatId(_chatId: ChatId): Promise<void> {
    return Promise.resolve();
  }
}
