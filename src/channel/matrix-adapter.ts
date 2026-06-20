import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ChannelAdapter, MessageHandler } from "./channel-adapter.js";
import { logger } from "../logger.js";
import { messages } from "../messages-to-user.js";
import { matrixHtmlAllowedTags, renderMatrixMarkdown } from "./matrix-html.js";
import { runWithMatrixSendRetry, sleepMs, type MatrixSleep } from "./matrix-send-retry.js";
import {
  buildPrivilegeControls,
  buildShareDeletionControls,
  formatPrivilegeRequestLogType,
  type ControlActionEvent,
} from "./control-surface.js";

import type {
  ChannelFormatting,
  MessageAttachment,
  NormalizedChatEvent,
  PrivilegeRequest,
  SavedAttachment,
} from "../types.js";
import type { ChatId } from "../types.js";
import type { TranscriptionProvider } from "../transcription/transcription-provider.js";

type EncryptedFile = {
  url: string;
  key: {
    kty: "oct";
    key_ops: string[];
    alg: "A256CTR";
    k: string;
    ext: true;
  };
  iv: string;
  hashes: {
    sha256: string;
  };
  v: "v2";
};

type MatrixCryptoLike = {
  isRoomEncrypted(roomId: string): Promise<boolean>;
  encryptMedia(file: Buffer): Promise<{
    buffer: Buffer;
    file: Omit<EncryptedFile, "url">;
  }>;
  decryptMedia(file: EncryptedFile): Promise<Buffer>;
};

type MatrixWhoAmI = {
  user_id: string;
  device_id?: string;
};

type MatrixMediaInfo = {
  data: Buffer;
  contentType: string;
};

type MatrixClientLike = {
  on(event: string, handler: (roomId: string, event: Record<string, unknown>) => void | Promise<void>): unknown;
  start(filter?: unknown): Promise<unknown>;
  stop(): void;
  getWhoAmI(): Promise<MatrixWhoAmI>;
  getJoinedRooms(): Promise<string[]>;
  getJoinedRoomMembers(roomId: string): Promise<string[]>;
  joinRoom(roomId: string, viaServers?: string[]): Promise<string>;
  leaveRoom(roomId: string, reason?: string): Promise<unknown>;
  getRoomStateEvent(roomId: string, type: string, stateKey: string): Promise<unknown>;
  sendEvent(roomId: string, eventType: string, content: Record<string, unknown>): Promise<string>;
  uploadContent(data: Buffer, contentType?: string, filename?: string): Promise<string>;
  downloadContent(mxcUrl: string, allowRemote?: boolean): Promise<MatrixMediaInfo>;
  crypto?: MatrixCryptoLike;
};

type MatrixMessageContent = {
  body?: string;
  msgtype?: string;
  url?: string;
  file?: unknown;
  info?: {
    mimetype?: string;
  };
};

type MatrixClientFactory = (options: {
  homeserverUrl: string;
  accessToken: string;
  stateRoot: string;
}) => MatrixClientLike | Promise<MatrixClientLike>;

type MatrixAdapterOptions = {
  homeserverUrl: string;
  accessToken: string;
  allowedUserId: string;
  stateRoot: string;
  clientFactory?: MatrixClientFactory;
  transcriptionProvider?: TranscriptionProvider;
  sleep?: MatrixSleep;
};

type MatrixAttachmentRef = {
  roomId: string;
  fileName: string;
  mimeType?: string;
  url?: string;
  encryptedFile?: EncryptedFile;
};

type MatrixPollAction = {
  event: ControlActionEvent;
};

type MatrixPollRecord = {
  roomId: string;
  actionsByAnswerId: Map<string, MatrixPollAction>;
};

type MatrixReactionAction = {
  key: string;
  event: ControlActionEvent;
};

type MatrixReactionRecord = {
  roomId: string;
  actionsByKey: Map<string, MatrixReactionAction>;
};

type MatrixEventBase = {
  chatId: ChatId;
  messageId: string;
  senderUserId: string;
  timestamp: string;
};

type MatrixNormalizeDeps = {
  client: MatrixClientLike;
  transcriptionProvider: TranscriptionProvider | null;
  sendText: (chatId: ChatId, text: string) => Promise<void>;
  saveAttachmentRef: (attachmentId: string, ref: MatrixAttachmentRef) => void;
};

