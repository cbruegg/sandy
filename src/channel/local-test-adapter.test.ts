import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTestChannelAdapter } from "./local-test-adapter.js";
import { ImplicitChannelDestinationStore } from "./channel-destination-store.js";
import type { NormalizedChatEvent, PrivilegeRequest } from "../types.js";
import { parseLocalTestOutboundEvent } from "./local-test-protocol.js";
import { sharedWorkspaceMountPath } from "../shared-workspace.js";

async function waitFor<T>(load: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await load();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition.");
}

test("LocalTestChannelAdapter forwards inbox events and writes outbound records", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-local-test-"));
  const adapter = new LocalTestChannelAdapter({
    spoolRoot: root,
    destinationStore: new ImplicitChannelDestinationStore("local_test"),
  });
  const received: NormalizedChatEvent[] = [];

  try {
    await adapter.start(async (event) => {
      received.push(event);
    });

    const inboxPath = join(root, "inbox", "message-1.json");
    await writeFile(inboxPath, `${JSON.stringify({
      kind: "user_message",
      messageId: "1",
      timestamp: "2026-04-14T10:00:00.000Z",
      text: "Inspect this",
      attachments: [],
    })}\n`, "utf8");

    await waitFor(async () => received.length, (count) => count === 1);
    assert.equal(received[0]?.kind, "user_message");
    assert.equal(adapter.getLastUserInteractionTimestamp("local-test"), "2026-04-14T10:00:00.000Z");

    await adapter.sendTaskUpdate("local-test", "Working");
    const outbox = await waitFor(
      async () => (await readdirJson(join(root, "outbox"))).map((raw) => parseLocalTestOutboundEvent(raw)),
      (events) => events.length === 1,
    );
    assert.deepEqual(outbox[0], {
      ...outbox[0],
      type: "send_task_update",
      chatId: "local-test",
      text: "Working",
    });
  } finally {
    await adapter.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("LocalTestChannelAdapter copies declared attachment files into the target directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-local-test-"));
  const adapter = new LocalTestChannelAdapter({
    spoolRoot: root,
    destinationStore: new ImplicitChannelDestinationStore("local_test"),
  });
  const sourceFile = join(root, "fixture.txt");
  await writeFile(sourceFile, "fixture", "utf8");
  const received: NormalizedChatEvent[] = [];

  try {
    await adapter.start(async (event) => {
      received.push(event);
    });

    await writeFile(join(root, "inbox", "message-2.json"), `${JSON.stringify({
      kind: "user_message",
      messageId: "2",
      timestamp: "2026-04-14T10:00:00.000Z",
      text: "use file",
      attachments: [{
        hostPath: sourceFile,
        fileName: "fixture.txt",
      }],
    })}\n`, "utf8");

    await waitFor(async () => received.length, (count) => count === 1);
    const event = received[0];
    assert.equal(event?.kind, "user_message");
    assert.equal(event?.attachments.length, 1);
    const targetDirectory = join(root, "saved");
    const saved = await adapter.saveAttachments("local-test", event?.attachments ?? [], targetDirectory);
    assert.equal(saved.length, 1);
    assert.equal(await readFile(saved[0]!.hostPath, "utf8"), "fixture");
  } finally {
    await adapter.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("LocalTestChannelAdapter writes privilege requests and file sends to the outbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-local-test-"));
  const adapter = new LocalTestChannelAdapter({
    spoolRoot: root,
    destinationStore: new ImplicitChannelDestinationStore("local_test"),
  });

  try {
    await adapter.start(async () => {});
    const request: PrivilegeRequest = {
      kind: "file_copy",
      requestId: "req-1",
      payload: {
        type: "copy_into_share",
        sourcePath: "/tmp/source.txt",
        targetPath: `${sharedWorkspaceMountPath}/source.txt`,
        reason: "Need the file.",
      },
    };

    await adapter.sendPrivilegeRequest("local-test", request);
    await adapter.sendFile("local-test", "/tmp/output.txt", "Done");

    const events = await waitFor(
      async () => (await readdirJson(join(root, "outbox"))).map((raw) => parseLocalTestOutboundEvent(raw)),
      (items) => items.length === 2,
    );
    assert.deepEqual(
      events.map((event) => event.type).sort(),
      ["send_file", "send_privilege_request"],
    );
  } finally {
    await adapter.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("LocalTestChannelAdapter quarantines failing inbox entries and continues processing later files", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-local-test-"));
  const adapter = new LocalTestChannelAdapter({
    spoolRoot: root,
    destinationStore: new ImplicitChannelDestinationStore("local_test"),
  });
  const received: NormalizedChatEvent[] = [];

  try {
    await adapter.start(async (event) => {
      if (event.kind === "user_message" && event.text === "break") {
        throw new Error("synthetic handler failure");
      }
      received.push(event);
    });

    await writeFile(join(root, "inbox", "message-1.json"), `${JSON.stringify({
      kind: "user_message",
      messageId: "1",
      timestamp: "2026-04-14T10:00:00.000Z",
      text: "break",
      attachments: [],
    })}\n`, "utf8");

    await writeFile(join(root, "inbox", "message-2.json"), `${JSON.stringify({
      kind: "user_message",
      messageId: "2",
      timestamp: "2026-04-14T10:00:01.000Z",
      text: "continue",
      attachments: [],
    })}\n`, "utf8");

    await waitFor(
      async () => received.map((event) => event.kind === "user_message" ? event.text : ""),
      (texts) => texts.includes("continue"),
    );

    const failedFiles = await waitFor(
      async () => (await import("node:fs/promises")).readdir(join(root, "inbox-failed")),
      (files) => files.length === 1,
    );
    assert.equal(failedFiles.length, 1);
    assert.ok(failedFiles[0]?.endsWith("message-1.json"));

    const inboxFiles = await (await import("node:fs/promises")).readdir(join(root, "inbox"));
    assert.equal(inboxFiles.length, 0);
  } finally {
    await adapter.stop();
    await rm(root, { recursive: true, force: true });
  }
});

async function readdirJson(root: string): Promise<string[]> {
  const entries = (await import("node:fs/promises")).readdir;
  const files = await entries(root, { withFileTypes: true });
  const raw: string[] = [];
  for (const file of files.filter((entry) => entry.isFile()).sort((left, right) => left.name.localeCompare(right.name))) {
    raw.push(await readFile(join(root, file.name), "utf8"));
  }
  return raw;
}
