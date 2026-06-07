import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { channelStateFile } from "../state-paths.js";

const channelDestinationStateSchema = z.object({
  defaultChatId: z.string().min(1).nullable(),
}).strict();

export type ChannelDestinationState = z.infer<typeof channelDestinationStateSchema>;

export class ChannelDestinationStore {
  private readonly filePath: string;

  constructor(configDirectory: string) {
    this.filePath = channelStateFile(configDirectory);
  }

  async getDefaultChatId(): Promise<string | null> {
    return (await this.load()).defaultChatId;
  }

  async setDefaultChatId(chatId: string): Promise<void> {
    await this.save({ defaultChatId: chatId });
  }

  private async load(): Promise<ChannelDestinationState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return channelDestinationStateSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { defaultChatId: null };
      }
      throw error;
    }
  }

  private async save(state: ChannelDestinationState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}