const matrixFormatting: ChannelFormatting = {
  channelId: "matrix",
  markup: "markdown",
  allowedTags: matrixHtmlAllowedTags,
  instructions: "Format user-visible output as Markdown. Use backticks for inline code and fenced code blocks for multiline command output. Do not emit raw HTML; Matrix delivery will convert Markdown to safe HTML.",
};

const MATRIX_POLL_START_EVENT_TYPE = "org.matrix.msc3381.poll.start";
const MATRIX_POLL_RESPONSE_EVENT_TYPE = "org.matrix.msc3381.poll.response";
const MATRIX_POLL_DISCLOSED_KIND = "org.matrix.msc3381.poll.disclosed";
const MATRIX_REFERENCE_RELATION = "m.reference";
const MATRIX_REACTION_EVENT_TYPE = "m.reaction";
const MATRIX_CRYPTO_STORE_SQLITE = 0;
const MATRIX_FINISH_REACTION = "👍";
const MATRIX_ABORT_REACTION = "😮";

async function defaultMatrixClientFactory(options: {
  homeserverUrl: string;
  accessToken: string;
  stateRoot: string;
}): Promise<MatrixClientLike> {
  const {
    MatrixClient,
    RustSdkCryptoStorageProvider,
    SimpleFsStorageProvider,
  } = await import("@vector-im/matrix-bot-sdk");
  const storage = new SimpleFsStorageProvider(join(options.stateRoot, "client.json"));
  const cryptoStorage = new RustSdkCryptoStorageProvider(join(options.stateRoot, "crypto"), MATRIX_CRYPTO_STORE_SQLITE);
  return new MatrixClient(options.homeserverUrl, options.accessToken, storage, cryptoStorage);
}

export class MatrixChannelAdapter implements ChannelAdapter {
  private readonly homeserverUrl: string;
  private readonly accessToken: string;
  private readonly allowedUserId: string;
  private readonly stateRoot: string;
  private readonly transcriptionProvider: TranscriptionProvider | null;
  private readonly clientFactory: MatrixClientFactory;
  private readonly sleep: MatrixSleep;
  private client: MatrixClientLike | null = null;
  private startPromise: Promise<void> | null = null;
  private botUserId: string | null = null;
  private botDeviceId: string | null = null;
  private readonly lastUserInteractionTimestamps = new Map<ChatId, string>();
  private readonly activePolls = new Map<string, MatrixPollRecord>();
  private readonly activeReactionHandlers = new Map<string, MatrixReactionRecord>();
  private readonly attachmentRefs = new Map<string, MatrixAttachmentRef>();
  private readonly qualifiedRooms = new Set<string>();

  constructor(options: MatrixAdapterOptions) {
    this.homeserverUrl = options.homeserverUrl;
    this.accessToken = options.accessToken;
    this.allowedUserId = options.allowedUserId;
    this.stateRoot = options.stateRoot;
    this.transcriptionProvider = options.transcriptionProvider ?? null;
    this.clientFactory = options.clientFactory ?? defaultMatrixClientFactory;
    this.sleep = options.sleep ?? sleepMs;
  }

  getFormatting(): ChannelFormatting {
    return matrixFormatting;
  }

  getLastUserInteractionTimestamp(chatId: ChatId): string | null {
    return this.lastUserInteractionTimestamps.get(chatId) ?? null;
  }

  async start(handler: MessageHandler): Promise<void> {
    if (this.startPromise) {
      return;
    }

    await mkdir(this.stateRoot, { recursive: true });
    this.client = await this.clientFactory({
      homeserverUrl: this.homeserverUrl,
      accessToken: this.accessToken,
      stateRoot: this.stateRoot,
    });

    const client = this.requireClient();
    const whoAmI = await client.getWhoAmI();
    this.botUserId = whoAmI.user_id;
    this.botDeviceId = whoAmI.device_id ?? null;

    client.on("room.invite", async (roomId, event) => this.handleInvite(roomId, event));
    client.on("room.join", async (roomId, event) => this.handleJoin(roomId, event));
    client.on("room.leave", (roomId) => {
      this.qualifiedRooms.delete(roomId);
      this.discardRoomState(roomId);
    });
    client.on("room.message", async (roomId, event) => this.handleRoomMessage(roomId, event, handler));
    client.on("room.event", async (roomId, event) => this.handleRoomEvent(roomId, event, handler));

    this.startPromise = (async () => {
      logger.info("matrix.sync_started", {
        homeserverUrl: this.homeserverUrl,
        allowedUserId: this.allowedUserId,
        botUserId: this.botUserId,
        botDeviceId: this.botDeviceId,
      });
      await client.start();
      const joinedRooms = await client.getJoinedRooms();
      for (const roomId of joinedRooms) {
        await this.ensureQualifiedRoom(roomId);
      }
      logger.info("matrix.client_started", {
        joinedRoomCount: joinedRooms.length,
      });
    })();

    await this.startPromise;
  }

