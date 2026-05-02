import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ChatGPTExternalTokens } from "../types.js";

type PendingRequest<T = unknown> = {
  resolve: (result: T) => void;
  reject: (error: Error) => void;
};

type AppServerEvent =
  | { type: "agent_message"; text: string }
  | { type: "turn_completed" }
  | { type: "turn_failed"; error: string }
  | { type: "error"; message: string };

const REFRESH_AUTH_METHOD = "account/chatgptAuthTokens/refresh";

type AuthRefreshCallback = (
  previousAccountId: string | null,
) => Promise<{ accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null }>;

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private initialized = false;
  private loggedIn = false;

  constructor(private readonly codexPath: string) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(): Promise<void> {
    if (this.child) return;

    this.child = spawn(this.codexPath, ["app-server", "--listen", "stdio://"], {
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
      const p = params as { reason: string; previousAccountId: string | null } | undefined;
      if (this.activeAuthRefreshHandler) {
        void this.activeAuthRefreshHandler(id, p?.["previousAccountId"] as string | null ?? null);
      }
    } else {
      this.sendErrorResponse(id, -32601, `Method not found: ${method}`);
    }
  }

  private processNotification(method: string, params: unknown): void {
    if (this.activeNotificationHandler) {
      this.activeNotificationHandler(method, params);
    }
  }

  private activeNotificationHandler: ((method: string, params: unknown) => void) | null = null;
  private activeAuthRefreshHandler: ((id: number, previousAccountId: string | null) => Promise<void>) | null = null;

  private sendRequest(method: string, params?: unknown): number {
    if (!this.child) throw new Error("App-server not started");
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, id, params }) + "\n");
    return id;
  }

  private sendResponse(id: number, result: unknown): void {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  private sendErrorResponse(id: number, code: number, message: string): void {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
  }

  private async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.sendRequest(method, params);
    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
      });
    });
  }

  async initialize(): Promise<void> {
    await this.start();
    await this.request<void>("initialize", {
      clientInfo: {
        name: "sandy_worker",
        title: "Sandy Worker",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    if (this.child) {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
    }
    this.initialized = true;
  }

  async loginWithTokens(tokens: ChatGPTExternalTokens): Promise<void> {
    this.ensureStarted("loginWithTokens");
    await this.request("account/login/start", {
      type: "chatgptAuthTokens",
      accessToken: tokens.accessToken,
      chatgptAccountId: tokens.chatgptAccountId,
      chatgptPlanType: tokens.chatgptPlanType,
    });
    this.loggedIn = true;
  }

  async startThread(model?: string): Promise<string> {
    this.ensureReady("startThread");
    const result = await this.request<{ thread: { id: string } }>("thread/start", {
      ...(model ? { model } : {}),
      cwd: "/workspace/share",
      approvalPolicy: "never",
      sandbox: "dangerFullAccess",
      personality: "none",
    });
    return result.thread.id;
  }

  async *streamTurn(
    threadId: string,
    inputText: string,
    onAuthRefresh: AuthRefreshCallback,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<AppServerEvent> {
    this.ensureReady("streamTurn");

    await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text: inputText }],
    });

    let done = false;
    while (!done) {
      const event: AppServerEvent | null = await new Promise((resolve, reject) => {
        const abortListener = () => resolve(null);
        if (abortSignal) {
          abortSignal.addEventListener("abort", abortListener, { once: true });
        }

        this.activeNotificationHandler = (method: string, params: unknown) => {
          if (abortSignal) {
            abortSignal.removeEventListener("abort", abortListener);
          }
          try {
            resolve(this.parseNotification(method, params as Record<string, unknown> | undefined));
          } catch (err) {
            reject(err instanceof Error ? err : new Error("Notification parse error"));
          }
        };

        this.activeAuthRefreshHandler = async (id: number, previousAccountId: string | null) => {
          if (abortSignal) {
            abortSignal.removeEventListener("abort", abortListener);
          }
          try {
            const tokens = await onAuthRefresh(previousAccountId);
            this.sendResponse(id, {
              accessToken: tokens.accessToken,
              chatgptAccountId: tokens.chatgptAccountId,
              chatgptPlanType: tokens.chatgptPlanType,
            });
            this.activeNotificationHandler = (method: string, params: unknown) => {
              if (abortSignal) {
                abortSignal.removeEventListener("abort", abortListener);
              }
              try {
                resolve(this.parseNotification(method, params as Record<string, unknown> | undefined));
              } catch (err) {
                reject(err instanceof Error ? err : new Error("Notification parse error"));
              }
            };
            this.activeAuthRefreshHandler = async (refreshId: number, prevAccountId: string | null) => {
              const refreshedTokens = await onAuthRefresh(prevAccountId);
              this.sendResponse(refreshId, {
                accessToken: refreshedTokens.accessToken,
                chatgptAccountId: refreshedTokens.chatgptAccountId,
                chatgptPlanType: refreshedTokens.chatgptPlanType,
              });
            };
          } catch (err) {
            reject(err instanceof Error ? err : new Error("Auth refresh failed"));
          }
        };
      });

      if (!event) {
        try {
          await this.request("turn/interrupt", { threadId });
        } catch {
          // best effort
        }
        return;
      }

      if (event.type === "turn_completed" || event.type === "turn_failed" || event.type === "error") {
        done = true;
        yield event;
      } else {
        yield event;
      }
    }
  }

  private parseNotification(method: string, p: Record<string, unknown> | undefined): AppServerEvent {
    switch (method) {
      case "turn/completed":
        return { type: "turn_completed" };

      case "turn/failed": {
        const errorObj = p?.["error"] as { message?: string } | undefined;
        return { type: "turn_failed", error: errorObj?.["message"] ?? "Unknown turn failure." };
      }

      case "error":
        return {
          type: "error",
          message: typeof p?.["message"] === "string" ? p["message"] : "Unknown app-server error.",
        };

      case "item/completed": {
        const item = p?.["item"] as Record<string, unknown> | undefined;
        if (item?.["type"] === "agent_message" && typeof item["text"] === "string") {
          return { type: "agent_message", text: item["text"] };
        }
        return { type: "turn_completed" };
      }

      default:
        return { type: "turn_completed" };
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
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
      throw new Error(`${method}: app-server not logged in. Call loginWithTokens() first.`);
    }
  }
}
