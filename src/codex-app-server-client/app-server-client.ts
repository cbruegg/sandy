import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Input } from "@openai/codex-sdk";
import type { ChatGPTExternalTokens } from "../types.js";
import { logger } from "../logger.js";
import type { InitializeParams } from "./generated/InitializeParams.js";
import type { RequestId } from "./generated/RequestId.js";
import type { ServerNotification } from "./generated/ServerNotification.js";
import type { ServerRequest } from "./generated/ServerRequest.js";
import type { LoginAccountParams } from "./generated/v2/LoginAccountParams.js";
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.js";
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.js";
import type { TurnStartParams } from "./generated/v2/TurnStartParams.js";
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.js";
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.js";
import type { TurnSteerResponse } from "./generated/v2/TurnSteerResponse.js";
import type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams.js";
import type { ChatgptAuthTokensRefreshResponse } from "./generated/v2/ChatgptAuthTokensRefreshResponse.js";

type AppServerInput = Array<
  | { type: "text"; text: string }
  | { type: "localImage"; path: string }
>;

type PendingRequest<T = unknown> = {
  resolve: (result: T) => void;
  reject: (error: Error) => void;
};

type JsonRpcResponse = {
  id: RequestId;
  result?: unknown;
  error?: JsonRpcErrorPayload;
};

type JsonRpcErrorPayload = {
  code: number;
  message: string;
};

type AppServerMessage = JsonRpcResponse | ServerRequest | ServerNotification;

export type AppServerEvent = Extract<ServerNotification, {
  method: "error" | "item/started" | "item/completed" | "turn/completed";
}>;

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL_ERROR = -32603;

const ignoredNotificationMethods = new Set([
  "account/rateLimits/updated",
  // Sandy treats item completion as the only host-visible source of
  // assistant message text and ignores intermediate delta notifications.
  "item/agentMessage/delta",
  "mcpServer/startupStatus/updated",
  // Fired after an elicitation/approval request is resolved by the client.
  "serverRequest/resolved",
  "skills/changed",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/started",
]);

export type AuthRefreshCallback = (
  previousAccountId: string | null,
) => Promise<ChatgptAuthTokensRefreshResponse>;

/**
 * Callback invoked for every JSON-RPC server request during a turn
 * (excluding auth refresh, which is handled separately).
 *
 * Return a JSON-RPC `result` object to send a success response, or
 * `null` to have the client respond with method-not-found.
 */
export type ServerRequestHandler = (
  request: ServerRequest,
) => Promise<Record<string, unknown> | null>;

type CreateExternalTokensClientOptions = {
  codexPath: string;
  tokens: ChatGPTExternalTokens;
  spawnImpl?: typeof spawn;
};