  async stop(): Promise<void> {
    if (!this.startPromise || !this.client) {
      return;
    }
    this.client.stop();
    await this.startPromise;
    this.startPromise = null;
    this.client = null;
    this.botUserId = null;
    this.botDeviceId = null;
    this.activePolls.clear();
    this.activeReactionHandlers.clear();
    this.attachmentRefs.clear();
    this.qualifiedRooms.clear();
    logger.info("matrix.sync_stopped");
  }

  async saveAttachments(chatId: ChatId, attachments: MessageAttachment[], targetDirectory: string): Promise<SavedAttachment[]> {
    await mkdir(targetDirectory, { recursive: true });
    const client = this.requireClient();
    const saved: SavedAttachment[] = [];

    for (const attachment of attachments) {
      const ref = this.attachmentRefs.get(attachment.attachmentId);
      if (!ref) {
        throw new Error(`Unknown Matrix attachment reference for ${attachment.attachmentId}.`);
      }
      const data = await downloadMatrixAttachment(client, ref);
      const fileName = `${saved.length + 1}-${sanitizeMatrixFileName(ref.fileName)}`;
      const hostPath = join(targetDirectory, fileName);
      await writeFile(hostPath, data);
      saved.push({
        attachmentId: attachment.attachmentId,
        kind: attachment.kind,
        fileName: ref.fileName,
        mimeType: ref.mimeType,
        hostPath,
      });
      logger.info("matrix.attachment_saved", {
        chatId,
        attachmentId: attachment.attachmentId,
        targetPath: hostPath,
      });
    }

    return saved;
  }

  async sendFile(chatId: ChatId, filePath: string, caption?: string): Promise<void> {
    const client = this.requireClient();
    const fileName = basename(filePath);
    const raw = await readFile(filePath);
    const content = await buildMatrixFileContent(client, chatId, raw, fileName);
    logger.info("matrix.send_file", {
      chatId,
      filePath,
      captionPreview: caption ? previewText(caption) : undefined,
    });
    await client.sendEvent(chatId, "m.room.message", content);
    if (caption) {
      await this.sendText(chatId, caption);
    }
  }

  async sendText(chatId: ChatId, text: string): Promise<void> {
    logger.debug("matrix.send_text", {
      chatId,
      textPreview: previewText(text),
    });
    await this.sendTextMessage(chatId, text);
  }

  async sendTaskUpdate(chatId: ChatId, text: string): Promise<void> {
    logger.debug("matrix.send_task_update", {
      chatId,
      textPreview: previewText(text),
    });
    await this.sendNotice(chatId, text);
    const hintEventId = await this.sendNotice(chatId, messages.matrixTaskReactionHint());
    this.registerReactions(chatId, hintEventId, [
      { key: MATRIX_FINISH_REACTION, event: { kind: "mark_finished_request" } },
      { key: MATRIX_ABORT_REACTION, event: { kind: "cancel_request" } },
    ]);
  }

  async sendReportableText(chatId: ChatId, text: string): Promise<void> {
    logger.debug("matrix.send_reportable_text", {
      chatId,
      textPreview: previewText(text),
    });
    this.discardRoomControls(chatId);
    await this.sendTextMessage(chatId, text);
    const hintEventId = await this.sendNotice(chatId, messages.matrixReportReactionHint());
    this.registerReactions(chatId, hintEventId, [
      { key: MATRIX_ABORT_REACTION, event: { kind: "danger_report" } },
    ]);
  }

