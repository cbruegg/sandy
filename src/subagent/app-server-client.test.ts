import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { CodexAppServerClient } from "./app-server-client.js";
import type { ChatGPTExternalTokens } from "../types.js";
import { configureLogger, type LogLevel } from "../logger.js";

class CaptureWritable extends Writable {
  public readonly writes: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    callback(null);
  }
}

class FakeChildProcess extends EventEmitter {
  public readonly stdin = new CaptureWritable();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly killSignals: Array<NodeJS.Signals | number> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal ?? "SIGTERM");
    return true;
  }
}

function parseWrittenJsonLines(child: FakeChildProcess): Array<Record<string, unknown>> {
  return child.stdin.writes
    .flatMap((entry) => entry.split("\n"))
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

function respond(child: FakeChildProcess, id: number, result: unknown): void {
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

async function createExternalTokensClient(
  spawnImpl: typeof import("node:child_process").spawn,
  child: FakeChildProcess,
  tokens: ChatGPTExternalTokens,
): Promise<CodexAppServerClient> {
  const clientPromise = CodexAppServerClient.createWithExternalTokens({
    codexPath: "codex",
    spawnImpl,
    tokens,
  });

  await Promise.resolve();
  respond(child, 1, {});
  await new Promise((resolve) => setImmediate(resolve));
  respond(child, 2, {});
  return clientPromise;
}

async function createAmbientAuthClient(
  spawnImpl: typeof import("node:child_process").spawn,
  child: FakeChildProcess,
): Promise<CodexAppServerClient> {
  const clientPromise = CodexAppServerClient.createWithAmbientAuth({
    codexPath: "codex",
    spawnImpl,
  });

  await Promise.resolve();
  respond(child, 1, {});
  return clientPromise;
}

test("CodexAppServerClient starts threads with kebab-case sandbox mode", async () => {
  const child = new FakeChildProcess();
  const spawns: Array<{ command: string; args: string[] }> = [];
  const spawnImpl = ((command: string, args: readonly string[]) => {
    spawns.push({ command, args: [...args] });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread("gpt-5.4-mini");
  await Promise.resolve();

  assert.deepEqual(spawns, [{
    command: "codex",
    args: ["app-server", "--listen", "stdio://"],
  }]);

  const messages = parseWrittenJsonLines(child);
  assert.equal(messages[3]?.["method"], "thread/start");
  assert.deepEqual(messages[3]?.["params"], {
    model: "gpt-5.4-mini",
    cwd: "/workspace/share",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    personality: "none",
  });

  respond(child, 3, {
    thread: { id: "thread-1" },
  });
  assert.equal(await startThreadPromise, "thread-1");
});

test("CodexAppServerClient answers auth refresh requests during turns", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread();
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events = [] as Array<{ type: string; text?: string }>;
    for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async (previousAccountId) => {
      assert.equal(previousAccountId, "acct-123");
      return {
        accessToken: "refreshed-access-token",
        chatgptAccountId: "acct-123",
        chatgptPlanType: "plus",
      };
    })) {
      events.push(event);
    }
    return events;
  })();

  await Promise.resolve();
  let messages = parseWrittenJsonLines(child);
  assert.equal(messages[4]?.["method"], "turn/start");
  assert.deepEqual(messages[4]?.["params"], {
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }],
  });

  respond(child, 4, {});
  await new Promise((resolve) => setImmediate(resolve));

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 77,
    method: "account/chatgptAuthTokens/refresh",
    params: {
      previousAccountId: "acct-123",
      reason: "expired",
    },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  messages = parseWrittenJsonLines(child);
  assert.deepEqual(messages.at(-1), {
    jsonrpc: "2.0",
    id: 77,
    result: {
      accessToken: "refreshed-access-token",
      chatgptAccountId: "acct-123",
      chatgptPlanType: "plus",
    },
  });

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          text: "done",
        },
      },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {},
  })}\n`);

  const events = await streamPromise;
  assert.deepEqual(events, [
    { type: "agent_message_completed", itemId: null, text: "done" },
    { type: "turn_completed" },
  ]);
});

test("CodexAppServerClient handles auth refresh before turn-start RPC response", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread();
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events: Array<{ type: string; text?: string }> = [];
    for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async (previousAccountId) => {
      assert.equal(previousAccountId, "acct-123");
      return {
        accessToken: "refreshed-before-start-response",
        chatgptAccountId: "acct-123",
        chatgptPlanType: "plus",
      };
    })) {
      events.push(event);
    }
    return events;
  })();

  await Promise.resolve();
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 88,
    method: "account/chatgptAuthTokens/refresh",
    params: {
      previousAccountId: "acct-123",
      reason: "expired-before-turn-start-response",
    },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  let messages = parseWrittenJsonLines(child);
  assert.deepEqual(messages.at(-1), {
    jsonrpc: "2.0",
    id: 88,
    result: {
      accessToken: "refreshed-before-start-response",
      chatgptAccountId: "acct-123",
      chatgptPlanType: "plus",
    },
  });

  respond(child, 4, {});
  await new Promise((resolve) => setImmediate(resolve));

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          text: "done after early refresh",
        },
      },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {},
  })}\n`);

  assert.deepEqual(await streamPromise, [
    { type: "agent_message_completed", itemId: null, text: "done after early refresh" },
    { type: "turn_completed" },
  ]);

  messages = parseWrittenJsonLines(child);
  assert.equal(messages[4]?.["method"], "turn/start");
});