type CreateAmbientAuthClientOptions = {
  codexPath: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
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

type ActiveTurn = {
  threadId: string;
  turnId: string;
};

class JsonRpcRequestError extends Error {
  constructor(
    readonly code: number,
    readonly rpcMessage: string,
  ) {
    super(`RPC error ${code}: ${rpcMessage}`);
    this.name = "JsonRpcRequestError";
  }
}

function isInvalidSteerError(error: unknown): boolean {
  if (error instanceof JsonRpcRequestError && error.code === -32600) {
    logger.info("codex.turn_steer_rejected", { code: error.code, message: error.rpcMessage });
    return true;
  }
  return false;
}

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
  async turnStart(params: Omit<TurnStartParams, "input"> & { input: AppServerInput }): Promise<TurnStartResponse> {
    return await this.host.requestRaw<TurnStartResponse>("turn/start", params);
  }

  async turnSteer(params: Omit<TurnSteerParams, "input"> & { input: AppServerInput }): Promise<TurnSteerResponse> {
    return await this.host.requestRaw<TurnSteerResponse>("turn/steer", params);
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

function normalizeInputForAppServer(input: Input): AppServerInput {
  if (typeof input === "string") {
    return input.trim() ? [{ type: "text", text: input }] : [];
  }

  return input.map((item) => {
    switch (item.type) {
      case "text":
        return { type: "text", text: item.text };
      case "local_image":
        return { type: "localImage", path: item.path };
    }
  });
}

function buildAppServerThreadStartParams(
  profile: ThreadStartParams,
): ThreadStartParams {
  return {
    ...profile,
    approvalPolicy: profile.approvalPolicy ?? "never",
    personality: profile.personality ?? "none",
  };
}

/**
 * Default server-request handler that denies/declines every known
 * request type and returns null (method-not-found) for unknown types.
 *
 * Callers can wrap this with their own logic to selectively accept
 * specific requests (e.g. accept MCP elicitation for MemPalace).
 */
export function denyAllServerRequests(
  request: ServerRequest,
): Record<string, unknown> | null {
  switch (request.method) {
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null, _meta: null };
    case "item/commandExecution/requestApproval":
      return { decision: "decline" };
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "applyPatchApproval":
      return { decision: "denied" };
    case "execCommandApproval":
      return { decision: "denied" };
    default:
      return null;
  }
}

export interface AgentClient {
  startThread(profile: ThreadStartParams): Promise<string>;
  streamTurn(
    threadId: string,
    input: Input,
    onAuthRefresh: AuthRefreshCallback,
    abortSignal?: AbortSignal,
    onServerRequest?: ServerRequestHandler,
  ): AsyncGenerator<AppServerEvent>;
}

export class CodexAppServerClient implements AgentClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private activeNotificationHandler: ((notification: ServerNotification) => void) | null = null;
  private activeAuthRefreshHandler: ((id: RequestId, previousAccountId: string | null) => Promise<void>) | null = null;
  private activeServerRequestHandler: ServerRequestHandler | null = null;
  private activeTurn: ActiveTurn | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private initialized = false;
  private loggedIn = false;
  private readonly warnedUnhandledNotificationMethods = new Set<string>();
  private readonly warnedUnhandledServerRequestMethods = new Set<string>();
  private readonly rpc: AppServerTypedRpc;

  private constructor(
    private readonly codexPath: string,
    private readonly env: NodeJS.ProcessEnv | undefined,
    private readonly spawnImpl: typeof spawn = spawn,
  ) {
    this.rpc = new AppServerTypedRpc(this);
  }

  static async createWithExternalTokens(options: CreateExternalTokensClientOptions): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(options.codexPath, undefined, options.spawnImpl);
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
    const client = new CodexAppServerClient(options.codexPath, options.env, options.spawnImpl);
    await client.initialize(false);
    client.loggedIn = true;
    return client;
  }

  start(): void {
    if (this.child) return;

    this.child = this.spawnImpl(this.codexPath, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
    });

    const stdout = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    const stderr = createInterface({
      input: this.child.stderr,
      crlfDelay: Infinity,
    });

    stdout.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as AppServerMessage;
        this.processMessage(msg);
      } catch {
        // non-JSON line, ignore
      }
    });

    stderr.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      logger.warn("appserver.stderr", {
        line: trimmed,
      });
    });
  }

  private processMessage(msg: AppServerMessage): void {
    // JSON-RPC response to one of our requests
    if ("id" in msg && !("method" in msg)) {
      if (typeof msg.id !== "number") {
        return;
      }
      const id = msg.id;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if (msg.error !== undefined) {
          const err = msg.error;
          pending.reject(new JsonRpcRequestError(err.code, err.message));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // JSON-RPC request from server to client
    if ("id" in msg && "method" in msg) {
      void this.processServerRequest(msg).catch((err: unknown) => {
        logger.error("appserver.process_server_request_failed", err, "Unknown error processing server request");
      });
      return;
    }

    // JSON-RPC notification from server to client
    if ("method" in msg) {
      this.processNotification(msg);
      return;
    }
  }

  private async processServerRequest(request: ServerRequest): Promise<void> {
    switch (request.method) {
      case "account/chatgptAuthTokens/refresh":
        if (this.activeAuthRefreshHandler) {
          this.activeAuthRefreshHandler(request.id, request.params.previousAccountId ?? null)
            .catch((error: Error) => {
              logger.error("appserver.auth_refresh_failed", error, "Auth refresh failed.");
              this.writeJsonRpcMessage({
                jsonrpc: "2.0",
                id: request.id,
                error: {
                  code: JSON_RPC_INTERNAL_ERROR,
                  message: `Auth refresh failed: ${error.message}`,
                },
              });
            });
        }
        return;

      default: {
        let result: Record<string, unknown> | null = null;
        if (this.activeServerRequestHandler) {
          result = await this.activeServerRequestHandler(request);
        }
        if (result !== null) {
          this.writeJsonRpcMessage({
            jsonrpc: "2.0",
            id: request.id,
            result,
          });
        } else {
          this.warnUnhandledServerRequest(request.method, request.params);
          this.rpc.respondMethodNotFound({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: JSON_RPC_METHOD_NOT_FOUND,
              message: `Method not found: ${request.method}`,
            },
          });
        }
        return;
      }
    }
  }

  private processNotification(notification: ServerNotification): void {
    if (this.activeNotificationHandler) {
      this.activeNotificationHandler(notification);
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

  async startThread(profile: ThreadStartParams): Promise<string> {
    this.ensureReady("startThread");
    const result = await this.rpc.startThread(buildAppServerThreadStartParams(profile));
    return result.thread.id;
  }

  async steerActiveTurn(threadId: string, input: Input): Promise<boolean> {
    this.ensureReady("steerActiveTurn");

    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.threadId !== threadId) {
      return false;
    }

    try {
      const result = await this.rpc.turnSteer({
        threadId,
        input: normalizeInputForAppServer(input),
        expectedTurnId: activeTurn.turnId,
      });
      return result.turnId === activeTurn.turnId;
    } catch (error) {
      if (this.activeTurn !== activeTurn || isInvalidSteerError(error)) {
        return false;
      }
      throw error;
    }
  }

  async *streamTurn(
    threadId: string,
    input: Input,
    onAuthRefresh: AuthRefreshCallback,
    abortSignal?: AbortSignal,
    onServerRequest?: ServerRequestHandler,
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

    this.activeNotificationHandler = (notification: ServerNotification) => {
      const event = this.selectEvent(notification);
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

    this.activeServerRequestHandler = onServerRequest ?? null;

    const turnStartResponse = await this.rpc.turnStart({ threadId, input: normalizeInputForAppServer(input) });
    this.activeTurn = {
      threadId,
      turnId: turnStartResponse.turn.id,
    };

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
      this.activeServerRequestHandler = null;
      if (this.activeTurn?.turnId === turnStartResponse.turn.id) {
        this.activeTurn = null;
      }
    }
  }

  private selectEvent(notification: ServerNotification): AppServerEvent | null {
    switch (notification.method) {
      case "turn/completed": {
        return { method: "turn/completed", params: notification.params };
      }
      case "error": {
        return { method: "error", params: notification.params };
      }
      case "item/started": {
        return { method: "item/started", params: notification.params };
      }
      case "item/completed": {
        const itemType = notification.params.item?.type;
        if (itemType !== "agentMessage" && itemType !== "contextCompaction") {
          return null;
        }
        return { method: "item/completed", params: notification.params };
      }
      default:
        if (!ignoredNotificationMethods.has(notification.method)) {
          this.warnUnhandledNotification(notification.method, notification.params);
        }
        return null;
    }
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
    this.activeServerRequestHandler = null;
    this.activeTurn = null;
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