  async sendPrivilegeRequest(chatId: ChatId, request: PrivilegeRequest): Promise<void> {
    const requestType = formatPrivilegeRequestLogType(request);
    logger.info("matrix.send_privilege_request", {
      chatId,
      requestId: request.requestId,
      requestType,
    });
    await this.sendTextMessage(chatId, messages.privilegeRequestPrompt(request));
    const hintEventId = await this.sendNotice(chatId, messages.matrixAbortReactionHint());
    this.registerReactions(chatId, hintEventId, [
      { key: MATRIX_ABORT_REACTION, event: { kind: "cancel_request" } },
    ]);
    const controls = buildPrivilegeControls(request);
    await this.sendPoll(chatId, "Privilege request", controls.rows.flat()
      .filter((action) => action.event.kind !== "cancel_request")
      .map((a) => ({ answerId: a.actionId, label: a.label, event: a.event })));
  }

  async askForDenialReason(chatId: ChatId, request: PrivilegeRequest): Promise<void> {
    logger.info("matrix.ask_for_denial_reason", {
      chatId,
      requestId: request.requestId,
    });
    // Matrix has no force-reply primitive. In the 1:1 encrypted rooms Sandy
    // requires, the next text message is unambiguously the user's reply, so a
    // notice inviting a reply is sufficient; the orchestrator binds the next
    // inbound text to this denial via its awaiting_denial_reason state.
    await this.sendTextMessage(chatId, messages.denialReasonPrompt(request));
  }

  async sendShareDeletionRequest(chatId: ChatId, requestId: string, taskName: string, summary: string): Promise<void> {
    logger.info("matrix.send_share_deletion_request", {
      chatId,
      requestId,
      taskName,
    });
    await this.sendTextMessage(chatId, messages.shareDeletionRequestPrompt(taskName, summary));
    const controls = buildShareDeletionControls(requestId);
    await this.sendPoll(chatId, "Shared workspace cleanup", controls.rows.flat().map((a) => ({ answerId: a.actionId, label: a.label, event: a.event })));
  }

  private async sendNotice(chatId: ChatId, text: string): Promise<string> {
    return this.sendFormattedMessage(chatId, text, "m.notice");
  }

  private async sendTextMessage(chatId: ChatId, text: string): Promise<string> {
    return this.sendFormattedMessage(chatId, text, "m.text");
  }

  private async sendFormattedMessage(chatId: ChatId, text: string, msgtype: "m.notice" | "m.text"): Promise<string> {
    const rendered = renderMatrixMarkdown(text);
    return this.sendWithMatrixBackoff(
      "matrix.send_message",
      () => this.requireClient().sendEvent(chatId, "m.room.message", {
        body: rendered.body,
        msgtype,
        format: "org.matrix.custom.html",
        formatted_body: rendered.formattedBody,
      }),
    );
  }

  private async sendPoll(
    roomId: string,
    question: string,
    options: Array<{
      answerId: string;
      label: string;
      event: ControlActionEvent;
    }>,
  ): Promise<void> {
    if (options.length === 0) {
      return;
    }
    const client = this.requireClient();
    const eventId = await this.sendWithMatrixBackoff(
      "matrix.send_poll",
      () => client.sendEvent(roomId, MATRIX_POLL_START_EVENT_TYPE, buildMatrixPollStartContent(question, options)),
    );
    this.activePolls.set(eventId, {
      roomId,
      actionsByAnswerId: new Map(options.map((option) => [option.answerId, { event: option.event }])),
    });
  }

  private registerReactions(roomId: string, eventId: string, actions: MatrixReactionAction[]): void {
    this.activeReactionHandlers.set(eventId, {
      roomId,
      actionsByKey: new Map(actions.map((action) => [normalizeMatrixReactionKey(action.key), action])),
    });
  }

