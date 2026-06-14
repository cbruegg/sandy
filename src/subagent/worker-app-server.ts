import { logger } from "../logger.js";
import type { Input } from "@openai/codex-sdk";
import type { ChatGPTExternalTokens, SubAgentEvent } from "../types.js";
import { CodexAppServerClient, denyAllServerRequests } from "../codex-app-server-client/app-server-client.js";
import { writeSubAgentEvent } from "./subagent-event-writer.js";
import { buildTaskSummaryInput } from "./worker-prompt.js";
import { sharedWorkspaceMountPath } from "../shared-workspace.ts";
import type {ThreadStartParams} from "../codex-app-server-client/generated/v2";
import { messages } from "../messages.js";
import type { TurnError } from "../codex-app-server-client/generated/v2/TurnError.js";

const WORKER_PROFILE: ThreadStartParams = {
  sandbox: "danger-full-access" as const,
  cwd: sharedWorkspaceMountPath,
  personality: "none" as const,
};

function buildTextInput(text: string): Input {
  return text.trim() ? [{ type: "text", text: text.trim() }] : [];
}

export type StreamTurnResult = {
  sawTerminalError: boolean;
};

type StreamAppServerSummaryResult = StreamTurnResult & {
  summaryText: string | null;
};

type ConsumeAuthRefreshFailureMessage = () => string | null;

type AppServerTurnStreamer = Pick<CodexAppServerClient, "streamTurn" | "steerActiveTurn">;

type AuthRefreshCallback = (
  previousAccountId: string | null,
) => Promise<{ accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null }>;

type AppServerSessionAuthMode =
  | { kind: "ambient" }
  | { kind: "external_tokens"; initialTokens: ChatGPTExternalTokens };

type StreamAppServerTaskTurnOptions = {
  appServer: AppServerTurnStreamer;
  threadId: string;
  input: Input;
  onAuthRefresh: AuthRefreshCallback;
  consumeAuthRefreshFailureMessage?: ConsumeAuthRefreshFailureMessage;
  abortSignal?: AbortSignal;
  sendEvent?: (event: SubAgentEvent) => void;
};

type StreamAppServerSummaryOptions = {
  appServer: AppServerTurnStreamer;
  threadId: string;
  input: Input;
  onAuthRefresh: AuthRefreshCallback;
  abortSignal?: AbortSignal;
};

function normalizeSummaryText(chunks: string[]): string | null {
  const summary = chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0).join("\n\n").trim();
  return summary.length > 0 ? summary : null;
}

function isUnauthorizedStreamError(error: TurnError): boolean {
  if (error.codexErrorInfo === "unauthorized") {
    return true;
  }
  if (typeof error.codexErrorInfo !== "object" || error.codexErrorInfo === null) {
    return false;
  }

  if ("responseStreamDisconnected" in error.codexErrorInfo) {
    return error.codexErrorInfo.responseStreamDisconnected.httpStatusCode === 401;
  }
  if ("responseStreamConnectionFailed" in error.codexErrorInfo) {
    return error.codexErrorInfo.responseStreamConnectionFailed.httpStatusCode === 401;
  }
  if ("responseTooManyFailedAttempts" in error.codexErrorInfo) {
    return error.codexErrorInfo.responseTooManyFailedAttempts.httpStatusCode === 401;
  }
  return false;
}

function resolveTaskErrorMessage(
  error: TurnError,
  consumeAuthRefreshFailureMessage?: ConsumeAuthRefreshFailureMessage,
): string {
  const authRefreshFailureMessage = consumeAuthRefreshFailureMessage?.() ?? null;
  if (authRefreshFailureMessage && isUnauthorizedStreamError(error)) {
    return authRefreshFailureMessage;
  }
  return error.message || "Unknown app-server error.";
}

/**
 * Streams one ongoing app-server task turn.
 *
 * Use this for normal live conversation turns while the sub-agent is actively
 * working through the task in the current thread. Completed assistant messages
 * are the only host-visible output path for app-server-backed turns.
 */
