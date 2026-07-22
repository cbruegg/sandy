import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MatrixChannelAdapter,
  applyMatrixOneTimeKeyUploadCompatibilityPatch,
  buildMatrixPollStartContent,
  normalizeMatrixPollResponse,
  normalizeMatrixReactionResponse,
  normalizeMatrixRoomMessage,
} from "./matrix-adapter.js";
import { resolveMatrixCryptoBinaryName } from "./matrix-crypto-targets.js";
import { renderMatrixMarkdown } from "./matrix-markdown.js";
import type { NormalizedChatEvent } from "../types.js";
import type { TranscriptionProvider } from "../transcription/transcription-provider.js";
import { messages } from "../messages-to-user.js";

const BOT_ID = "@sandy:example.org";
const OWNER_ID = "@owner:example.org";
const OTHER_ID = "@other:example.org";
const ROOM_ID = "!room:example.org";

test("renderMatrixMarkdown converts Markdown to sanitized Matrix HTML", () => {
  const rendered = renderMatrixMarkdown("Use **bold** and <script>alert(1)</script> plus `x < y`.");

  assert.equal(rendered.body, "Use **bold** and <script>alert(1)</script> plus `x < y`.");
  assert.equal(
    rendered.formattedBody,
    "<p>Use <strong>bold</strong> and &lt;script&gt;alert(1)&lt;/script&gt; plus <code>x &lt; y</code>.</p>",
  );
});

test("renderMatrixMarkdown renders line breaks and fenced code blocks", () => {
  const rendered = renderMatrixMarkdown("Output:\n\n```\na\nb\n```");

  assert.equal(rendered.body, "Output:\n\n```\na\nb\n```");
  assert.equal(
    rendered.formattedBody,
    "<p>Output:</p>\n<pre><code>a\nb\n</code></pre>",
  );
});

test("renderMatrixMarkdown renders Markdown tables without HTML table elements", () => {
  const rendered = renderMatrixMarkdown("| A | B |\n|---|---|\n| 1 | 2 |");

  assert.equal(rendered.body, "| A | B |\n|---|---|\n| 1 | 2 |");
  assert.equal(
    rendered.formattedBody,
    "<p><strong>A:</strong> 1<br>\n<strong>B:</strong> 2</p>",
  );
});

test("renderMatrixMarkdown can render Markdown tables as Matrix HTML table elements", () => {
  const rendered = renderMatrixMarkdown("| A | B |\n|---|---|\n| 1 | 2 |", {
    renderMarkdownTablesWithoutHtmlTables: false,
  });

  assert.equal(
    rendered.formattedBody,
    "<table>\n<thead>\n<tr>\n<th>A</th>\n<th>B</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody></table>",
  );
});