  private async sendWithMatrixBackoff<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
    return runWithMatrixSendRetry(operationName, operation, this.sleep);
  }

  private requireClient(): MatrixClientLike {
    if (!this.client) {
      throw new Error("Matrix client is not started.");
    }
    return this.client;
  }

  private async handleInvite(roomId: string, event: Record<string, unknown>): Promise<void> {
    const sender = asOptionalString(event["sender"]) ?? "";
    if (sender !== this.allowedUserId) {
      logger.info("matrix.invite_ignored", {
        roomId,
        sender,
      });
      return;
    }
    logger.info("matrix.invite_joining", {
      roomId,
      sender,
    });
    await this.requireClient().joinRoom(roomId);
    await this.ensureQualifiedRoom(roomId);
  }

  private async handleJoin(roomId: string, _event: Record<string, unknown>): Promise<void> {
    await this.ensureQualifiedRoom(roomId);
  }

  private async handleRoomMessage(roomId: string, event: Record<string, unknown>, handler: MessageHandler): Promise<void> {
    if (!(await this.shouldHandleInboundEvent(roomId, event))) {
      return;
    }
    const normalized = await normalizeMatrixRoomMessage(roomId, event, {
      client: this.requireClient(),
      transcriptionProvider: this.transcriptionProvider,
      sendText: (chatId, text) => this.sendText(chatId, text),
      saveAttachmentRef: (attachmentId, ref) => this.attachmentRefs.set(attachmentId, ref),
    });
    if (!normalized) {
      return;
    }
    logger.info("matrix.event_received", {
      roomId,
      kind: normalized.kind,
      eventId: normalized.messageId,
    });
    this.lastUserInteractionTimestamps.set(normalized.chatId, normalized.timestamp);
    try {
      await handler(normalized);
    } catch (error) {
      logger.error("matrix.handler_error", error, "Unknown handler error.", {
        kind: normalized.kind,
        chatId: normalized.chatId,
      });
    }
  }

  private async handleRoomEvent(roomId: string, event: Record<string, unknown>, handler: MessageHandler): Promise<void> {
    if (event["type"] === "m.room.member" || event["type"] === "m.room.encryption") {
      await this.ensureQualifiedRoom(roomId);
      return;
    }
    if (!(await this.shouldHandleInboundEvent(roomId, event))) {
      return;
    }
    const normalizedReaction = normalizeMatrixReactionResponse(roomId, event, this.activeReactionHandlers);
    if (normalizedReaction) {
      const relatedEventId = extractRelatedReactionEventId(event);
      if (relatedEventId) {
        this.activeReactionHandlers.delete(relatedEventId);
      }
      logger.info("matrix.reaction_received", {
        roomId,
        kind: normalizedReaction.kind,
        eventId: normalizedReaction.messageId,
      });
      this.lastUserInteractionTimestamps.set(normalizedReaction.chatId, normalizedReaction.timestamp);
      try {
        await handler(normalizedReaction);
      } catch (error) {
        logger.error("matrix.handler_error", error, "Unknown handler error.", {
          kind: normalizedReaction.kind,
          chatId: normalizedReaction.chatId,
        });
      }
      return;
    }
    if (event["type"] === MATRIX_REACTION_EVENT_TYPE) {
      logger.debug("matrix.reaction_ignored", {
        roomId,
        eventId: asOptionalString(event["event_id"]),
        relatedEventId: extractRelatedReactionEventId(event),
        reactionKey: extractMatrixReactionKey(event),
      });
    }
    const normalized = normalizeMatrixPollResponse(roomId, event, this.activePolls);
    if (!normalized) {
      return;
    }
    const pollEventId = extractRelatedPollEventId(event);
    if (pollEventId) {
      this.activePolls.delete(pollEventId);
    }
    logger.info("matrix.poll_response_received", {
      roomId,
      kind: normalized.kind,
      eventId: normalized.messageId,
    });
    this.lastUserInteractionTimestamps.set(normalized.chatId, normalized.timestamp);
    try {
      await handler(normalized);
    } catch (error) {
      logger.error("matrix.handler_error", error, "Unknown handler error.", {
        kind: normalized.kind,
        chatId: normalized.chatId,
      });
    }
  }

  private async shouldHandleInboundEvent(roomId: string, event: Record<string, unknown>): Promise<boolean> {
    if (!this.botUserId) {
      return false;
    }
    if (!(await this.ensureQualifiedRoom(roomId))) {
      return false;
    }
    const sender = asOptionalString(event["sender"]) ?? "";
    if (!sender || sender === this.botUserId) {
      return false;
    }
    if (sender !== this.allowedUserId) {
      logger.info("matrix.event_ignored_unauthorized", {
        roomId,
        sender,
        eventType: event["type"],
      });
      return false;
    }
    return true;
  }

  private async ensureQualifiedRoom(roomId: string): Promise<boolean> {
    const client = this.requireClient();
    const botUserId = this.botUserId;
    if (!botUserId) {
      return false;
    }

    let joinedMembers: string[];
    try {
      joinedMembers = await client.getJoinedRoomMembers(roomId);
    } catch (error) {
      logger.warn("matrix.room_validation_failed", {
        roomId,
        message: error instanceof Error ? error.message : "Unknown room validation failure.",
      });
      this.qualifiedRooms.delete(roomId);
      return false;
    }
    const encrypted = await isMatrixRoomEncrypted(client, roomId);

    const isQualified = encrypted
      && joinedMembers.length === 2
      && joinedMembers.includes(this.allowedUserId)
      && joinedMembers.includes(botUserId);

    if (isQualified) {
      this.qualifiedRooms.add(roomId);
      return true;
    }

    this.qualifiedRooms.delete(roomId);
    this.discardRoomState(roomId);
    logger.warn("matrix.room_unqualified", {
      roomId,
      encrypted,
      joinedMembers,
    });
    try {
      await client.leaveRoom(roomId, "Sandy only supports encrypted 1:1 rooms with the configured user.");
    } catch (error) {
      logger.warn("matrix.room_leave_failed", {
        roomId,
        message: error instanceof Error ? error.message : "Unknown room leave failure.",
      });
    }
    return false;
  }

  private discardRoomState(roomId: string): void {
    this.discardRoomControls(roomId);
    for (const [attachmentId, ref] of this.attachmentRefs.entries()) {
      if (ref.roomId === roomId) {
        this.attachmentRefs.delete(attachmentId);
      }
    }
  }

  private discardRoomPolls(roomId: string): void {
    for (const [eventId, record] of this.activePolls.entries()) {
      if (record.roomId === roomId) {
        this.activePolls.delete(eventId);
      }
    }
  }

  private discardRoomReactions(roomId: string): void {
    for (const [eventId, record] of this.activeReactionHandlers.entries()) {
      if (record.roomId === roomId) {
        this.activeReactionHandlers.delete(eventId);
      }
    }
  }

  private discardRoomControls(roomId: string): void {
    this.discardRoomPolls(roomId);
    this.discardRoomReactions(roomId);
  }
}

