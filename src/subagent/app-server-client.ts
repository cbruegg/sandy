import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Input } from "@openai/codex-sdk";
import { z } from "zod";
import type { ChatGPTExternalTokens } from "../types.js";
import { logger } from "../logger.js";
import { buildAppServerThreadStartParams } from "./codex-task-runtime.js";

type PendingRequest<T = unknown> = {
  resolve: (result: T) => void;
  reject: (error: Error) => void;
};

type AppServerEvent =
  | { type: "agent_message_completed"; text: string; itemId: string | null }
  | { type: "noop" }
  | { type: "turn_completed" }
  | { type: "turn_failed"; error: string }
  | { type: "error"; message: string };

const REFRESH_AUTH_METHOD = "account/chatgptAuthTokens/refresh";
const JSON_RPC_METHOD_NOT_FOUND = -32601;

const ignoredNotificationMethods = new Set([
  "account/rateLimits/updated",
  // Sandy treats item completion as the only host-visible source of
  // assistant message text and ignores intermediate delta notifications.
  "item/agentMessage/delta",
  "item/started",
  "mcpServer/startupStatus/updated",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/started",
]);

const ignoredCompletedItemTypes = new Set([
  "commandExecution",
  "command_execution",
  "mcpToolCall",
  "mcp_tool_call",
  "reasoning",
  "userMessage",
  "user_message",
]);

const refreshAuthParamsSchema = z.object({
  previousAccountId: z.string().nullable().optional(),
}).passthrough();

const turnCompletedParamsSchema = z.object({
  turn: z.object({
    status: z.string().optional(),
    error: z.object({
      message: z.string().optional(),
    }).nullable().optional(),
  }).optional(),
}).passthrough();

const turnFailedParamsSchema = z.object({
  error: z.object({
    message: z.string().optional(),
  }).nullable().optional(),
}).passthrough();

const errorParamsSchema = z.object({
  message: z.string().optional(),
}).passthrough();

const itemCompletedParamsSchema = z.object({
  item: z.object({
    id: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
  }).passthrough().optional(),
}).passthrough();

const turnCompletedNotificationSchema = turnCompletedParamsSchema.transform((data) => ({
  kind: "turn_completed" as const,
  turn: data.turn,
}));

const turnFailedNotificationSchema = turnFailedParamsSchema.transform((data) => ({
  kind: "turn_failed" as const,
  error: data.error,
}));

const errorNotificationSchema = errorParamsSchema.transform((data) => ({
  kind: "error" as const,
  message: data.message,
}));

const itemCompletedNotificationSchema = itemCompletedParamsSchema.transform((data) => ({
  kind: "item_completed" as const,
  item: data.item,
}));

type ParsedAppServerNotification =
  | z.infer<typeof turnCompletedNotificationSchema>
  | z.infer<typeof turnFailedNotificationSchema>
  | z.infer<typeof errorNotificationSchema>
  | z.infer<typeof itemCompletedNotificationSchema>
  | {
    kind: "parse_failed";
    method: string;
    params: Record<string, unknown> | undefined;
    issues: z.core.$ZodIssue[];
  }
  | { kind: "ignored"; method: string; params: Record<string, unknown> | undefined };

type ParsedCompletedItem = z.infer<typeof itemCompletedNotificationSchema>["item"];

type AuthRefreshCallback = (
  previousAccountId: string | null,
) => Promise<{ accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null }>;

type CreateExternalTokensClientOptions = {
  codexPath: string;
  tokens: ChatGPTExternalTokens;
  spawnImpl?: typeof spawn;
};

type CreateAmbientAuthClientOptions = {
  codexPath: string;
  spawnImpl?: typeof spawn;
};

type AppServerTypedRpcHost = {
  requestRaw: <T>(method: string, params?: unknown) => Promise<T>;
  writeJsonRpcMessage: (message: Record<string, unknown>) => void;
};

class AppServerTypedRpc {
  constructor(private readonly host: AppServerTypedRpcHost) {}

  private async request<T>(method: string, params?: unknown): Promise<T> {
    return await this.host.requestRaw<T>(method, params);
  }

  private writeJsonRpcMessage(message: Record<string, unknown>): void {
    this.host.writeJsonRpcMessage(message);
  }