test("MatrixChannelAdapter sends Markdown tables as attached PNG images", async () => {
  const fakeClient = new FakeMatrixClient();
  fakeClient.joinedRooms.add(ROOM_ID);
  fakeClient.roomMembers.set(ROOM_ID, [BOT_ID, OWNER_ID]);
  const adapter = new MatrixChannelAdapter({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    allowedUserId: OWNER_ID,
    stateRoot: "/tmp/sandy-matrix-test",
    clientFactory: () => fakeClient,
    tableImageRenderer: async () => fakePngTableImage(123, 45),
  });

  try {
    await adapter.start(async () => {});
    await adapter.sendText(ROOM_ID, "Here:\n\n| A | B |\n|---|---|\n| 1 | 2 |");

    assert.equal(fakeClient.uploads.length, 1);
    assert.equal(fakeClient.uploads[0]?.contentType, "image/png");
    assert.equal(fakeClient.uploads[0]?.filename, "sandy-table-1.png");
    assert.deepEqual([...expectDefined(fakeClient.uploads[0]?.data, "Expected uploaded PNG.").subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(fakeClient.sentEvents[0]?.content["msgtype"], "m.image");
    assert.equal(fakeClient.sentEvents[0]?.content["url"], "mxc://example/1");
    assert.deepEqual(fakeClient.sentEvents[0]?.content["info"], {
      mimetype: "image/png",
      size: fakeClient.uploads[0]?.data.byteLength,
      w: 123,
      h: 45,
    });
    const content = expectDefined(fakeClient.sentEvents[1]?.content, "Expected a Matrix message.");
    assert.equal(content["body"], "Here:\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    assert.equal(content["formatted_body"], "<p>Here:</p>\n<p><em>Table image attached separately.</em></p>");
  } finally {
    await adapter.stop();
  }
});

test("MatrixChannelAdapter sends encrypted table images separately in encrypted rooms", async () => {
  const fakeClient = new FakeMatrixClient();
  fakeClient.joinedRooms.add(ROOM_ID);
  fakeClient.roomMembers.set(ROOM_ID, [BOT_ID, OWNER_ID]);
  fakeClient.encryptedRooms.add(ROOM_ID);
  const adapter = new MatrixChannelAdapter({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    allowedUserId: OWNER_ID,
    stateRoot: "/tmp/sandy-matrix-test",
    clientFactory: () => fakeClient,
    tableImageRenderer: async () => fakePngTableImage(123, 45),
  });

  try {
    await adapter.start(async () => {});
    await adapter.sendText(ROOM_ID, "| A | B |\n|---|---|\n| 1 | 2 |");

    assert.equal(fakeClient.uploads.length, 1);
    assert.equal(fakeClient.uploads[0]?.contentType, "application/octet-stream");
    assert.deepEqual([...expectDefined(fakeClient.uploads[0]?.data, "Expected encrypted upload.").subarray(0, 18)], [...Buffer.concat([Buffer.from("encrypted:", "utf8"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])])]);
    assert.equal(fakeClient.sentEvents[0]?.content["msgtype"], "m.image");
    assert.equal(typeof fakeClient.sentEvents[0]?.content["file"], "object");
    assert.equal(fakeClient.sentEvents[1]?.content["msgtype"], "m.text");
    assert.equal(fakeClient.sentEvents[1]?.content["formatted_body"], "<p><em>Table image attached separately.</em></p>");
  } finally {
    await adapter.stop();
  }
});

test("MatrixChannelAdapter falls back to text table conversion when table image rendering fails", async () => {
  const fakeClient = new FakeMatrixClient();
  fakeClient.joinedRooms.add(ROOM_ID);
  fakeClient.roomMembers.set(ROOM_ID, [BOT_ID, OWNER_ID]);
  const adapter = new MatrixChannelAdapter({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    allowedUserId: OWNER_ID,
    stateRoot: "/tmp/sandy-matrix-test",
    clientFactory: () => fakeClient,
    tableImageRenderer: async () => null,
  });

  try {
    await adapter.start(async () => {});
    await adapter.sendText(ROOM_ID, "| A | B |\n|---|---|\n| 1 | 2 |");

    assert.equal(fakeClient.uploads.length, 0);
    assert.equal(fakeClient.sentEvents[0]?.content["msgtype"], "m.text");
    assert.equal(fakeClient.sentEvents[0]?.content["formatted_body"], "<p><strong>A:</strong> 1<br>\n<strong>B:</strong> 2</p>");
  } finally {
    await adapter.stop();
  }
});

test("renderMatrixMarkdown keeps only Matrix-safe HTML attributes", () => {
  const rendered = renderMatrixMarkdown("[link](https://example.org)\n\n3. item");

  assert.equal(
    rendered.formattedBody,
    '<p><a href="https://example.org">link</a></p>\n<ol start="3">\n<li>item</li>\n</ol>',
  );
});

test("renderMatrixMarkdown preserves literal escaped newlines", () => {
  const rendered = renderMatrixMarkdown("Arguments: `line 1\\nline 2`");

  assert.equal(rendered.body, "Arguments: `line 1\\nline 2`");
  assert.equal(rendered.formattedBody, "<p>Arguments: <code>line 1\\nline 2</code></p>");
});

test("buildMatrixPollStartContent produces a disclosed unstable poll payload", () => {
  assert.deepEqual(buildMatrixPollStartContent("Choose", [
    { answerId: "a", label: "Option A" },
    { answerId: "b", label: "Option B" },
  ]), {
    "org.matrix.msc1767.text": "Choose\n- Option A\n- Option B",
    "m.text": "Choose\n- Option A\n- Option B",
    "org.matrix.msc3381.poll.start": {
      question: {
        "org.matrix.msc1767.text": "Choose",
        "m.text": "Choose",
      },
      kind: "org.matrix.msc3381.poll.disclosed",
      max_selections: 1,
      answers: [
        {
          id: "a",
          "org.matrix.msc1767.text": "Option A",
          "m.text": "Option A",
        },
        {
          id: "b",
          "org.matrix.msc1767.text": "Option B",
          "m.text": "Option B",
        },
      ],
    },
  });
});

test("resolveMatrixCryptoBinaryName maps supported platforms", () => {
  assert.equal(resolveMatrixCryptoBinaryName("darwin", "arm64"), "matrix-sdk-crypto.darwin-arm64.node");
  assert.equal(resolveMatrixCryptoBinaryName("darwin", "x64"), "matrix-sdk-crypto.darwin-x64.node");
  assert.equal(resolveMatrixCryptoBinaryName("linux", "arm64"), "matrix-sdk-crypto.linux-arm64-gnu.node");
  assert.equal(resolveMatrixCryptoBinaryName("win32", "arm64"), "matrix-sdk-crypto.win32-arm64-msvc.node");
});

test("applyMatrixOneTimeKeyUploadCompatibilityPatch uploads one-time keys normally", async () => {
  const uploadedBodies: unknown[] = [];
  const sentRequests: Array<{ id: string; type: number; response: string }> = [];

  class FakeRustEngine {
    readonly client = {
      doRequest: async (_method: string, _path: string, _queryParams: unknown, body: unknown) => {
        uploadedBodies.push(body);
        return { one_time_key_counts: { signed_curve25519: 0 } };
      },
    };

    readonly machine = {
      markRequestAsSent: async (id: string, type: number, response: string) => {
        sentRequests.push({ id, type, response });
      },
    };

    async processKeysUploadRequest(_request: { id: string; type: number; body: string }): Promise<void> {
      throw new Error("unpatched");
    }
  }

  applyMatrixOneTimeKeyUploadCompatibilityPatch(FakeRustEngine);

  const engine = new FakeRustEngine();
  await engine.processKeysUploadRequest({
    id: "request-1",
    type: 0,
    body: JSON.stringify({
      device_keys: { keys: {} },
      one_time_keys: {
        "signed_curve25519:AAAAAAAAAA0": { key: "old" },
      },
      fallback_keys: {
        "signed_curve25519:fallback": { key: "fallback" },
      },
    }),
  });

  assert.deepEqual(uploadedBodies, [{
    device_keys: { keys: {} },
    one_time_keys: {
      "signed_curve25519:AAAAAAAAAA0": { key: "old" },
    },
    fallback_keys: {
      "signed_curve25519:fallback": { key: "fallback" },
    },
  }]);
  assert.deepEqual(sentRequests, [{
    id: "request-1",
    type: 0,
    response: JSON.stringify({ one_time_key_counts: { signed_curve25519: 0 } }),
  }]);
});

test("applyMatrixOneTimeKeyUploadCompatibilityPatch retries duplicate one-time key uploads without one-time keys", async () => {
  const uploadedBodies: unknown[] = [];
  const sentRequests: Array<{ id: string; type: number; response: string }> = [];

  class FakeRustEngine {
    private uploadCount = 0;

    readonly client = {
      doRequest: async (_method: string, _path: string, _queryParams: unknown, body: unknown) => {
        uploadedBodies.push(body);
        this.uploadCount += 1;
        if (this.uploadCount === 1) {
          const error = new Error("M_UNKNOWN: One time key signed_curve25519:AAAAAAAAAA0 already exists.") as Error & {
            body?: Record<string, unknown>;
          };
          error.body = {
            errcode: "M_UNKNOWN",
            error: "One time key signed_curve25519:AAAAAAAAAA0 already exists.",
          };
          throw error;
        }
        return { one_time_key_counts: { signed_curve25519: 0 } };
      },
    };

    readonly machine = {
      markRequestAsSent: async (id: string, type: number, response: string) => {
        sentRequests.push({ id, type, response });
      },
    };

    async processKeysUploadRequest(_request: { id: string; type: number; body: string }): Promise<void> {
      throw new Error("unpatched");
    }
  }

  applyMatrixOneTimeKeyUploadCompatibilityPatch(FakeRustEngine);

  const engine = new FakeRustEngine();
  await engine.processKeysUploadRequest({
    id: "request-1",
    type: 0,
    body: JSON.stringify({
      device_keys: { keys: {} },
      one_time_keys: {
        "signed_curve25519:AAAAAAAAAA0": { key: "old" },
      },
      fallback_keys: {
        "signed_curve25519:fallback": { key: "fallback" },
      },
    }),
  });

  assert.deepEqual(uploadedBodies, [
    {
      device_keys: { keys: {} },
      one_time_keys: {
        "signed_curve25519:AAAAAAAAAA0": { key: "old" },
      },
      fallback_keys: {
        "signed_curve25519:fallback": { key: "fallback" },
      },
    },
    {
      device_keys: { keys: {} },
      fallback_keys: {
        "signed_curve25519:fallback": { key: "fallback" },
      },
    },
  ]);
  assert.deepEqual(sentRequests, [{
    id: "request-1",
    type: 0,
    response: JSON.stringify({ one_time_key_counts: { signed_curve25519: 0 } }),
  }]);
});

test("normalizeMatrixRoomMessage maps text, encrypted file, and audio events", async () => {
  const fakeClient = new FakeMatrixClient();
  const savedRefs = new Map<string, unknown>();
  const sentTexts: string[] = [];
  const transcriptionProvider: TranscriptionProvider = {
    async transcribe(input) {
      assert.equal(input.fileName, "voice.ogg");
      return "transcribed request";
    },
  };

  const textEvent = await normalizeMatrixRoomMessage(ROOM_ID, {
    type: "m.room.message",
    event_id: "$text",
    sender: OWNER_ID,
    origin_server_ts: 1_700_000_000_000,
    content: {
      msgtype: "m.text",
      body: "hello",
    },
  }, {
    client: fakeClient,
    transcriptionProvider,
    sendText: async (_chatId, text) => {
      sentTexts.push(text);
    },
    saveAttachmentRef: (attachmentId, ref) => {
      savedRefs.set(attachmentId, ref);
    },
  });

  assert.deepEqual(textEvent, {
    kind: "user_message",
    chatId: ROOM_ID,
    messageId: "$text",
    senderUserId: OWNER_ID,
    timestamp: "2023-11-14T22:13:20.000Z",
    text: "hello",
    rawText: "hello",
    attachments: [],
  });

  fakeClient.media.set("mxc://example/file", {
    data: Buffer.from("encrypted:file-contents"),
    contentType: "application/octet-stream",
  });

  const fileEvent = await normalizeMatrixRoomMessage(ROOM_ID, {
    type: "m.room.message",
    event_id: "$file",
    sender: OWNER_ID,
    origin_server_ts: 1_700_000_001_000,
    content: {
      msgtype: "m.file",
      body: "report.txt",
      file: {
        url: "mxc://example/file",
        iv: "iv",
        v: "v2",
        key: {
          k: "secret",
          key_ops: ["encrypt", "decrypt"],
        },
        hashes: {
          sha256: "hash",
        },
      },
      info: {
        mimetype: "text/plain",
      },
    },
  }, {
    client: fakeClient,
    transcriptionProvider,
    sendText: async (_chatId, text) => {
      sentTexts.push(text);
    },
    saveAttachmentRef: (attachmentId, ref) => {
      savedRefs.set(attachmentId, ref);
    },
  });

  assert.equal(fileEvent?.kind, "user_message");
  assert.equal(fileEvent?.attachments.length, 1);
  assert.equal(fileEvent?.attachments[0]?.fileName, "report.txt");
  assert.equal(savedRefs.size, 1);

  const imageCaptionEvent = await normalizeMatrixRoomMessage(ROOM_ID, {
    type: "m.room.message",
    event_id: "$image-caption",
    sender: OWNER_ID,
    origin_server_ts: 1_700_000_002_000,
    content: {
      msgtype: "m.image",
      body: "Find the full set",
      filename: "instagram-screenshot.png",
      url: "mxc://example/image",
      info: {
        mimetype: "image/png",
      },
    },
  }, {
    client: fakeClient,
    transcriptionProvider,
    sendText: async (_chatId, text) => {
      sentTexts.push(text);
    },
    saveAttachmentRef: (attachmentId, ref) => {
      savedRefs.set(attachmentId, ref);
    },
  });

  if (!imageCaptionEvent || imageCaptionEvent.kind !== "user_message") {
    throw new Error("Expected an image user message.");
  }
  assert.equal(imageCaptionEvent.text, "Find the full set");
  assert.equal(imageCaptionEvent.rawText, "Find the full set");
  assert.match(JSON.stringify(imageCaptionEvent), /instagram-screenshot\.png/);

  fakeClient.media.set("mxc://example/audio", {
    data: Buffer.from("voice-bytes"),
    contentType: "audio/ogg",
  });
  const audioEvent = await normalizeMatrixRoomMessage(ROOM_ID, {
    type: "m.room.message",
    event_id: "$audio",
    sender: OWNER_ID,
    origin_server_ts: 1_700_000_002_000,
    content: {
      msgtype: "m.audio",
      body: "voice.ogg",
      url: "mxc://example/audio",
      info: {
        mimetype: "audio/ogg",
      },
    },
  }, {
    client: fakeClient,
    transcriptionProvider,
    sendText: async (_chatId, text) => {
      sentTexts.push(text);
    },
    saveAttachmentRef: (attachmentId, ref) => {
      savedRefs.set(attachmentId, ref);
    },
  });

  assert.deepEqual(audioEvent, {
    kind: "user_message",
    chatId: ROOM_ID,
    messageId: "$audio",
    senderUserId: OWNER_ID,
    timestamp: "2023-11-14T22:13:22.000Z",
    text: "transcribed request",
    rawText: "transcribed request",
    attachments: [],
  });
  assert.deepEqual(sentTexts, []);
});

test("normalizeMatrixPollResponse maps active polls and ignores stale poll answers", () => {
  const activePolls = new Map([["$poll", {
    roomId: ROOM_ID,
    actionsByAnswerId: new Map([["cancel", { event: { kind: "cancel_request" } }]]),
  }]]) as ReadonlyMap<string, {
    roomId: string;
    actionsByAnswerId: Map<string, { event: Omit<Extract<NormalizedChatEvent, { kind: "cancel_request" }>, "chatId" | "messageId" | "timestamp"> }>;
  }>;

  const activeResponse = normalizeMatrixPollResponse(ROOM_ID, {
    type: "org.matrix.msc3381.poll.response",
    event_id: "$response",
    sender: OWNER_ID,
    origin_server_ts: 1_700_000_100_000,
    content: {
      "org.matrix.msc3381.poll.response": {
        answers: ["cancel"],
      },
      "m.relates_to": {
        rel_type: "m.reference",
        event_id: "$poll",
      },
    },
  }, activePolls);

  assert.deepEqual(activeResponse, {
    kind: "cancel_request",
    chatId: ROOM_ID,
    messageId: "$response",
    senderUserId: OWNER_ID,
    timestamp: "2023-11-14T22:15:00.000Z",
  });

  const staleResponse = normalizeMatrixPollResponse(ROOM_ID, {
    type: "org.matrix.msc3381.poll.response",
    event_id: "$response-2",
    sender: OWNER_ID,
    origin_server_ts: 1_700_000_101_000,
    content: {
      "org.matrix.msc3381.poll.response": {
        answers: ["cancel"],
      },
      "m.relates_to": {
        rel_type: "m.reference",
        event_id: "$missing",
      },
    },
  }, activePolls);

  assert.equal(staleResponse, null);
});

test("normalizeMatrixReactionResponse maps active reactions and ignores stale reactions", () => {
  const activeReactionHandlers = new Map([["$notice", {
    roomId: ROOM_ID,
    actionsByKey: new Map([["😮", { key: "😮", event: { kind: "cancel_request" } }]]),
  }]]) as ReadonlyMap<string, {
    roomId: string;
    actionsByKey: Map<string, { key: string; event: Omit<Extract<NormalizedChatEvent, { kind: "cancel_request" }>, "chatId" | "messageId" | "timestamp"> }>;
  }>;

  const activeResponse = normalizeMatrixReactionResponse(ROOM_ID, {
    type: "m.reaction",
    event_id: "$reaction",
    sender: OWNER_ID,
    origin_server_ts: 1_700_000_100_000,
    content: {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$notice",
        key: "😮",
      },
    },
  }, activeReactionHandlers);

  assert.deepEqual(activeResponse, {
    kind: "cancel_request",
    chatId: ROOM_ID,
    messageId: "$reaction",
    senderUserId: OWNER_ID,
    timestamp: "2023-11-14T22:15:00.000Z",
  });

  const staleResponse = normalizeMatrixReactionResponse(ROOM_ID, {
    type: "m.reaction",
    event_id: "$reaction-2",
    sender: OWNER_ID,
    origin_server_ts: 1_700_000_101_000,
    content: {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$missing",
        key: "😮",
      },
    },
  }, activeReactionHandlers);

  assert.equal(staleResponse, null);
});

