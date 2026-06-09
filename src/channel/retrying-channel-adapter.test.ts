import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ChannelAdapter } from "./channel-adapter.js";
import { ImplicitChannelDestinationStore } from "./channel-destination-store.js";
import { createRetryingChannelAdapter } from "./retrying-channel-adapter.js";
import type {
  ChannelFormatting,
  MessageAttachment,
  NormalizedChatEvent,
  PrivilegeRequest,
  SavedAttachment,
} from "../types.js";

const testFormatting: ChannelFormatting = {
  channelId: "local_test",
  markup: "plain_text",
  allowedTags: [],
  instructions: "Use plain text.",
};

class RetryTestChannelAdapter implements ChannelAdapter {
  readonly destinationStore = new ImplicitChannelDestinationStore("test");
  public sendTextCalls = 0;
  public sendTextFailuresRemaining = 0;

  getLastUserInteractionTimestamp(_chatId: string): string | null {
    return null;
  }

  getFormatting(): ChannelFormatting {
    return testFormatting;
  }

  async start(_handler: (event: NormalizedChatEvent) => Promise<void>): Promise<void> {}

  async stop(): Promise<void> {}

  async saveAttachments(
    _chatId: string,
    _attachments: MessageAttachment[],
    _targetDirectory: string,
  ): Promise<SavedAttachment[]> {
    return [];
  }

  async sendFile(_chatId: string, _filePath: string, _caption?: string): Promise<void> {}

  async sendText(_chatId: string, _text: string): Promise<void> {
    this.sendTextCalls += 1;
    if (this.sendTextFailuresRemaining > 0) {
      this.sendTextFailuresRemaining -= 1;
      throw new Error(`send failed ${this.sendTextCalls}`);
    }
  }

  async sendTaskUpdate(_chatId: string, _text: string): Promise<void> {}

  async sendReportableText(_chatId: string, _text: string): Promise<void> {}

  async sendPrivilegeRequest(_chatId: string, _request: PrivilegeRequest): Promise<void> {}

  async sendShareDeletionRequest(
    _chatId: string,
    _requestId: string,
    _taskName: string,
    _summary: string,
  ): Promise<void> {}
}

test("retrying channel adapter retries send operations with exponential backoff", async () => {
  const adapter = new RetryTestChannelAdapter();
  adapter.sendTextFailuresRemaining = 2;

  const sleepCalls: number[] = [];
  const fatalFailures: Array<{ error: unknown; source: string }> = [];

  const wrapped = createRetryingChannelAdapter(
    adapter,
    (error, source) => {
      fatalFailures.push({ error, source });
    },
    {
      maxSendAttempts: 5,
      calculateBackoffMs: (attempt) => attempt * 100,
      sleep: async (delayMs) => {
        sleepCalls.push(delayMs);
      },
    },
  );

  await wrapped.sendText("chat-1", "hello");

  assert.equal(adapter.sendTextCalls, 3);
  assert.deepEqual(sleepCalls, [100, 200]);
  assert.deepEqual(fatalFailures, []);
});

test("retrying channel adapter shuts down after repeated send failures", async () => {
  const adapter = new RetryTestChannelAdapter();
  adapter.sendTextFailuresRemaining = 5;

  const sleepCalls: number[] = [];
  const fatalFailures: Array<{ error: unknown; source: string }> = [];

  const wrapped = createRetryingChannelAdapter(
    adapter,
    (error, source) => {
      fatalFailures.push({ error, source });
    },
    {
      maxSendAttempts: 3,
      calculateBackoffMs: (attempt) => attempt * 250,
      sleep: async (delayMs) => {
        sleepCalls.push(delayMs);
      },
    },
  );

  await assert.rejects(() => wrapped.sendText("chat-1", "hello"), /send failed 3/);

  assert.equal(adapter.sendTextCalls, 3);
  assert.deepEqual(sleepCalls, [250, 500]);
  assert.equal(fatalFailures.length, 1);
  assert.equal(fatalFailures[0]?.source, "channel.sendText");
  assert.match(String((fatalFailures[0]?.error as Error).message), /send failed 3/);
});
