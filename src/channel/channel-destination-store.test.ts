import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { PersistentChannelDestinationStore } from "./channel-destination-store.js";

test("ChannelDestinationStore persists the default chat id", async () => {
  const tmpRoot = join(process.cwd(), "tmp");
  await mkdir(tmpRoot, { recursive: true });
  const configDirectory = await mkdtemp(join(tmpRoot, "sandy-channel-"));
  try {
    const store = new PersistentChannelDestinationStore(configDirectory, "telegram");
    assert.equal(await store.getDefaultChatId(), null);
    await store.setDefaultChatId("chat-1");
    assert.equal(await new PersistentChannelDestinationStore(configDirectory, "telegram").getDefaultChatId(), "chat-1");
    assert.equal(await new PersistentChannelDestinationStore(configDirectory, "matrix").getDefaultChatId(), null);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});