test("normalizeMatrixReactionResponse accepts emoji variation selectors", () => {
  const activeReactionHandlers = new Map([["$notice", {
    roomId: ROOM_ID,
    actionsByKey: new Map([["👍", { key: "👍", event: { kind: "mark_finished_request" } }]]),
  }]]) as ReadonlyMap<string, {
    roomId: string;
    actionsByKey: Map<string, { key: string; event: Omit<Extract<NormalizedChatEvent, { kind: "mark_finished_request" }>, "chatId" | "messageId" | "timestamp"> }>;
  }>;

  const response = normalizeMatrixReactionResponse(ROOM_ID, {
    type: "m.reaction",
    event_id: "$reaction-vs16",
    sender: OWNER_ID,
    origin_server_ts: 1_700_000_102_000,
    content: {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: "$notice",
        key: "👍️",
      },
    },
  }, activeReactionHandlers);

  assert.deepEqual(response, {
    kind: "mark_finished_request",
    chatId: ROOM_ID,
    messageId: "$reaction-vs16",
    senderUserId: OWNER_ID,
    timestamp: "2023-11-14T22:15:02.000Z",
  });
});

test("MatrixChannelAdapter auto-joins allowed invites and rejects unencrypted rooms", async () => {
  const fakeClient = new FakeMatrixClient();
  fakeClient.roomMembers.set(ROOM_ID, [BOT_ID, OWNER_ID]);
  fakeClient.encryptedRooms.add(ROOM_ID);

  const adapter = new MatrixChannelAdapter({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    allowedUserId: OWNER_ID,
    stateRoot: "/tmp/sandy-matrix-test",
    clientFactory: () => fakeClient,
  });

  try {
    await adapter.start(async () => {});
    await fakeClient.dispatch("room.invite", ROOM_ID, {
      sender: OWNER_ID,
      type: "m.room.member",
      event_id: "$invite",
      origin_server_ts: 1_700_000_000_000,
    });

    assert.deepEqual(fakeClient.joinCalls, [ROOM_ID]);
    assert.equal(fakeClient.leaveCalls.length, 0);

    const unencryptedRoom = "!other:example.org";
    fakeClient.joinedRooms.add(unencryptedRoom);
    fakeClient.roomMembers.set(unencryptedRoom, [BOT_ID, OWNER_ID]);
    await fakeClient.dispatch("room.join", unencryptedRoom, {
      sender: OWNER_ID,
      type: "m.room.member",
      event_id: "$join",
      origin_server_ts: 1_700_000_000_000,
    });

    assert.equal(fakeClient.leaveCalls.length, 1);
    assert.equal(fakeClient.leaveCalls[0]?.roomId, unencryptedRoom);
  } finally {
    await adapter.stop();
  }
});

