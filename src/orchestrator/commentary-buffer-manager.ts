import type { ChatId } from "../types.js";
import type { TimerControls } from "./blocked-job-reminder-scheduler.js";

const COMMENTARY_FLUSH_DELAY_MS = 60_000;

type CommentaryFlushCallback = (taskId: string, chatId: ChatId, text: string) => Promise<void>;

type BufferedCommentary = {
  readonly chatId: ChatId;
  readonly lines: string[];
};

/**
 * Buffers commentary-phase assistant output per task and flushes it after a
 * configurable idle delay unless non-commentary output arrives first.
 *
 * Timers are injectable via {@link TimerControls} so tests can advance time
 * deterministically.
 */
export class CommentaryBufferManager {
  private readonly buffers = new Map<string, BufferedCommentary>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private stopped = false;

  constructor(
    private readonly onFlush: CommentaryFlushCallback,
    timerControls?: TimerControls,
  ) {
    this.setTimeoutImpl = timerControls?.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = timerControls?.clearTimeoutImpl ?? clearTimeout;
  }

  /** Append a commentary line and schedule the fallback flush timer. */
  bufferCommentary(taskId: string, chatId: ChatId, text: string): void {
    if (this.stopped) {
      return;
    }
    const buffer = this.buffers.get(taskId) ?? { chatId, lines: [] };
    buffer.lines.push(text.trim());
    this.buffers.set(taskId, buffer);
    this.scheduleFlush(taskId);
  }

  /**
   * Take and clear the buffered commentary for `taskId`, returning the combined
   * text or `null` if the buffer was empty.  Cancels any pending flush timer.
   * The caller is responsible for sending the returned text.
   */
  takeBuffer(taskId: string): string | null {
    this.clearTimer(taskId);
    const buffer = this.buffers.get(taskId);
    if (!buffer || buffer.lines.length === 0) {
      this.buffers.delete(taskId);
      return null;
    }
    this.buffers.delete(taskId);
    return buffer.lines.join("\n\n");
  }

  /** Restart the fallback timer for any buffered tasks in this chat. */
  onUserInteraction(chatId: ChatId): void {
    if (this.stopped) {
      return;
    }
    for (const [taskId, buffer] of this.buffers) {
      if (buffer.chatId === chatId) {
        this.scheduleFlush(taskId);
      }
    }
  }

  /** Cancel timers and discard buffers for `taskId`. */
  clear(taskId: string): void {
    this.clearTimer(taskId);
    this.buffers.delete(taskId);
  }

  /** Cancel all timers and discard all buffers. */
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) {
      this.clearTimeoutImpl(timer);
    }
    this.timers.clear();
    this.buffers.clear();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private scheduleFlush(taskId: string): void {
    const buffer = this.buffers.get(taskId);
    if (!buffer) {
      return;
    }
    this.clearTimer(taskId);
    const timeout = this.setTimeoutImpl(() => {
      void this.flushOnTimeout(taskId, buffer.chatId);
    }, COMMENTARY_FLUSH_DELAY_MS);
    this.timers.set(taskId, timeout);
  }

  private clearTimer(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) {
      this.clearTimeoutImpl(timer);
      this.timers.delete(taskId);
    }
  }

  private async flushOnTimeout(taskId: string, chatId: ChatId): Promise<void> {
    if (this.stopped) {
      return;
    }
    const text = this.takeBuffer(taskId);
    if (text) {
      await this.onFlush(taskId, chatId, text);
    }
  }
}
