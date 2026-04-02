import test from "node:test";
import assert from "node:assert/strict";
import type { ThreadOptions } from "@openai/codex-sdk";
import {
  buildMainAgentThreadOptions,
  CodexMainAgentController,
} from "./agent/main-agent-controller.js";
import type { DecideContext } from "./types.js";

class FakeThread {
  constructor(private readonly finalResponse: string) {}

  async run(): Promise<{ finalResponse: string }> {
    return { finalResponse: this.finalResponse };
  }
}

class RecordingCodexClient {
  public readonly startedThreads: ThreadOptions[] = [];

  startThread(options?: ThreadOptions): FakeThread {
    this.startedThreads.push(options ?? {});
    return new FakeThread(JSON.stringify({
      action: "reply",
      replyText: "hello",
      taskBrief: null,
      taskName: null,
    }));
  }
}

function makeContext(): DecideContext {
  return {
    chatId: "chat-1",
    transcript: [
      {
        role: "user",
        kind: "user_text",
        timestamp: "2026-04-02T10:00:00.000Z",
        text: "hello",
      },
    ],
    activeTask: null,
  };
}

test("buildMainAgentThreadOptions locks the main agent down", () => {
  const options = buildMainAgentThreadOptions("/tmp/sandy-main-agent-test");

  assert.equal(options.approvalPolicy, "never");
  assert.equal(options.sandboxMode, "read-only");
  assert.equal(options.workingDirectory, "/tmp/sandy-main-agent-test");
  assert.equal(options.skipGitRepoCheck, true);
});

test("CodexMainAgentController starts threads in a unique temp directory with no approvals", async () => {
  const codex = new RecordingCodexClient();
  const controller = new CodexMainAgentController(codex);

  const decision = await controller.decide(makeContext());

  assert.equal(decision.action, "reply");
  assert.equal(codex.startedThreads.length, 1);

  const options = codex.startedThreads[0];
  assert.equal(options.approvalPolicy, "never");
  assert.equal(options.sandboxMode, "read-only");
  assert.equal(options.skipGitRepoCheck, true);
  assert.match(options.workingDirectory ?? "", /^.+sandy-main-agent-/);
});