test("MatrixChannelAdapter ignores unauthorized senders and routes task reactions from Sandy-authored notices", async () => {
  const fakeClient = new FakeMatrixClient();
  fakeClient.joinedRooms.add(ROOM_ID);
  fakeClient.roomMembers.set(ROOM_ID, [BOT_ID, OWNER_ID]);
  fakeClient.encryptedRooms.add(ROOM_ID);

  const received: NormalizedChatEvent[] = [];
  const adapter = new MatrixChannelAdapter({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    allowedUserId: OWNER_ID,
    stateRoot: "/tmp/sandy-matrix-test",
    clientFactory: () => fakeClient,
  });

  try {
    await adapter.start(async (event) => {
      received.push(event);
    });

    await fakeClient.dispatch("room.message", ROOM_ID, {
      type: "m.room.message",
      event_id: "$unauthorized",
      sender: OTHER_ID,
      origin_server_ts: 1_700_000_000_000,
      content: {
        msgtype: "m.text",
        body: "ignore me",
      },
    });

    assert.equal(received.length, 0);

    await adapter.sendTaskUpdate(ROOM_ID, "Still working.");
    const noticeEventId = "$event-2";

    await fakeClient.dispatch("room.event", ROOM_ID, {
      type: "m.reaction",
      event_id: "$vote",
      sender: OWNER_ID,
      origin_server_ts: 1_700_000_050_000,
      content: {
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: noticeEventId,
          key: "👍",
        },
      },
    });

    assert.deepEqual(received, [{
      kind: "mark_finished_request",
      chatId: ROOM_ID,
      messageId: "$vote",
      senderUserId: OWNER_ID,
      timestamp: "2023-11-14T22:14:10.000Z",
    }]);
  } finally {
    await adapter.stop();
  }
});

