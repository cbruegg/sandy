import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Input } from "@openai/codex-sdk";
import { z } from "zod";
import type { ChatGPTExternalTokens } from "../types.js";
import { logger } from "../logger.js";
import type { InitializeParams } from "./generated/InitializeParams.js";
import type { RequestId } from "./generated/RequestId.js";
import type { ServerNotification } from "./generated/ServerNotification.js";
import type { LoginAccountParams } from "./generated/v2/LoginAccountParams.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { ChatgptAuthTokensRefreshParams } from "./generated/v2/ChatgptAuthTokensRefreshParams.js";
import type { ChatgptAuthTokensRefreshResponse } from "./generated/v2/ChatgptAuthTokensRefreshResponse.js";
import type { Personality } from "./generated/Personality.js";
import type { TurnCompletedNotification } from "./generated/v2/TurnCompletedNotification.js";
import type { ItemCompletedNotification } from "./generated/v2/ItemCompletedNotification.js";
import type { ItemStartedNotification } from "./generated/v2/ItemStartedNotification.js";
import type { ErrorNotification } from "./generated/v2/ErrorNotification.js";

type PendingRequest<T = unknown> = {
  resolve: (result: T) => void;
  reject: (error: Error) => void;
};

type AppServerEvent = Extract<ServerNotification, {
  method: "error" | "item/started" | "item/completed" | "turn/completed";
}>;

export type { AppServerEvent };

const REFRESH_AUTH_METHOD = "account/chatgptAuthTokens/refresh";
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL_ERROR = -32603;

const ignoredNotificationMethods = new Set([
  "account/rateLimits/updated",
  // Sandy treats item completion as the only host-visible source of
  // assistant message text and ignores intermediate delta notifications.
  "item/agentMessage/delta",
  "mcpServer/startupStatus/updated",
  "skills/changed",
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

function isJsonRpcRequestId(value: unknown): value is RequestId {
  return typeof value === "number" || typeof value === "string";
}

export type AuthRefreshCallback = (
  previousAccountId: string | null,
) => Promise<ChatgptAuthTokensRefreshResponse>;

type CreateExternalTokensClientOptions = {
  codexPath: string;
  tokens: ChatGPTExternalTokens;
  spawnImpl?: typeof spawn;
  extraSpawnArgs?: string[];
};

type CreateAmbientAuthClientOptions = {
  codexPath: string;
  spawnImpl?: typeof spawn;
  extraSpawnArgs?: string[];
};

type AppServerTypedRpcHost = {
  requestRaw: <T>(method: string, params?: unknown) => Promise<T>;
  writeJsonRpcMessage: (message: Record<string, unknown>) => void;
};

type JsonRpcSuccessResponse = {
  jsonrpc: "2.0";
  id: RequestId;
  result: unknown;
};

type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  id: RequestId;
  error: {
    code: number;
    message: string;
  };
};

type JsonRpcInitializedNotification = {
  jsonrpc: "2.0";
  method: "initialized";
  params: Record<string, never>;
};

/**
 * Thin typed wrapper around Codex app-server JSON-RPC calls.
 *
 * Derived from the Codex app-server protocol v2 schemas and documentation.
 *
 * @see {@link https://developers.openai.com/codex/app-server App Server Protocol Overview}
 * @see {@link https://developers.openai.com/codex/agent-approvals-security Agent Approvals & Security}
 * @see {@link https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2.rs Open-source protocol definitions (v2.rs)}
 */
class AppServerTypedRpc {
  constructor(private readonly host: AppServerTypedRpcHost) {}

  async initialize(params: InitializeParams): Promise<void> {
    await this.host.requestRaw<void>("initialize", params);
  }

  sendInitializedNotification(message: JsonRpcInitializedNotification): void {
    this.host.writeJsonRpcMessage(message);
  }

  /**
   * Sends the `chatgptAuthTokens` variant of the `account/login/start`
   * app-server request.  The full generated type is
   * {@link LoginAccountParams} (a discriminated union); this method
   * only ever sends the token-based variant.
   */
  async loginWithTokens(params: Extract<LoginAccountParams, { type: "chatgptAuthTokens" }>): Promise<void> {
    await this.host.requestRaw<void>("account/login/start", params);
  }

  async startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return await this.host.requestRaw<ThreadStartResponse>("thread/start", params);
  }

  /**
   * Starts a turn.  Accepts the core fields of the app-server
   * {@link TurnStartParams} but uses `Input` from `@openai/codex-sdk`
   * instead of the generated `UserInput` array because Sandy
   * callers already produce `Input` objects (which are compatible
   * at runtime).
   */
  async turnStart(params: Omit<TurnStartParams, "input"> & { input: Input }): Promise<TurnStartResponse> {
    return await this.host.requestRaw<TurnStartResponse>("turn/start", params);
  }

  async turnInterrupt(params: TurnInterruptParams): Promise<void> {
    await this.host.requestRaw<void>("turn/interrupt", params);
  }

  respondAuthRefresh(message: JsonRpcSuccessResponse): void {
    this.host.writeJsonRpcMessage(message);
  }

  respondMethodNotFound(message: JsonRpcErrorResponse): void {
    this.host.writeJsonRpcMessage(message);
  }
}