export async function normalizeMatrixRoomMessage(
  roomId: string,
  event: Record<string, unknown>,
  deps: MatrixNormalizeDeps,
): Promise<NormalizedChatEvent | null> {
  if (event["type"] !== "m.room.message") {
    return null;
  }

  const content = asRecord(event["content"]);
  const msgtype = asOptionalString(content["msgtype"]) ?? "";
  const base = buildMatrixEventBase(roomId, event);

  if (msgtype === "m.text" || msgtype === "m.notice" || msgtype === "m.emote") {
    const body = asOptionalString((content as MatrixMessageContent)["body"]) ?? "";
    return {
      kind: "user_message",
      ...base,
      text: body,
      rawText: body,
      attachments: [],
    };
  }

  if (msgtype === "m.audio") {
    return normalizeMatrixAudioMessage(base, content, deps);
  }

  if (msgtype === "m.file" || msgtype === "m.image" || msgtype === "m.video") {
    const attachmentId = `${base.messageId}:1`;
    const messageContent = content as MatrixMessageContent;
    const fileName = sanitizeMatrixFileName(asOptionalString(messageContent["body"]) ?? "attachment");
    const attachmentRef = buildMatrixAttachmentRef(roomId, fileName, content);
    if (!attachmentRef) {
      return null;
    }
    deps.saveAttachmentRef(attachmentId, attachmentRef);
    const attachmentKind = msgtype === "m.image" ? "image" : "file";
    return {
      kind: "user_message",
      ...base,
      text: "",
      rawText: "",
      attachments: [{
        attachmentId,
        kind: attachmentKind,
        fileName,
        mimeType: attachmentRef.mimeType,
      }],
    };
  }

  return null;
}

export function normalizeMatrixPollResponse(
  roomId: string,
  event: Record<string, unknown>,
  activePolls: ReadonlyMap<string, MatrixPollRecord>,
): NormalizedChatEvent | null {
  if (event["type"] !== MATRIX_POLL_RESPONSE_EVENT_TYPE && event["type"] !== "m.poll.response") {
    return null;
  }
  const pollEventId = extractRelatedPollEventId(event);
  if (!pollEventId) {
    return null;
  }
  const pollRecord = activePolls.get(pollEventId);
  if (!pollRecord || pollRecord.roomId !== roomId) {
    return null;
  }
  const answerIds = extractMatrixPollAnswerIds(event);
  const matched = answerIds.map((answerId) => pollRecord.actionsByAnswerId.get(answerId)).find((value) => value);
  if (!matched) {
    return null;
  }
  return {
    ...matched.event,
    ...buildMatrixEventBase(roomId, event),
  };
}