test("MatrixChannelAdapter catches handler failures and continues processing later events", async () => {
  const fakeClient = new FakeMatrixClient();
  fakeClient.joinedRooms.add(ROOM_ID);
  fakeClient.roomMembers.set(ROOM_ID, [BOT_ID, OWNER_ID]);
  fakeClient.encryptedRooms.add(ROOM_ID);

  const received: NormalizedChatEvent[] = [];
  let shouldThrow = true;
  const adapter = new MatrixChannelAdapter({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    allowedUserId: OWNER_ID,
    stateRoot: "/tmp/sandy-matrix-test",
    clientFactory: () => fakeClient,
  });

  try {
    await adapter.start(async (event) => {
      if (shouldThrow) {
        throw new Error("synthetic handler failure");
      }
      received.push(event);
    });

    await fakeClient.dispatch("room.message", ROOM_ID, {
      type: "m.room.message",
      event_id: "$first",
      sender: OWNER_ID,
      origin_server_ts: 1_700_000_000_000,
      content: {
        msgtype: "m.text",
        body: "first",
      },
    });

    shouldThrow = false;
    await fakeClient.dispatch("room.message", ROOM_ID, {
      type: "m.room.message",
      event_id: "$second",
      sender: OWNER_ID,
      origin_server_ts: 1_700_000_001_000,
      content: {
        msgtype: "m.text",
        body: "second",
      },
    });

    assert.deepEqual(received, [{
      kind: "user_message",
      chatId: ROOM_ID,
      messageId: "$second",
      senderUserId: OWNER_ID,
      timestamp: "2023-11-14T22:13:21.000Z",
      text: "second",
      rawText: "second",
      attachments: [],
    }]);
  } finally {
    await adapter.stop();
  }
});