test("CodexAppServerClient ignores non-message item completions until turn completion", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread();
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events: Array<{ type: string; text?: string }> = [];
    for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async () => ({
      accessToken: "refreshed-access-token",
      chatgptAccountId: "acct-123",
      chatgptPlanType: "plus",
    }))) {
      events.push(event);
    }
    return events;
  })();

  await Promise.resolve();
  respond(child, 4, {});
  await new Promise((resolve) => setImmediate(resolve));

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      item: {
        type: "reasoning",
        text: "thinking",
      },
    },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {},
  })}\n`);

  assert.deepEqual(await streamPromise, [
    { type: "turn_completed" },
  ]);
});

test("CodexAppServerClient ignores agent message deltas until completion", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread();
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events: Array<{ type: string; text?: string }> = [];
    for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async () => tokens)) {
      events.push(event);
    }
    return events;
  })();

  await Promise.resolve();
  respond(child, 4, {});
  await new Promise((resolve) => setImmediate(resolve));

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "item/agentMessage/delta",
    params: {
      itemId: "item-1",
      delta: "Hello",
    },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      turn: {
        status: "completed",
      },
    },
  })}\n`);

  assert.deepEqual(await streamPromise, [
    { type: "turn_completed" },
  ]);
});

test("CodexAppServerClient ignores known benign notifications and item completions", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const logs: Array<{ level: LogLevel; event: string }> = [];

  configureLogger({
    minLevel: "debug",
    forwardLog: (payload) => {
      logs.push({ level: payload.level, event: payload.event });
    },
  });

  try {
    const client = await createExternalTokensClient(spawnImpl, child, tokens);

    const startThreadPromise = client.startThread();
    await Promise.resolve();
    respond(child, 3, { thread: { id: "thread-1" } });
    const threadId = await startThreadPromise;

    const streamPromise = (async () => {
      const events: Array<{ type: string }> = [];
      for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async () => tokens)) {
        events.push(event);
      }
      return events;
    })();

    await Promise.resolve();
    respond(child, 4, {});
    await new Promise((resolve) => setImmediate(resolve));

    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/started", params: {} })}\n`);
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: {} })}\n`);
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "account/rateLimits/updated", params: {} })}\n`);
    child.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          text: null,
        },
      },
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "mcpToolCall",
          text: null,
        },
      },
    })}\n`);
    child.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "item/completed",
      params: {
        item: {
          type: "reasoning",
          text: "thinking",
        },
      },
    })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    child.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        turn: {
          status: "completed",
          error: null,
        },
      },
    })}\n`);

    assert.deepEqual(await streamPromise, [{ type: "turn_completed" }]);
    assert.equal(logs.some((entry) => entry.event === "appserver.notification_unhandled"), false);
    assert.equal(logs.some((entry) => entry.event === "appserver.item_completed_unhandled"), false);
  } finally {
    configureLogger({
      minLevel: "info",
      outputMode: "split",
      forwardLog: undefined,
    });
  }
});

test("CodexAppServerClient maps failed turn/completed notifications to turn_failed", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread();
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events: Array<{ type: string; error?: string }> = [];
    for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async () => tokens)) {
      events.push(event);
    }
    return events;
  })();

  await Promise.resolve();
  respond(child, 4, {});
  await new Promise((resolve) => setImmediate(resolve));

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: {
      turn: {
        status: "failed",
        error: {
          message: "turn exploded",
        },
      },
    },
  })}\n`);

  assert.deepEqual(await streamPromise, [
    { type: "turn_failed", error: "turn exploded" },
  ]);
});

test("CodexAppServerClient initializes ambient auth without experimental API or explicit login", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const client = await createAmbientAuthClient(spawnImpl, child);

  const messages = parseWrittenJsonLines(child);
  assert.equal(messages[0]?.["method"], "initialize");
  assert.deepEqual(messages[0]?.["params"], {
    clientInfo: {
      name: "sandy_worker",
      title: "Sandy Worker",
      version: "1.0.0",
    },
    capabilities: {},
  });
  assert.equal(messages.some((message) => message["method"] === "account/login/start"), false);

  const startThreadPromise = client.startThread();
  await Promise.resolve();
  respond(child, 2, { thread: { id: "thread-1" } });
  assert.equal(await startThreadPromise, "thread-1");
});
