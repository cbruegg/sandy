import { logger } from "../logger.js";
import type { ChatGPTExternalTokens, SubAgentEvent } from "../types.js";
import { CodexAppServerClient } from "./app-server-client.js";
import { buildTaskSummaryInput } from "./worker-prompt.js";

type TurnMode = "task" | "summary";

type StreamTurnResult = {
  sawTerminalError: boolean;
  summaryText: string | null;
};

type AppServerTurnStreamer = Pick<CodexAppServerClient, "streamTurn">;

type AuthRefreshCallback = (
  previousAccountId: string | null,
) => Promise<{ accessToken: string; chatgptAccountId: string; chatgptPlanType: string | null }>;

function send(event: SubAgentEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

class AppServerMessageBuffer {
  private emittedText = "";
  private pendingText = "";

  appendDelta(text: string): string[] {
    if (!text) {
      return [];
    }
    this.pendingText += text;
    return [];
  }

  appendCompleted(text: string): string[] {
    if (!text) {
      return this.flushAll();
    }

    const streamedText = this.emittedText + this.pendingText;
    if (!streamedText) {
      this.pendingText = text;
      return this.flushAll();
    }

    if (text.startsWith(streamedText)) {
      this.pendingText += text.slice(streamedText.length);
      return this.flushAll();
    }

    if (streamedText.startsWith(text)) {
      return this.flushAll();
    }

    this.emittedText = "";
    this.pendingText = text;
    return this.flushAll();
  }

  flushAll(): string[] {
    if (!this.pendingText) {
      return [];
    }

    const chunk = this.pendingText;
    this.emittedText += chunk;
    this.pendingText = "";
    return [chunk];
  }

  takeCompletedText(): string | null {
    const text = `${this.emittedText}${this.pendingText}`.trim();
    this.emittedText = "";
    this.pendingText = "";
    return text.length > 0 ? text : null;
  }
}

function normalizeSummaryText(chunks: string[]): string | null {
  const summary = chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0).join("\n\n").trim();
  return summary.length > 0 ? summary : null;
}

export async function* streamAppServerTurn(
  appServer: AppServerTurnStreamer,
  threadId: string,
  input: string,
  mode: TurnMode = "task",
  abortSignal?: AbortSignal,
  onAuthRefresh: AuthRefreshCallback = () => Promise.reject(
    new Error("App-server requested auth refresh without a configured handler."),
  ),
  sendEvent: (event: SubAgentEvent) => void = send,
): AsyncGenerator<{
  result: StreamTurnResult;
  events: SubAgentEvent[];
}> {
  let sawTerminalError = false;
  const summaryChunks: string[] = [];
  const messageBuffer = new AppServerMessageBuffer();

  const flushBufferedTaskOutput = () => {
    for (const chunk of messageBuffer.flushAll()) {
      if (chunk.trim()) {
        sendEvent({ type: "assistant_output", text: chunk });
      }
    }
  };

  const appendSummaryChunk = (text: string | null) => {
    if (text) {
      summaryChunks.push(text);
    }
  };

  try {
    for await (const event of appServer.streamTurn(threadId, input, onAuthRefresh, abortSignal)) {
      logger.debug("appserver.event_received", { eventType: event.type, event });

      switch (event.type) {
        case "agent_message_delta": {
          messageBuffer.appendDelta(event.text);
          break;
        }

        case "agent_message_completed": {
          if (mode === "summary") {
            messageBuffer.appendCompleted(event.text);
            appendSummaryChunk(messageBuffer.takeCompletedText());
            break;
          }

          for (const chunk of messageBuffer.appendCompleted(event.text)) {
            if (chunk.trim()) {
              sendEvent({ type: "assistant_output", text: chunk });
            }
          }
          break;
        }

        case "turn_completed":
          if (mode === "summary") {
            appendSummaryChunk(messageBuffer.takeCompletedText());
          } else {
            flushBufferedTaskOutput();
          }
          break;

        case "turn_failed":
          if (mode !== "summary") {
            flushBufferedTaskOutput();
          }
          sendEvent({ type: "task_error", message: event.error });
          sawTerminalError = true;
          yield {
            result: { sawTerminalError: true, summaryText: null },
            events: [],
          };
          return;

        case "error":
          if (mode !== "summary") {
            flushBufferedTaskOutput();
          }
          sendEvent({ type: "task_error", message: event.message });
          sawTerminalError = true;
          yield {
            result: { sawTerminalError: true, summaryText: null },
            events: [],
          };
          return;
      }
    }
  } catch (error) {
    if (mode !== "summary") {
      flushBufferedTaskOutput();
    }
    const message = error instanceof Error ? error.message : "App-server turn failed.";
    sendEvent({ type: "task_error", message });
    sawTerminalError = true;
  }

  if (mode === "summary") {
    appendSummaryChunk(messageBuffer.takeCompletedText());
  } else {
    flushBufferedTaskOutput();
  }

  yield {
    result: {
      sawTerminalError,
      summaryText: mode === "summary" ? normalizeSummaryText(summaryChunks) : null,
    },
    events: [],
  };
}

export class AppServerWorkerSession {
  private pendingAuthRefreshResolver: ((tokens: ChatGPTExternalTokens | null) => void) | null = null;

  constructor(
    private readonly appServer: Pick<CodexAppServerClient, "streamTurn" | "close">,
    private readonly threadId: string,
    private readonly sendEvent: (event: SubAgentEvent) => void,
  ) {}

  static async start(options: {
    codexPath: string;
    initialTokens: ChatGPTExternalTokens;
    model?: string;
    sendEvent: (event: SubAgentEvent) => void;
  }): Promise<AppServerWorkerSession> {
    const appServer = new CodexAppServerClient(options.codexPath);
    await appServer.initialize();
    await appServer.loginWithTokens(options.initialTokens);
    const threadId = await appServer.startThread(options.model);
    return new AppServerWorkerSession(appServer, threadId, options.sendEvent);
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

  async streamTurn(
    inputText: string,
    mode: TurnMode = "task",
    abortSignal?: AbortSignal,
  ): Promise<StreamTurnResult> {
    let finalResult: StreamTurnResult = {
      sawTerminalError: false,
      summaryText: null,
    };

    for await (const { result } of streamAppServerTurn(
      this.appServer,
      this.threadId,
      inputText,
      mode,
      abortSignal,
      async (previousAccountId) => await this.requestAuthRefresh(previousAccountId),
      this.sendEvent,
    )) {
      finalResult = result;
    }

    return finalResult;
  }

  async emitTaskSummary(): Promise<void> {
    const result = await this.streamTurn(buildTaskSummaryInput(), "summary");
    if (result.sawTerminalError || !result.summaryText) {
      return;
    }

    this.sendEvent({
      type: "task_summary",
      summary: result.summaryText,
    });
  }

  async close(): Promise<void> {
    this.cancelPendingAuthRefresh();
    await this.appServer.close();
  }

  private async requestAuthRefresh(previousAccountId: string | null): Promise<{
    accessToken: string;
    chatgptAccountId: string;
    chatgptPlanType: string | null;
  }> {
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