test("MatrixChannelAdapter evicts stale room polls after task completion", async () => {
  const fakeClient = new FakeMatrixClient();
  fakeClient.joinedRooms.add(ROOM_ID);
  fakeClient.roomMembers.set(ROOM_ID, [BOT_ID, OWNER_ID]);
  fakeClient.encryptedRooms.add(ROOM_ID);

  const received: NormalizedChatEvent[] = [];
  const adapter = new MatrixChannelAdapter({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    allowedUserId: OWNER_ID,
    stateRoot: "/tmp/sandy-matrix-test",
    clientFactory: () => fakeClient,
  });

  try {
    await adapter.start(async (event) => {
      received.push(event);
    });

    await adapter.sendTaskUpdate(ROOM_ID, "Still working.");
    const taskNoticeId = "$event-2";

    await fakeClient.dispatch("room.event", ROOM_ID, {
      type: "m.reaction",
      event_id: "$fresh",
      sender: OWNER_ID,
      origin_server_ts: 1_700_000_051_000,
      content: {
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: taskNoticeId,
          key: "😮",
        },
      },
    });

    assert.deepEqual(received, [{
      kind: "cancel_request",
      chatId: ROOM_ID,
      messageId: "$fresh",
      senderUserId: OWNER_ID,
      timestamp: "2023-11-14T22:14:11.000Z",
    }]);

    await adapter.sendReportableText(ROOM_ID, "Task complete.");
    const finalNoticeId = "$event-4";

    await fakeClient.dispatch("room.event", ROOM_ID, {
      type: "m.reaction",
      event_id: "$stale-after-summary",
      sender: OWNER_ID,
      origin_server_ts: 1_700_000_052_000,
      content: {
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: taskNoticeId,
          key: "😮",
        },
      },
    });

    await fakeClient.dispatch("room.event", ROOM_ID, {
      type: "m.reaction",
      event_id: "$abort-final",
      sender: OWNER_ID,
      origin_server_ts: 1_700_000_053_000,
      content: {
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: finalNoticeId,
          key: "😮",
        },
      },
    });

    assert.deepEqual(received, [
      {
        kind: "cancel_request",
        chatId: ROOM_ID,
        messageId: "$fresh",
        senderUserId: OWNER_ID,
        timestamp: "2023-11-14T22:14:11.000Z",
      },
      {
        kind: "danger_report",
        chatId: ROOM_ID,
        messageId: "$abort-final",
        senderUserId: OWNER_ID,
        timestamp: "2023-11-14T22:14:13.000Z",
      },
    ]);
  } finally {
    await adapter.stop();
  }
});

test("MatrixChannelAdapter honors Matrix retry_after_ms before retrying a task update", async () => {
  const fakeClient = new FakeMatrixClient();
  fakeClient.joinedRooms.add(ROOM_ID);
  fakeClient.roomMembers.set(ROOM_ID, [BOT_ID, OWNER_ID]);
  fakeClient.encryptedRooms.add(ROOM_ID);
  fakeClient.sendEventFailures = [
    createMatrixRateLimitError(2_500),
    createMatrixRateLimitError(1_000),
  ];

  const sleepCalls: number[] = [];
  const adapter = new MatrixChannelAdapter({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    allowedUserId: OWNER_ID,
    stateRoot: "/tmp/sandy-matrix-test",
    clientFactory: () => fakeClient,
    sleep: async (delayMs) => {
      sleepCalls.push(delayMs);
    },
  });

  try {
    await adapter.start(async () => {});
    await adapter.sendTaskUpdate(ROOM_ID, "Still working.");

    assert.deepEqual(sleepCalls, [2_500, 4_000]);
    assert.equal(fakeClient.sentEvents[0]?.content["msgtype"], "m.notice");
    assert.equal(fakeClient.sentEvents[0]?.content["formatted_body"], "<p>Still working.</p>");
    assert.equal(fakeClient.sentEvents[1]?.content["msgtype"], "m.notice");
    assert.equal(fakeClient.sentEvents[1]?.content["formatted_body"], "<p><em>React with 👍 to finish task, 😮 to abort task</em></p>");
  } finally {
    await adapter.stop();
  }
});

test("MatrixChannelAdapter sends task updates and reportable text without polls and with separate hint notices", async () => {
  const fakeClient = new FakeMatrixClient();
  fakeClient.joinedRooms.add(ROOM_ID);
  fakeClient.roomMembers.set(ROOM_ID, [BOT_ID, OWNER_ID]);
  fakeClient.encryptedRooms.add(ROOM_ID);

  const adapter = new MatrixChannelAdapter({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    allowedUserId: OWNER_ID,
    stateRoot: "/tmp/sandy-matrix-test",
    clientFactory: () => fakeClient,
  });

  try {
    await adapter.start(async () => {});

    await adapter.sendTaskUpdate(ROOM_ID, "Still working.");
    await adapter.sendReportableText(ROOM_ID, "Task complete.");

    assert.deepEqual(fakeClient.sentEvents.map((event) => event.eventType), [
      "m.room.message",
      "m.room.message",
      "m.room.message",
      "m.room.message",
    ]);
    assert.deepEqual(fakeClient.sentEvents.map((event) => event.content["msgtype"]), [
      "m.notice",
      "m.notice",
      "m.text",
      "m.notice",
    ]);
    assert.deepEqual(fakeClient.sentEvents.map((event) => event.content["formatted_body"]), [
      "<p>Still working.</p>",
      "<p><em>React with 👍 to finish task, 😮 to abort task</em></p>",
      "<p>Task complete.</p>",
      "<p><em>React with 😮 to report dangerous output</em></p>",
    ]);
    assert.equal(fakeClient.sentEvents.some((event) => event.eventType === "org.matrix.msc3381.poll.start"), false);
  } finally {
    await adapter.stop();
  }
});