export async function streamAppServerTurn(options: StreamAppServerTaskTurnOptions): Promise<StreamTurnResult> {
  const sendEvent = options.sendEvent ?? writeSubAgentEvent;
  let sawTerminalError = false;

  try {
    for await (const event of options.appServer.streamTurn(
      options.threadId,
      options.input,
      options.onAuthRefresh,
      options.abortSignal,
      (req) => Promise.resolve(denyAllServerRequests(req)),
    )) {
      logger.debug("appserver.event_received", { eventType: event.method, event });

      switch (event.method) {
        case "item/completed":
          if (event.params.item.type === "agentMessage" && event.params.item.text.trim()) {
            sendEvent({ type: "assistant_output", text: event.params.item.text });
          }
          break;

        case "item/started":
          break;

        case "turn/completed":
          if (event.params.turn?.status === "failed") {
            const turnError = event.params.turn.error;
            sendEvent({
              type: "task_error",
              message: turnError
                ? resolveTaskErrorMessage(turnError, options.consumeAuthRefreshFailureMessage)
                : "Unknown turn failure.",
            });
            sawTerminalError = true;
            return { sawTerminalError };
          }
          break;

        case "error": {
          const error = event.params.error;
          sendEvent({
            type: "task_error",
            message: error
              ? resolveTaskErrorMessage(error, options.consumeAuthRefreshFailureMessage)
              : "Unknown app-server error.",
          });
          sawTerminalError = true;
          return { sawTerminalError };
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "App-server turn failed.";
    sendEvent({ type: "task_error", message });
    sawTerminalError = true;
  }

  return { sawTerminalError };
}

/**
 * Streams the final host-facing summary request for a completed thread.
 *
 * Use this only after task completion when asking the sub-agent to summarize
 * the whole conversation/thread for the final handoff.
 */
async function streamAppServerSummary(options: StreamAppServerSummaryOptions): Promise<StreamAppServerSummaryResult> {
  const summaryChunks: string[] = [];
  let sawTerminalError = false;

  try {
    for await (const event of options.appServer.streamTurn(
      options.threadId,
      options.input,
      options.onAuthRefresh,
      options.abortSignal,
      (req) => Promise.resolve(denyAllServerRequests(req)),
    )) {
      logger.debug("appserver.event_received", { eventType: event.method, event });

      switch (event.method) {
        case "item/completed":
          if (event.params.item.type === "agentMessage" && event.params.item.text.trim()) {
            summaryChunks.push(event.params.item.text);
          }
          break;

        case "item/started":
          break;

        case "turn/completed":
          if (event.params.turn?.status === "failed") {
            sawTerminalError = true;
            return { sawTerminalError, summaryText: null };
          }
          break;

        case "error":
          sawTerminalError = true;
          return { sawTerminalError, summaryText: null };
      }
    }
  } catch {
    sawTerminalError = true;
  }

  return {
    sawTerminalError,
    summaryText: normalizeSummaryText(summaryChunks),
  };
}

export class AppServerWorkerSession {
  private pendingAuthRefreshResolver: ((tokens: ChatGPTExternalTokens | null) => void) | null = null;
  private authRefreshFailureMessage: string | null = null;

  constructor(
    private readonly appServer: Pick<CodexAppServerClient, "streamTurn" | "steerActiveTurn" | "close">,
    private readonly threadId: string,
    private readonly sendEvent: (event: SubAgentEvent) => void,
    private readonly supportsAuthRefresh: boolean = true,
  ) {}

  static async start(options: {
    codexPath: string;
    authMode: AppServerSessionAuthMode;
    model?: string;
    sendEvent: (event: SubAgentEvent) => void;
  }): Promise<AppServerWorkerSession> {
    const appServer = options.authMode.kind === "external_tokens"
      ? await CodexAppServerClient.createWithExternalTokens({
        codexPath: options.codexPath,
        tokens: options.authMode.initialTokens,
      })
      : await CodexAppServerClient.createWithAmbientAuth({
        codexPath: options.codexPath,
      });
    const profile = {
      ...WORKER_PROFILE,
      ...(options.model ? { model: options.model } : {}),
    };
    const threadId = await appServer.startThread(profile);
    const session = new AppServerWorkerSession(
      appServer,
      threadId,
      options.sendEvent,
      options.authMode.kind === "external_tokens",
    );
    return session;
  }

  handleAuthRefreshResult(tokens: ChatGPTExternalTokens | null): void {
    this.resolvePendingAuthRefresh(tokens, tokens ? null : messages.chatgptAuthRefreshFailed());
  }

  cancelPendingAuthRefresh(): void {
    this.resolvePendingAuthRefresh(null, null);
  }

  async streamTurn(input: Input, abortSignal?: AbortSignal): Promise<StreamTurnResult> {
    return streamAppServerTurn({
      appServer: this.appServer,
      threadId: this.threadId,
      input,
      onAuthRefresh: async (previousAccountId) => await this.requestAuthRefresh(previousAccountId),
      consumeAuthRefreshFailureMessage: () => this.consumeAuthRefreshFailureMessage(),
      abortSignal,
      sendEvent: this.sendEvent,
    });
  }

  async steerActiveTurn(input: Input): Promise<boolean> {
    return await this.appServer.steerActiveTurn(this.threadId, input);
  }

  async emitTaskSummary(): Promise<void> {
    const result = await streamAppServerSummary({
      appServer: this.appServer,
      threadId: this.threadId,
      input: buildTextInput(buildTaskSummaryInput()),
      onAuthRefresh: async (previousAccountId) => await this.requestAuthRefresh(previousAccountId),
    });
    if (result.sawTerminalError || !result.summaryText) {
      return;
    }

    this.sendEvent({
      type: "task_summary",
      summary: result.summaryText,
    });
  }

  close(): void {
    this.cancelPendingAuthRefresh();
    this.appServer.close();
  }

  private async requestAuthRefresh(previousAccountId: string | null): Promise<{
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType: string | null;
  }> {
    if (!this.supportsAuthRefresh) {
      throw new Error("App-server requested auth refresh for non-external auth mode.");
    }

    if (this.pendingAuthRefreshResolver) {
      throw new Error("Auth refresh already in progress.");
    }

    const tokensPromise = new Promise<ChatGPTExternalTokens | null>((resolve) => {
      this.pendingAuthRefreshResolver = resolve;
    });

    try {
      this.sendEvent({
        type: "chatgpt_auth_refresh_request",
        previousAccountId,
      });
    } catch (error) {
      this.pendingAuthRefreshResolver = null;
      throw error;
    }

    const tokens = await tokensPromise;
    if (!tokens) {
      throw new Error(messages.chatgptAuthRefreshFailed());
    }

    return {
      accessToken: tokens.accessToken,
      chatgptAccountId: tokens.chatgptAccountId,
      chatgptPlanType: tokens.chatgptPlanType,
    };
  }

  private consumeAuthRefreshFailureMessage(): string | null {
    const message = this.authRefreshFailureMessage;
    this.authRefreshFailureMessage = null;
    return message;
  }

  private resolvePendingAuthRefresh(tokens: ChatGPTExternalTokens | null, failureMessage: string | null): void {
    const resolve = this.pendingAuthRefreshResolver;
    if (!resolve) {
      return;
    }
    this.pendingAuthRefreshResolver = null;
    this.authRefreshFailureMessage = failureMessage;
    resolve(tokens);
  }
}
