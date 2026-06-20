import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MatrixChannelAdapter,
  buildMatrixPollStartContent,
  normalizeMatrixPollResponse,
  normalizeMatrixReactionResponse,
  normalizeMatrixRoomMessage,
} from "./matrix-adapter.js";
import { resolveMatrixCryptoBinaryName } from "./matrix-crypto-targets.js";
import { sanitizeMatrixHtml } from "./matrix-html.js";
import type { NormalizedChatEvent } from "../types.js";
import type { TranscriptionProvider } from "../transcription/transcription-provider.js";
import { messages } from "../messages-to-user.js";

const BOT_ID = "@sandy:example.org";
const OWNER_ID = "@owner:example.org";
const OTHER_ID = "@other:example.org";
const ROOM_ID = "!room:example.org";

test("sanitizeMatrixHtml preserves only the supported tags", () => {
  assert.equal(
    sanitizeMatrixHtml("Use <b>bold</b> and <script>alert(1)</script> plus <code>x < y</code>."),
    "Use <b>bold</b> and &lt;script&gt;alert(1)&lt;/script&gt; plus <code>x &lt; y</code>.",
  );
});

test("sanitizeMatrixHtml renders line breaks outside code and pre blocks", () => {
  assert.equal(
    sanitizeMatrixHtml("<b>Line 1</b>\nLine 2\\n<pre>a\nb</pre>\n<code>x\\ny</code>"),
    "<b>Line 1</b><br>Line 2<br><pre>a\nb</pre><br><code>x\\ny</code>",
  );
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
  const activeReactions = new Map([["$notice", {
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
  }, activeReactions);

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
  }, activeReactions);

  assert.equal(staleResponse, null);
});

test("normalizeMatrixReactionResponse accepts emoji variation selectors", () => {
  const activeReactions = new Map([["$notice", {
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
  }, activeReactions);

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
    const noticeEventId = "$notice-1";

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
    const taskNoticeId = "$notice-1";

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
    const finalNoticeId = "$notice-2";

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
        kind: "cancel_request",
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
  fakeClient.sendHtmlNoticeFailures = [
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
    assert.equal(fakeClient.notices.at(-1)?.html, `Still working.<br><br>${messages.matrixTaskReactionHint()}`);
    assert.equal(fakeClient.sentEvents.length, 0);
  } finally {
    await adapter.stop();
  }
});

test("MatrixChannelAdapter sends task updates and reportable text without polls", async () => {
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

    assert.deepEqual(fakeClient.notices.map((notice) => notice.html), [
      `Still working.<br><br>${messages.matrixTaskReactionHint()}`,
      `Task complete.<br><br>${messages.matrixAbortReactionHint()}`,
    ]);
    assert.equal(fakeClient.sentEvents.length, 0);
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

    assert.equal(fakeClient.notices.at(-1)?.html, `${sanitizeMatrixHtml(messages.privilegeRequestPrompt(request))}<br><br>${messages.matrixAbortReactionHint()}`);
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
          event_id: "$notice-1",
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
    assert.equal(fakeClient.notices.at(-1)?.html, "Caption");
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
  public readonly notices: Array<{ roomId: string; html: string }> = [];
  public readonly sentEvents: Array<{ roomId: string; eventType: string; content: Record<string, unknown>; eventId: string }> = [];
  public readonly media = new Map<string, { data: Buffer; contentType: string }>();
  public readonly uploads: Array<{ mxcUrl: string; data: Buffer; contentType?: string; filename?: string }> = [];
  public sendHtmlNoticeFailures: Error[] = [];
  public sendEventFailures: Error[] = [];
  private nextEvent = 1;
  private nextMedia = 1;

  public readonly crypto = {
    isRoomEncrypted: async (roomId: string) => this.encryptedRooms.has(roomId),
    encryptMedia: async (file: Buffer) => ({
      buffer: Buffer.from(`encrypted:${file.toString("utf8")}`),
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

  async sendHtmlNotice(roomId: string, html: string): Promise<string> {
    const failure = this.sendHtmlNoticeFailures.shift();
    if (failure) {
      throw failure;
    }
    this.notices.push({ roomId, html });
    return `$notice-${this.nextEvent++}`;
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
