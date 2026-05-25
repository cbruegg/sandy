import { logger } from "../logger.js";
import type { ChatGPTExternalTokens, SubAgentEvent } from "../types.js";
import { CodexAppServerClient } from "./app-server-client.js";
import { writeSubAgentEvent } from "./subagent-event-writer.js";
import { buildTaskSummaryInput } from "./worker-prompt.js";

type StreamTurnResult = {
  sawTerminalError: boolean;
  summaryText: string | null;
};

type AppServerTurnStreamer = Pick<CodexAppServerClient, "streamTurn">;

type AuthRefreshCallback = (
  previousAccountId: string | null,
) => Promise<{ accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null }>;

type AppServerSessionAuthMode =
  | { kind: "ambient" }
  | { kind: "external_tokens"; initialTokens: ChatGPTExternalTokens };

type StreamAppServerTaskTurnOptions = {
  appServer: AppServerTurnStreamer;
  threadId: string;
  input: string;
  onAuthRefresh: AuthRefreshCallback;
  abortSignal?: AbortSignal;
  sendEvent?: (event: SubAgentEvent) => void;
};

type StreamAppServerSummaryOptions = {
  appServer: AppServerTurnStreamer;
  threadId: string;
  input: string;
  onAuthRefresh: AuthRefreshCallback;
  abortSignal?: AbortSignal;
};

function normalizeSummaryText(chunks: string[]): string | null {
  const summary = chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0).join("\n\n").trim();
  return summary.length > 0 ? summary : null;
}

/**
 * Streams one ongoing app-server task turn.
 *
 * Use this for normal live conversation turns while the sub-agent is actively
 * working through the task in the current thread. Completed assistant messages
 * are the only host-visible output path for app-server-backed turns.
 */
export async function streamAppServerTurn(options: StreamAppServerTaskTurnOptions): Promise<boolean> {
  const sendEvent = options.sendEvent ?? writeSubAgentEvent;
  let sawTerminalError = false;

  try {
    for await (const event of options.appServer.streamTurn(
      options.threadId,
      options.input,
      options.onAuthRefresh,
      options.abortSignal,
    )) {
      logger.debug("appserver.event_received", { eventType: event.type, event });

      switch (event.type) {
        case "agent_message_completed":
          if (event.text.trim()) {
            sendEvent({ type: "assistant_output", text: event.text });
          }
          break;

        case "turn_completed":
          break;

        case "turn_failed":
          sendEvent({ type: "task_error", message: event.error });
          sawTerminalError = true;
          return sawTerminalError;

        case "error":
          sendEvent({ type: "task_error", message: event.message });
          sawTerminalError = true;
          return sawTerminalError;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "App-server turn failed.";
    sendEvent({ type: "task_error", message });
    sawTerminalError = true;
  }

  return sawTerminalError;
}

/**
 * Streams the final host-facing summary request for a completed thread.
 *
 * Use this only after task completion when asking the sub-agent to summarize
 * the whole conversation/thread for the final handoff.
 */
async function streamAppServerSummary(options: StreamAppServerSummaryOptions): Promise<StreamTurnResult> {
  const summaryChunks: string[] = [];
  let sawTerminalError = false;

  try {
    for await (const event of options.appServer.streamTurn(
      options.threadId,
      options.input,
      options.onAuthRefresh,
      options.abortSignal,
    )) {
      logger.debug("appserver.event_received", { eventType: event.type, event });

      switch (event.type) {
        case "agent_message_completed":
          if (event.text.trim()) {
            summaryChunks.push(event.text);
          }
          break;

        case "turn_completed":
          break;

        case "turn_failed":
          sawTerminalError = true;
          return { sawTerminalError, summaryText: null };

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

  constructor(
    private readonly appServer: Pick<CodexAppServerClient, "streamTurn" | "close">,
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
    const threadId = await appServer.startThread(options.model);
    const session = new AppServerWorkerSession(
      appServer,
      threadId,
      options.sendEvent,
      options.authMode.kind === "external_tokens",
    );
    return session;
  }

  handleAuthRefreshResult(tokens: ChatGPTExternalTokens | null): void {
    const resolve = this.pendingAuthRefreshResolver;
    if (!resolve) {
      return;
    }
    this.pendingAuthRefreshResolver = null;
    resolve(tokens);
  }

  cancelPendingAuthRefresh(): void {
    this.handleAuthRefreshResult(null);
  }

  async streamTurn(inputText: string, abortSignal?: AbortSignal): Promise<boolean> {
    return streamAppServerTurn({
      appServer: this.appServer,
      threadId: this.threadId,
      input: inputText,
      onAuthRefresh: async (previousAccountId) => await this.requestAuthRefresh(previousAccountId),
      abortSignal,
      sendEvent: this.sendEvent,
    });
  }

  async emitTaskSummary(): Promise<void> {
    const result = await streamAppServerSummary({
      appServer: this.appServer,
      threadId: this.threadId,
      input: buildTaskSummaryInput(),
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
      throw new Error("Auth refresh failed: host did not provide new tokens.");
    }

    return {
      accessToken: tokens.accessToken,
      chatgptAccountId: tokens.chatgptAccountId,
      chatgptPlanType: tokens.chatgptPlanType,
    };
  }
}