test("MatrixChannelAdapter sends summary confirmation as a poll without repeating the summary", async () => {
  const fakeClient = new FakeMatrixClient();
  fakeClient.joinedRooms.add(ROOM_ID);
  fakeClient.roomMembers.set(ROOM_ID, [BOT_ID, OWNER_ID]);
  fakeClient.encryptedRooms.add(ROOM_ID);

  const adapter = new MatrixChannelAdapter({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    allowedUserId: OWNER_ID,
    stateRoot: "/tmp/sandy-matrix-test",
    clientFactory: () => fakeClient,
  });

  try {
    await adapter.start(async () => {});

    await adapter.sendTaskSummaryConfirmationRequest(ROOM_ID, "summary-req-1", "inspect");

    assert.equal(fakeClient.sentEvents.length, 2);
    assert.equal(fakeClient.sentEvents[0]?.eventType, "m.room.message");
    const promptBody = asString(fakeClient.sentEvents[0]?.content["body"]);
    assert.match(promptBody, /Confirm the summary for task "inspect"/);
    assert.doesNotMatch(promptBody, /Summary:/);
    assert.equal(fakeClient.sentEvents[1]?.eventType, "org.matrix.msc3381.poll.start");
    const pollFallback = asString(fakeClient.sentEvents[1]?.content["m.text"]);
    assert.match(pollFallback, /Confirm summary/);
    assert.match(pollFallback, /Report dangerous output/);
  } finally {
    await adapter.stop();
  }
});

test("MatrixChannelAdapter sends privilege polls without the abort option and supports abort reactions", async () => {
  const fakeClient = new FakeMatrixClient();
  fakeClient.joinedRooms.add(ROOM_ID);
  fakeClient.roomMembers.set(ROOM_ID, [BOT_ID, OWNER_ID]);
  fakeClient.encryptedRooms.add(ROOM_ID);
  const received: NormalizedChatEvent[] = [];

  const adapter = new MatrixChannelAdapter({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    allowedUserId: OWNER_ID,
    stateRoot: "/tmp/sandy-matrix-test",
    clientFactory: () => fakeClient,
  });

  try {
    await adapter.start(async (event) => {
      received.push(event);
    });

    const request = {
      kind: "skill_mutation",
      requestId: "req-1",
      operation: "create",
      skillId: "skill-1",
      name: "Skill One",
    } as const;

    await adapter.sendPrivilegeRequest(ROOM_ID, request);

    assert.equal(fakeClient.sentEvents[0]?.content["msgtype"], "m.text");
    assert.equal(fakeClient.sentEvents[0]?.content["formatted_body"], renderMatrixMarkdown(messages.privilegeRequestPrompt(request)).formattedBody);
    assert.equal(fakeClient.sentEvents[1]?.content["msgtype"], "m.notice");
    assert.equal(fakeClient.sentEvents[1]?.content["formatted_body"], "<p><em>React with 😮 to abort task</em></p>");
    const pollEvent = expectDefined(fakeClient.sentEvents.at(-1), "Expected a reduced privilege poll.");
    assert.equal(pollEvent.eventType, "org.matrix.msc3381.poll.start");

    const pollAnswers = (((pollEvent.content["org.matrix.msc3381.poll.start"] as { answers: Array<{ id: string }> }).answers)).map((answer) => answer.id);
    assert.deepEqual(pollAnswers, ["approve", "deny", "report"]);

    await fakeClient.dispatch("room.event", ROOM_ID, {
      type: "m.reaction",
      event_id: "$abort",
      sender: OWNER_ID,
      origin_server_ts: 1_700_000_054_000,
      content: {
        "m.relates_to": {
          rel_type: "m.annotation",
          event_id: "$event-2",
          key: "😮",
        },
      },
    });

    assert.deepEqual(received, [{
      kind: "cancel_request",
      chatId: ROOM_ID,
      messageId: "$abort",
      senderUserId: OWNER_ID,
      timestamp: "2023-11-14T22:14:14.000Z",
    }]);
  } finally {
    await adapter.stop();
  }
});

test("MatrixChannelAdapter saves encrypted attachments and sends encrypted files in encrypted rooms", async () => {
  const fakeClient = new FakeMatrixClient();
  fakeClient.joinedRooms.add(ROOM_ID);
  fakeClient.roomMembers.set(ROOM_ID, [BOT_ID, OWNER_ID]);
  fakeClient.encryptedRooms.add(ROOM_ID);
  fakeClient.media.set("mxc://example/inbound", {
    data: Buffer.from("encrypted:hello from matrix"),
    contentType: "application/octet-stream",
  });

  const adapter = new MatrixChannelAdapter({
    homeserverUrl: "https://matrix.example",
    accessToken: "token",
    allowedUserId: OWNER_ID,
    stateRoot: "/tmp/sandy-matrix-test",
    clientFactory: () => fakeClient,
  });
  const received: NormalizedChatEvent[] = [];
  const root = await mkdtemp(join(tmpdir(), "sandy-matrix-adapter-"));

  try {
    await adapter.start(async (event) => {
      received.push(event);
    });

    await fakeClient.dispatch("room.message", ROOM_ID, {
      type: "m.room.message",
      event_id: "$file",
      sender: OWNER_ID,
      origin_server_ts: 1_700_000_000_000,
      content: {
        msgtype: "m.file",
        body: "report.txt",
        file: {
          url: "mxc://example/inbound",
          iv: "iv",
          v: "v2",
          key: {
            k: "secret",
            key_ops: ["encrypt", "decrypt"],
          },
          hashes: {
            sha256: "hash",
          },
        },
        info: {
          mimetype: "text/plain",
        },
      },
    });

    assert.equal(received[0]?.kind, "user_message");
    const saved = await adapter.saveAttachments(ROOM_ID, received[0]?.attachments ?? [], join(root, "saved"));
    assert.equal(saved.length, 1);
    assert.equal(await readFile(saved[0]!.hostPath, "utf8"), "hello from matrix");

    const outboundPath = join(root, "outbound.txt");
    await writeFile(outboundPath, "plain outbound", "utf8");
    await adapter.sendFile(ROOM_ID, outboundPath, "Caption");

    const outboundFileEvent = expectDefined(
      fakeClient.sentEvents.find((event) => event.eventType === "m.room.message"),
      "Expected an outbound Matrix file event.",
    );
    assert.ok("file" in outboundFileEvent.content);
    const uploadedMedia = fakeClient.uploads[0];
    assert.ok(uploadedMedia);
    assert.equal(uploadedMedia?.data.toString("utf8"), "encrypted:plain outbound");
    assert.equal(fakeClient.sentEvents.at(-1)?.content["msgtype"], "m.text");
    assert.equal(fakeClient.sentEvents.at(-1)?.content["formatted_body"], "<p>Caption</p>");
  } finally {
    await adapter.stop();
    await rm(root, { recursive: true, force: true });
  }
});