export type AppServerThreadProfile = {
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  cwd: string;
  personality?: Personality;
};

function buildAppServerThreadStartParams(
  profile: AppServerThreadProfile,
  model?: string,
): ThreadStartParams {
  return {
    ...(model ? { model } : {}),
    cwd: profile.cwd,
    approvalPolicy: "never",
    // Docker (or the host OS for the main agent) is the actual isolation
    // boundary; avoid nested bwrap sandboxing in-container.
    sandbox: profile.sandbox,
    personality: profile.personality ?? "none",
  };
}

export function createMainAgentProfile(workingDirectory: string): AppServerThreadProfile {
  return {
    sandbox: "read-only",
    cwd: workingDirectory,
    personality: "none",
  };
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private activeNotificationHandler: ((method: string, params: unknown) => void) | null = null;
  private activeAuthRefreshHandler: ((id: RequestId, previousAccountId: string | null) => Promise<void>) | null = null;
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
    private readonly extraSpawnArgs: string[] = [],
  ) {
    this.rpc = new AppServerTypedRpc(this);
  }

  static async createWithExternalTokens(options: CreateExternalTokensClientOptions): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(options.codexPath, options.spawnImpl, options.extraSpawnArgs);
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
    const client = new CodexAppServerClient(options.codexPath, options.spawnImpl, options.extraSpawnArgs);
    await client.initialize(false);
    client.loggedIn = true;
    return client;
  }

  start(): void {
    if (this.child) return;

    this.child = this.spawnImpl(this.codexPath, ["app-server", "--listen", "stdio://", ...this.extraSpawnArgs], {
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
    if (isJsonRpcRequestId(msg["id"]) && typeof msg["method"] === "string") {
      this.processServerRequest(msg["id"], msg["method"], msg["params"]);
      return;
    }

    // JSON-RPC notification from server to client
    if (typeof msg["method"] === "string" && msg["id"] === undefined) {
      this.processNotification(msg["method"], msg["params"]);
      return;
    }
  }

  private processServerRequest(id: RequestId, method: string, params: unknown): void {
    if (method !== REFRESH_AUTH_METHOD) {
      this.warnUnhandledServerRequest(method, params);
      this.rpc.respondMethodNotFound({
        jsonrpc: "2.0",
        id,
        error: {
          code: JSON_RPC_METHOD_NOT_FOUND,
          message: `Method not found: ${method}`,
        },
      });
      return;
    }

    const typedParams = (params ?? {}) as ChatgptAuthTokensRefreshParams;
    const parsed = refreshAuthParamsSchema.safeParse(typedParams);
    if (this.activeAuthRefreshHandler) {
      this.activeAuthRefreshHandler(id, parsed.success ? parsed.data.previousAccountId ?? null : null)
        .catch((error: Error) => {
          logger.error("appserver.auth_refresh_failed", error, "Auth refresh failed.");
          this.writeJsonRpcMessage({
            jsonrpc: "2.0",
            id,
            error: {
              code: JSON_RPC_INTERNAL_ERROR,
              message: `Auth refresh failed: ${error.message}`,
            },
          });
        });
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
    await this.rpc.initialize({
      clientInfo: {
        name: "sandy_worker",
        title: "Sandy Worker",
        version: "1.0.0",
      },
      capabilities: enableExperimentalApi
        ? {
            experimentalApi: true,
            requestAttestation: false,
          }
        : null,
    } satisfies InitializeParams);
    this.rpc.sendInitializedNotification({
      jsonrpc: "2.0",
      method: "initialized",
      params: {},
    });
    this.initialized = true;
  }

  async loginWithTokens(tokens: ChatGPTExternalTokens): Promise<void> {
    this.ensureStarted("loginWithTokens");
    await this.rpc.loginWithTokens({
      type: "chatgptAuthTokens",
      accessToken: tokens.accessToken,
      chatgptAccountId: tokens.chatgptAccountId,
      chatgptPlanType: tokens.chatgptPlanType,
    });
    this.loggedIn = true;
  }

  async startThread(profile: AppServerThreadProfile, model?: string): Promise<string> {
    this.ensureReady("startThread");
    const result = await this.rpc.startThread(buildAppServerThreadStartParams(profile, model));
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
      const event = this.parseNotification(method, params as Record<string, unknown> | undefined);
      if (event) {
        pushEvent(event);
      }
    };

    this.activeAuthRefreshHandler = async (id: RequestId, previousAccountId: string | null) => {
      const tokens = await onAuthRefresh(previousAccountId);
      this.rpc.respondAuthRefresh({
        jsonrpc: "2.0",
        id,
        result: {
          accessToken: tokens.accessToken,
          chatgptAccountId: tokens.chatgptAccountId,
          chatgptPlanType: tokens.chatgptPlanType,
        } satisfies ChatgptAuthTokensRefreshResponse,
      });
    };

    const turnStartResponse = await this.rpc.turnStart({ threadId, input });

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
            await this.rpc.turnInterrupt({ threadId, turnId: turnStartResponse.turn.id });
          } catch {
            // best effort
          }
          return;
        }

        if (event.method === "turn/completed" || event.method === "error") {
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

  private parseNotification(method: string, params: Record<string, unknown> | undefined): AppServerEvent | null {
    switch (method) {
      case "turn/completed": {
        return { method, params: (params ?? {}) as TurnCompletedNotification };
      }
      case "error": {
        return { method, params: (params ?? {}) as ErrorNotification };
      }
      case "item/started": {
        return { method, params: (params ?? {}) as ItemStartedNotification };
      }
      case "item/completed": {
        const notification = (params ?? {}) as ItemCompletedNotification;
        const item = notification.item;
        if (!item) {
          return null;
        }
        if (item.type === "agentMessage" || item.type === "contextCompaction") {
          return { method, params: notification };
        }
        if (ignoredCompletedItemTypes.has(item.type)) {
          return null;
        }
        this.warnUnhandledCompletedItemType(item.type);
        return { method, params: notification };
      }
      default:
        if (!ignoredNotificationMethods.has(method)) {
          this.warnUnhandledNotification(method, params);
        }
        return null;
    }
  }

  private warnUnhandledCompletedItemType(itemType: string): void {
    if (this.warnedUnhandledCompletedItemTypes.has(itemType)) {
      return;
    }
    this.warnedUnhandledCompletedItemTypes.add(itemType);
    logger.warn("appserver.item_completed_unhandled", {
      itemType,
    });
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