export function normalizeMatrixReactionResponse(
  roomId: string,
  event: Record<string, unknown>,
  activeReactionHandlers: ReadonlyMap<string, MatrixReactionRecord>,
): NormalizedChatEvent | null {
  if (event["type"] !== MATRIX_REACTION_EVENT_TYPE) {
    return null;
  }
  const relatedEventId = extractRelatedReactionEventId(event);
  if (!relatedEventId) {
    return null;
  }
  const reactionRecord = activeReactionHandlers.get(relatedEventId);
  if (!reactionRecord || reactionRecord.roomId !== roomId) {
    return null;
  }
  const reactionKey = extractMatrixReactionKey(event);
  if (!reactionKey) {
    return null;
  }
  const matched = reactionRecord.actionsByKey.get(normalizeMatrixReactionKey(reactionKey));
  if (!matched) {
    return null;
  }
  return {
    ...matched.event,
    ...buildMatrixEventBase(roomId, event),
  };
}

export function buildMatrixPollStartContent(
  question: string,
  options: Array<{
    answerId: string;
    label: string;
  }>,
): Record<string, unknown> {
  const fallback = [
    question,
    ...options.map((option) => `- ${option.label}`),
  ].join("\n");
  return {
    "org.matrix.msc1767.text": fallback,
    "m.text": fallback,
    [MATRIX_POLL_START_EVENT_TYPE]: {
      question: {
        "org.matrix.msc1767.text": question,
        "m.text": question,
      },
      kind: MATRIX_POLL_DISCLOSED_KIND,
      max_selections: 1,
      answers: options.map((option) => ({
        id: option.answerId,
        "org.matrix.msc1767.text": option.label,
        "m.text": option.label,
      })),
    },
  };
}

async function normalizeMatrixAudioMessage(
  base: MatrixEventBase,
  content: MatrixMessageContent,
  deps: MatrixNormalizeDeps,
): Promise<NormalizedChatEvent | null> {
  if (!deps.transcriptionProvider) {
    await deps.sendText(base.chatId, messages.voiceMessagesNotEnabled());
    return null;
  }

  try {
    const attachment = buildMatrixAttachmentRef(base.chatId, asOptionalString(content["body"]) ?? "voice.ogg", content);
    if (!attachment) {
      return {
        kind: "unsupported_input",
        ...base,
        inputType: "voice",
      };
    }
    const audio = await downloadMatrixAttachment(deps.client, attachment);
    const transcript = await deps.transcriptionProvider.transcribe({
      audio,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    });
    return {
      kind: "user_message",
      ...base,
      text: transcript,
      rawText: transcript,
      attachments: [],
    };
  } catch (error) {
    logger.warn("matrix.voice_transcription_failed", {
      chatId: base.chatId,
      messageId: base.messageId,
      message: error instanceof Error ? error.message : "Unknown transcription failure.",
    });
    await deps.sendText(base.chatId, messages.voiceTranscriptionFailed());
    return null;
  }
}

function buildMatrixAttachmentRef(
  roomId: string,
  fileName: string,
  content: MatrixMessageContent | Record<string, unknown>,
): MatrixAttachmentRef | null {
  const encryptedFile = parseEncryptedFile(content["file"]);
  const url = asOptionalString(content["url"]);
  const info = asRecord(content["info"]);
  if (!encryptedFile && !url) {
    return null;
  }
  return {
    roomId,
    fileName,
    mimeType: asOptionalString(info["mimetype"]) ?? undefined,
    url,
    encryptedFile,
  };
}

async function buildMatrixFileContent(
  client: MatrixClientLike,
  roomId: string,
  data: Buffer,
  fileName: string,
): Promise<Record<string, unknown>> {
  const encrypted = await isMatrixRoomEncrypted(client, roomId);
  if (encrypted && client.crypto) {
    const encryptedMedia = await client.crypto.encryptMedia(data);
    const mxcUrl = await client.uploadContent(encryptedMedia.buffer, "application/octet-stream", fileName);
    return {
      body: fileName,
      msgtype: "m.file",
      file: {
        ...encryptedMedia.file,
        url: mxcUrl,
      },
    };
  }

  const mxcUrl = await client.uploadContent(data, "application/octet-stream", fileName);
  return {
    body: fileName,
    msgtype: "m.file",
    url: mxcUrl,
  };
}