class FakeMatrixClient {
  public readonly handlers = new Map<string, Array<(roomId: string, event: Record<string, unknown>) => void | Promise<void>>>();
  public readonly joinedRooms = new Set<string>();
  public readonly roomMembers = new Map<string, string[]>();
  public readonly encryptedRooms = new Set<string>();
  public readonly joinCalls: string[] = [];
  public readonly leaveCalls: Array<{ roomId: string; reason?: string }> = [];
  public readonly sentEvents: Array<{ roomId: string; eventType: string; content: Record<string, unknown>; eventId: string }> = [];
  public readonly media = new Map<string, { data: Buffer; contentType: string }>();
  public readonly uploads: Array<{ mxcUrl: string; data: Buffer; contentType?: string; filename?: string }> = [];
  public sendEventFailures: Error[] = [];
  private nextEvent = 1;
  private nextMedia = 1;

  public readonly crypto = {
    isRoomEncrypted: async (roomId: string) => this.encryptedRooms.has(roomId),
    encryptMedia: async (file: Buffer) => ({
      buffer: Buffer.concat([Buffer.from("encrypted:", "utf8"), file]),
      file: {
        iv: "iv",
        v: "v2" as const,
        key: {
          kty: "oct" as const,
          key_ops: ["encrypt", "decrypt"],
          alg: "A256CTR" as const,
          k: "secret",
          ext: true as const,
        },
        hashes: {
          sha256: "hash",
        },
      },
    }),
    decryptMedia: async (file: { url: string }) => {
      const media = this.media.get(file.url);
      if (!media) {
        throw new Error(`Missing media for ${file.url}`);
      }
      const raw = media.data.toString("utf8");
      return Buffer.from(raw.startsWith("encrypted:") ? raw.slice("encrypted:".length) : raw);
    },
  };

  on(event: string, handler: (roomId: string, event: Record<string, unknown>) => void | Promise<void>): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  async start(): Promise<void> {}

  stop(): void {}

  async getWhoAmI(): Promise<{ user_id: string }> {
    return {
      user_id: BOT_ID,
    };
  }

  async getJoinedRooms(): Promise<string[]> {
    return [...this.joinedRooms];
  }

  async getJoinedRoomMembers(roomId: string): Promise<string[]> {
    return this.roomMembers.get(roomId) ?? [];
  }

  async joinRoom(roomId: string): Promise<string> {
    this.joinCalls.push(roomId);
    this.joinedRooms.add(roomId);
    return roomId;
  }

  async leaveRoom(roomId: string, reason?: string): Promise<void> {
    this.leaveCalls.push({ roomId, reason });
    this.joinedRooms.delete(roomId);
  }

  async getRoomStateEvent(roomId: string, type: string): Promise<Record<string, unknown>> {
    if (type === "m.room.encryption" && this.encryptedRooms.has(roomId)) {
      return { algorithm: "m.megolm.v1.aes-sha2" };
    }
    throw new Error("State event not found.");
  }

  async sendEvent(roomId: string, eventType: string, content: Record<string, unknown>): Promise<string> {
    const failure = this.sendEventFailures.shift();
    if (failure) {
      throw failure;
    }
    const eventId = `$event-${this.nextEvent++}`;
    this.sentEvents.push({ roomId, eventType, content, eventId });
    return eventId;
  }

  async uploadContent(data: Buffer, contentType?: string, filename?: string): Promise<string> {
    const mxcUrl = `mxc://example/${this.nextMedia++}`;
    this.media.set(mxcUrl, {
      data,
      contentType: contentType ?? "application/octet-stream",
    });
    this.uploads.push({ mxcUrl, data, contentType, filename });
    return mxcUrl;
  }

  async downloadContent(mxcUrl: string): Promise<{ data: Buffer; contentType: string }> {
    const media = this.media.get(mxcUrl);
    if (!media) {
      throw new Error(`Unknown MXC URL ${mxcUrl}`);
    }
    return media;
  }

  async dispatch(event: string, roomId: string, payload: Record<string, unknown>): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(roomId, payload);
    }
  }
}

function expectDefined<T>(value: T | null | undefined, message: string): NonNullable<T> {
  assert.notEqual(value, undefined, message);
  assert.notEqual(value, null, message);
  return value as NonNullable<T>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fakePngTableImage(width: number, height: number): { data: Buffer; width: number; height: number; alt: string } {
  const data = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data, 0);
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return { data, width, height, alt: "Markdown table" };
}

function createMatrixRateLimitError(retryAfterMs: number): Error & { retryAfterMs: number; body: { retry_after_ms: number } } {
  const error = new Error("M_LIMIT_EXCEEDED: Too Many Requests") as Error & {
    retryAfterMs: number;
    body: { retry_after_ms: number };
  };
  error.retryAfterMs = retryAfterMs;
  error.body = {
    retry_after_ms: retryAfterMs,
  };
  return error;
}