  private sendResponse(id: number, result: unknown): void {
    this.writeJsonRpcMessage({ jsonrpc: "2.0", id, result });
  }

  private sendErrorResponse(id: number, code: number, message: string): void {
    this.writeJsonRpcMessage({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private sendInitializedNotification(): void {
    this.writeJsonRpcMessage({ jsonrpc: "2.0", method: "initialized", params: {} });
  }

  async initialize(enableExperimentalApi: boolean): Promise<void> {
    await this.request<void>("initialize", {
      clientInfo: {
        name: "sandy_worker",
        title: "Sandy Worker",
        version: "1.0.0",
      },
      capabilities: enableExperimentalApi
        ? {
            experimentalApi: true,
          }
        : {},
    });
    this.sendInitializedNotification();
  }

  async loginWithTokens(tokens: ChatGPTExternalTokens): Promise<void> {
    await this.request<void>("account/login/start", {
      type: "chatgptAuthTokens",
      accessToken: tokens.accessToken,
      chatgptAccountId: tokens.chatgptAccountId,
      chatgptPlanType: tokens.chatgptPlanType,
    });
  }

  async startThread(model?: string): Promise<{ thread: { id: string } }> {
    return await this.request<{ thread: { id: string } }>("thread/start", buildAppServerThreadStartParams(model));
  }

  async turnStart(threadId: string, input: Input): Promise<void> {
    const wireInput = typeof input === "string"
      ? [{ type: "text" as const, text: input }]
      : input;
    await this.request<void>("turn/start", { threadId, input: wireInput });
  }

  async turnInterrupt(threadId: string): Promise<void> {
    await this.request<void>("turn/interrupt", { threadId });
  }

  respondAuthRefresh(id: number, tokens: { accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null }): void {
    this.sendResponse(id, {
      accessToken: tokens.accessToken,
      chatgptAccountId: tokens.chatgptAccountId,
      chatgptPlanType: tokens.chatgptPlanType,
    });
  }

  respondMethodNotFound(id: number, method: string): void {
    this.sendErrorResponse(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private activeNotificationHandler: ((method: string, params: unknown) => void) | null = null;
  private activeAuthRefreshHandler: ((id: number, previousAccountId: string | null) => Promise<void>) | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private initialized = false;
  private loggedIn = false;
  private readonly warnedUnhandledNotificationMethods = new Set<string>();
  private readonly warnedUnhandledCompletedItemTypes = new Set<string>();
  private readonly warnedUnhandledServerRequestMethods = new Set<string>();
  private readonly rpc: AppServerTypedRpc;

  private constructor(
    private readonly codexPath: string,
    private readonly spawnImpl: typeof spawn = spawn,
  ) {
    this.rpc = new AppServerTypedRpc(this);
  }

  static async createWithExternalTokens(options: CreateExternalTokensClientOptions): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(options.codexPath, options.spawnImpl);
    await client.initialize(true);
    await client.loginWithTokens(options.tokens);
    return client;
  }

  // Ambient auth means the worker container already has its Codex credentials
  // injected before startup, either via CODEX_API_KEY for API-key mode or via a
  // seeded auth.json for auth-file copy mode. In those modes Sandy should not
  // opt into the experimental app-server auth APIs or send an explicit login
  // request over JSON-RPC.
  static async createWithAmbientAuth(options: CreateAmbientAuthClientOptions): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(options.codexPath, options.spawnImpl);
    await client.initialize(false);
    client.loggedIn = true;
    return client;
  }

  start(): void {
    if (this.child) return;

    this.child = this.spawnImpl(this.codexPath, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    const stdout = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });

    stdout.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg: Record<string, unknown> = JSON.parse(trimmed) as Record<string, unknown>;
        this.processMessage(msg);
      } catch {
        // non-JSON line, ignore
      }
    });
  }

  private processMessage(msg: Record<string, unknown>): void {
    // JSON-RPC response to one of our requests
    if (typeof msg["id"] === "number" && msg["method"] === undefined) {
      const id = msg["id"];
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if (msg["error"] !== undefined) {
          const err = msg["error"] as { code: number; message: string };
          pending.reject(new Error(`RPC error ${err.code}: ${err.message}`));
        } else {
          pending.resolve(msg["result"]);
        }
      }
      return;
    }

    // JSON-RPC request from server to client
    if (typeof msg["id"] === "number" && typeof msg["method"] === "string") {
      this.processServerRequest(msg["id"], msg["method"], msg["params"]);
      return;
    }

    // JSON-RPC notification from server to client
    if (typeof msg["method"] === "string" && msg["id"] === undefined) {
      this.processNotification(msg["method"], msg["params"]);
      return;
    }
  }

  private processServerRequest(id: number, method: string, params: unknown): void {
    if (method === REFRESH_AUTH_METHOD) {
      const parsed = refreshAuthParamsSchema.safeParse(params ?? {});
      if (this.activeAuthRefreshHandler) {
        void this.activeAuthRefreshHandler(id, parsed.success ? parsed.data.previousAccountId ?? null : null);
      }
    } else {
      this.warnUnhandledServerRequest(method, params);
      this.rpc.respondMethodNotFound(id, method);
    }
  }

  private processNotification(method: string, params: unknown): void {
    if (this.activeNotificationHandler) {
      this.activeNotificationHandler(method, params);
    }
  }

  requestRaw<T>(method: string, params?: unknown): Promise<T> {
    if (!this.child) throw new Error("App-server not started");
    const id = this.nextId++;
    this.writeJsonRpcMessage({ jsonrpc: "2.0", method, id, params });

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
      });
    });
  }

  writeJsonRpcMessage(message: Record<string, unknown>): void {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private async initialize(enableExperimentalApi: boolean): Promise<void> {
    this.start();
    await this.rpc.initialize(enableExperimentalApi);
    this.initialized = true;
  }

  async loginWithTokens(tokens: ChatGPTExternalTokens): Promise<void> {
    this.ensureStarted("loginWithTokens");
    await this.rpc.loginWithTokens(tokens);
    this.loggedIn = true;
  }

  async startThread(model?: string): Promise<string> {
    this.ensureReady("startThread");
    const result = await this.rpc.startThread(model);
    return result.thread.id;
  }

  async *streamTurn(
    threadId: string,
    input: Input,
    onAuthRefresh: AuthRefreshCallback,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<AppServerEvent> {
    this.ensureReady("streamTurn");

    const pendingEvents: AppServerEvent[] = [];
    let resolvePendingEvent: ((event: AppServerEvent | null) => void) | null = null;

    const pushEvent = (event: AppServerEvent): void => {
      if (resolvePendingEvent) {
        const resolve = resolvePendingEvent;
        resolvePendingEvent = null;
        resolve(event);
        return;
      }
      pendingEvents.push(event);
    };

    this.activeNotificationHandler = (method: string, params: unknown) => {
      pushEvent(this.parseNotification(method, params as Record<string, unknown> | undefined));
    };

    this.activeAuthRefreshHandler = async (id: number, previousAccountId: string | null) => {
      const tokens = await onAuthRefresh(previousAccountId);
      this.rpc.respondAuthRefresh(id, tokens);
    };

    await this.rpc.turnStart(threadId, input);

    try {
      let done = false;
      while (!done) {
        const event: AppServerEvent | null = await new Promise((resolve) => {
          const abortListener = () => {
            resolvePendingEvent = null;
            resolve(null);
          };
          if (abortSignal) {
            abortSignal.addEventListener("abort", abortListener, { once: true });
          }

          const queuedEvent = pendingEvents.shift();
          if (queuedEvent) {
            if (abortSignal) {
              abortSignal.removeEventListener("abort", abortListener);
            }
            resolve(queuedEvent);
            return;
          }

          resolvePendingEvent = (queued) => {
            if (abortSignal) {
              abortSignal.removeEventListener("abort", abortListener);
            }
            resolve(queued);
          };
        });

        if (!event) {
          try {
            await this.rpc.turnInterrupt(threadId);
          } catch {
            // best effort
          }
          return;
        }

        if (event.type === "noop") {
          continue;
        }

        if (event.type === "turn_completed" || event.type === "turn_failed" || event.type === "error") {
          done = true;
          yield event;
        } else {
          yield event;
        }
      }
    } finally {
      this.activeNotificationHandler = null;
      this.activeAuthRefreshHandler = null;
    }
  }

  private parseNotification(method: string, p: Record<string, unknown> | undefined): AppServerEvent {
    const notification = this.parseAppServerNotification(method, p);

    switch (notification.kind) {
      case "turn_completed":
        if (notification.turn?.status === "failed") {
          return { type: "turn_failed", error: notification.turn.error?.message ?? "Unknown turn failure." };
        }
        return { type: "turn_completed" };
      case "turn_failed":
        return { type: "turn_failed", error: notification.error?.message ?? "Unknown turn failure." };
      case "error":
        return {
          type: "error",
          message: notification.message ?? "Unknown app-server error.",
        };
      case "item_completed": {
        const itemType = notification.item?.type ?? null;
        if ((itemType === "agent_message" || itemType === "agentMessage") && typeof notification.item?.text === "string") {
          return { type: "agent_message_completed", text: notification.item.text, itemId: notification.item.id ?? null };
        }
        if (itemType && ignoredCompletedItemTypes.has(itemType)) {
          return { type: "noop" };
        }
        this.warnUnhandledCompletedItemType(itemType, notification.item);
        return { type: "noop" };
      }
      case "parse_failed":
        logger.warn("appserver.notification_parse_failed", {
          method: notification.method,
          params: notification.params,
          issues: notification.issues,
        });
        return { type: "noop" };
      case "ignored":
        if (!ignoredNotificationMethods.has(notification.method)) {
          this.warnUnhandledNotification(notification.method, notification.params);
        }
        return { type: "noop" };
    }
  }

  private parseAppServerNotification(
    method: string,
    params: Record<string, unknown> | undefined,
  ): ParsedAppServerNotification {
    switch (method) {
      case "turn/completed":
        return this.parseNotificationWithSchema(turnCompletedNotificationSchema, method, params);

      case "turn/failed":
        return this.parseNotificationWithSchema(turnFailedNotificationSchema, method, params);

      case "error":
        return this.parseNotificationWithSchema(errorNotificationSchema, method, params);

      case "item/completed":
        return this.parseNotificationWithSchema(itemCompletedNotificationSchema, method, params);

      default:
        return { kind: "ignored", method, params };
    }
  }

  private parseNotificationWithSchema<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    method: string,
    params: Record<string, unknown> | undefined,
  ):
    | z.infer<TSchema>
    | { kind: "parse_failed"; method: string; params: Record<string, unknown> | undefined; issues: z.core.$ZodIssue[] } {
    const parsed = schema.safeParse(params ?? {});
    if (parsed.success) {
      return parsed.data;
    }
    return {
      kind: "parse_failed",
      method,
      params,
      issues: parsed.error.issues,
    };
  }

  private warnUnhandledNotification(method: string, params: Record<string, unknown> | undefined): void {
    if (this.warnedUnhandledNotificationMethods.has(method)) {
      return;
    }
    this.warnedUnhandledNotificationMethods.add(method);
    logger.warn("appserver.notification_unhandled", {
      method,
      params,
    });
  }

  private warnUnhandledCompletedItemType(
    itemType: string | null,
    item: ParsedCompletedItem,
  ): void {
    const key = itemType ?? "<missing>";
    if (this.warnedUnhandledCompletedItemTypes.has(key)) {
      return;
    }
    this.warnedUnhandledCompletedItemTypes.add(key);
    logger.warn("appserver.item_completed_unhandled", {
      itemType,
      item,
    });
  }

  private warnUnhandledServerRequest(method: string, params: unknown): void {
    if (this.warnedUnhandledServerRequestMethods.has(method)) {
      return;
    }
    this.warnedUnhandledServerRequestMethods.add(method);
    logger.warn("appserver.server_request_unhandled", {
      method,
      params: params && typeof params === "object" ? params : { value: params },
    });
  }

  close(): void {
    this.activeNotificationHandler = null;
    this.activeAuthRefreshHandler = null;
    if (this.child) {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }

  private ensureStarted(method: string): void {
    if (!this.initialized) {
      throw new Error(`${method}: app-server not initialized. Call initialize() first.`);
    }
  }

  private ensureReady(method: string): void {
    this.ensureStarted(method);
    if (!this.loggedIn) {
      throw new Error(`${method}: app-server authentication not ready.`);
    }
  }
}