async function downloadMatrixAttachment(client: MatrixClientLike, ref: MatrixAttachmentRef): Promise<Buffer> {
  if (ref.encryptedFile) {
    if (!client.crypto) {
      throw new Error("Matrix crypto is unavailable for encrypted attachment download.");
    }
    return client.crypto.decryptMedia(ref.encryptedFile);
  }
  if (!ref.url) {
    throw new Error("Matrix attachment is missing a media URL.");
  }
  return (await client.downloadContent(ref.url)).data;
}

async function isMatrixRoomEncrypted(client: MatrixClientLike, roomId: string): Promise<boolean> {
  if (client.crypto) {
    return client.crypto.isRoomEncrypted(roomId);
  }
  try {
    await client.getRoomStateEvent(roomId, "m.room.encryption", "");
    return true;
  } catch {
    return false;
  }
}

function buildMatrixEventBase(roomId: string, event: Record<string, unknown>): MatrixEventBase {
  return {
    chatId: roomId,
    messageId: asOptionalString(event["event_id"]) ?? "",
    senderUserId: asOptionalString(event["sender"]) ?? "",
    timestamp: new Date(Number(event["origin_server_ts"] ?? Date.now())).toISOString(),
  };
}

function extractRelatedPollEventId(event: Record<string, unknown>): string | null {
  const content = asRecord(event["content"]);
  const relation = asRecord(content["m.relates_to"]);
  if (relation["rel_type"] !== MATRIX_REFERENCE_RELATION) {
    return null;
  }
  const eventId = asOptionalString(relation["event_id"]);
  return eventId ?? null;
}

function extractRelatedReactionEventId(event: Record<string, unknown>): string | null {
  const content = asRecord(event["content"]);
  const relation = asRecord(content["m.relates_to"]);
  if (relation["rel_type"] !== "m.annotation") {
    return null;
  }
  const eventId = asOptionalString(relation["event_id"]);
  return eventId ?? null;
}

function extractMatrixReactionKey(event: Record<string, unknown>): string | null {
  const content = asRecord(event["content"]);
  const relation = asRecord(content["m.relates_to"]);
  const key = asOptionalString(relation["key"]);
  return key ?? null;
}

function normalizeMatrixReactionKey(key: string): string {
  return key.trim().replaceAll(/[\uFE0E\uFE0F]/g, "");
}

function extractMatrixPollAnswerIds(event: Record<string, unknown>): string[] {
  const content = asRecord(event["content"]);
  const unstable = asRecord(content[MATRIX_POLL_RESPONSE_EVENT_TYPE]);
  const stable = asRecord(content["m.poll.response"]);
  const answers = unstable["answers"] ?? stable["answers"];
  return Array.isArray(answers) ? answers.filter((value): value is string => typeof value === "string") : [];
}

function parseEncryptedFile(value: unknown): EncryptedFile | undefined {
  const record = asRecord(value);
  const url = asOptionalString(record["url"]);
  const iv = asOptionalString(record["iv"]);
  const version = asOptionalString(record["v"]);
  const key = asRecord(record["key"]);
  const hashes = asRecord(record["hashes"]);
  const keyValue = asOptionalString(key["k"]);
  const hash = asOptionalString(hashes["sha256"]);
  if (!url || !iv || !version || !keyValue || !hash) {
    return undefined;
  }
  return {
    url,
    iv,
    v: version as EncryptedFile["v"],
    key: {
      kty: "oct",
      key_ops: Array.isArray(key["key_ops"]) ? key["key_ops"].filter((entry): entry is string => typeof entry === "string") : [],
      alg: "A256CTR",
      k: keyValue,
      ext: true,
    },
    hashes: {
      sha256: hash,
    },
  };
}

function sanitizeMatrixFileName(fileName: string): string {
  const fallback = "attachment";
  const trimmed = fileName.trim();
  const normalized = trimmed.replaceAll(/[^A-Za-z0-9._-]+/g, "_").replaceAll(/^_+|_+$/g, "");
  return normalized || fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function previewText(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}
