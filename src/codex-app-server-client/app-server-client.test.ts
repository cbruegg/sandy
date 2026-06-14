import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { CodexAppServerClient, denyAllServerRequests, type ServerRequestHandler } from "./app-server-client.js";
import type { ChatGPTExternalTokens } from "../types.js";
import { configureLogger, type LogLevel } from "../logger.js";
import type {ThreadStartParams} from "./generated/v2";

const TEST_WORKER_PROFILE = {
  sandbox: "danger-full-access" as const,
  cwd: "/workspace/share",
  personality: "none" as const,
} satisfies ThreadStartParams;

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
  env?: NodeJS.ProcessEnv,
): Promise<CodexAppServerClient> {
  const clientPromise = CodexAppServerClient.createWithAmbientAuth({
    codexPath: "codex",
    env,
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

  const startThreadPromise = client.startThread({
    ...TEST_WORKER_PROFILE,
    model: "gpt-5.4-mini",
  });
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

test("CodexAppServerClient logs app-server stderr lines", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const logs: Array<{ level: LogLevel; event: string; data?: Record<string, unknown> }> = [];

  configureLogger({
    minLevel: "debug",
    outputMode: "split",
    forwardLog: (payload) => {
      logs.push(payload);
    },
  });

  try {
    await createAmbientAuthClient(spawnImpl, child);
    child.stderr.write("failed to load configuration\n");
    await new Promise((resolve) => setImmediate(resolve));

    const logEntry = logs.find((entry) => entry.event === "appserver.stderr");
    assert.ok(logEntry);
    assert.equal(logEntry.level, "warn");
    assert.equal(logEntry.data?.["line"], "failed to load configuration");
  } finally {
    configureLogger({
      minLevel: "info",
      outputMode: "split",
      forwardLog: undefined,
    });
  }
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

  const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events = [] as Array<{ method: string; params?: unknown }>;
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

  respond(child, 4, { turn: { id: "turn-1" } });
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
    { method: "item/completed", params: { item: { type: "agentMessage", text: "done" } } },
    { method: "turn/completed", params: {} },
  ]);
});

test("CodexAppServerClient converts SDK local_image inputs to app-server localImage inputs", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events: Array<{ method: string; params?: unknown }> = [];
    for await (const event of client.streamTurn(
      threadId,
      [
        { type: "text", text: "hello" },
        { type: "local_image", path: "/workspace/share/photo.jpg" },
      ],
      async () => tokens,
    )) {
      events.push(event);
    }
    return events;
  })();

  await Promise.resolve();
  const messages = parseWrittenJsonLines(child);
  assert.equal(messages[4]?.["method"], "turn/start");
  assert.deepEqual(messages[4]?.["params"], {
    threadId: "thread-1",
    input: [
      { type: "text", text: "hello" },
      { type: "localImage", path: "/workspace/share/photo.jpg" },
    ],
  });

  respond(child, 4, { turn: { id: "turn-1" } });
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: {} })}\n`);
  assert.deepEqual(await streamPromise, [{ method: "turn/completed", params: {} }]);
});

test("CodexAppServerClient steers active turns with turn/steer", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events: Array<{ method: string; params?: unknown }> = [];
    for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async () => tokens)) {
      events.push(event);
    }
    return events;
  })();

  await Promise.resolve();
  respond(child, 4, { turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));

  const steerPromise = client.steerActiveTurn(threadId, [{ type: "text", text: "actually focus on tests" }]);
  await Promise.resolve();

  const messages = parseWrittenJsonLines(child);
  assert.equal(messages[5]?.["method"], "turn/steer");
  assert.deepEqual(messages[5]?.["params"], {
    threadId: "thread-1",
    input: [{ type: "text", text: "actually focus on tests" }],
    expectedTurnId: "turn-1",
  });

  respond(child, 5, { turnId: "turn-1" });
  assert.equal(await steerPromise, true);

  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: {} })}\n`);
  assert.deepEqual(await streamPromise, [{ method: "turn/completed", params: {} }]);
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

  const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events: Array<{ method: string; params?: unknown }> = [];
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

  respond(child, 4, { turn: { id: "turn-1" } });
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
    { method: "item/completed", params: { item: { type: "agentMessage", text: "done after early refresh" } } },
    { method: "turn/completed", params: {} },
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

  const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events: Array<{ method: string; params?: unknown }> = [];
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
  respond(child, 4, { turn: { id: "turn-1" } });
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
    { method: "turn/completed", params: {} },
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

  const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events: Array<{ method: string; params?: unknown }> = [];
    for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async () => tokens)) {
      events.push(event);
    }
    return events;
  })();

  await Promise.resolve();
  respond(child, 4, { turn: { id: "turn-1" } });
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
    { method: "turn/completed", params: { turn: { status: "completed" } } },
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

    const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
    await Promise.resolve();
    respond(child, 3, { thread: { id: "thread-1" } });
    const threadId = await startThreadPromise;

    const streamPromise = (async () => {
      const events: Array<{ method: string; params?: unknown }> = [];
      for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async () => tokens)) {
        events.push(event);
      }
      return events;
    })();

    await Promise.resolve();
    respond(child, 4, { turn: { id: "turn-1" } });
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

    assert.deepEqual(await streamPromise, [{ method: "turn/completed", params: { turn: { status: "completed", error: null } } }]);
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

test("CodexAppServerClient yields failed turn/completed notifications", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events: Array<{ method: string; params?: unknown }> = [];
    for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async () => tokens)) {
      events.push(event);
    }
    return events;
  })();

  await Promise.resolve();
  respond(child, 4, { turn: { id: "turn-1" } });
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
    {
      method: "turn/completed",
      params: {
        turn: {
          status: "failed",
          error: {
            message: "turn exploded",
          },
        },
      },
    },
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
    capabilities: null,
  });
  assert.equal(messages.some((message) => message["method"] === "account/login/start"), false);

  const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
  await Promise.resolve();
  respond(child, 2, { thread: { id: "thread-1" } });
  assert.equal(await startThreadPromise, "thread-1");
});

test("CodexAppServerClient passes ambient auth environment overrides to app-server", async () => {
  const child = new FakeChildProcess();
  const spawns: Array<NodeJS.ProcessEnv | undefined> = [];
  const spawnImpl = ((
    _command: string,
    _args: readonly string[],
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    spawns.push(options?.env);
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  await createAmbientAuthClient(spawnImpl, child, { CODEX_API_KEY: "sk-config-only" });

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]?.["CODEX_API_KEY"], "sk-config-only");
});

test("CodexAppServerClient sends JSON-RPC error when auth refresh handler rejects", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const logs: Array<{ level: LogLevel; event: string; data?: Record<string, unknown> }> = [];

  configureLogger({
    minLevel: "debug",
    forwardLog: (payload) => {
      logs.push({ level: payload.level, event: payload.event, data: payload.data });
    },
  });

  try {
    const client = await createExternalTokensClient(spawnImpl, child, tokens);

    const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
    await Promise.resolve();
    respond(child, 3, { thread: { id: "thread-1" } });
    const threadId = await startThreadPromise;

    const streamPromise = (async () => {
      const events: Array<{ method: string; params?: unknown }> = [];
      for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async (previousAccountId) => {
        assert.equal(previousAccountId, "acct-123");
        throw new Error("Host refused to refresh tokens");
      })) {
        events.push(event);
      }
      return events;
    })();

    await Promise.resolve();
    respond(child, 4, { turn: { id: "turn-1" } });
    await new Promise((resolve) => setImmediate(resolve));

    child.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "account/chatgptAuthTokens/refresh",
      params: {
        previousAccountId: "acct-123",
        reason: "expired",
      },
    })}
`);
    await new Promise((resolve) => setImmediate(resolve));

    const messages = parseWrittenJsonLines(child);
    const lastMessage = messages.at(-1);
    assert.deepEqual(lastMessage, {
      jsonrpc: "2.0",
      id: 99,
      error: {
        code: -32603,
        message: "Auth refresh failed: Host refused to refresh tokens",
      },
    });

    const errorLog = logs.find((entry) => entry.event === "appserver.auth_refresh_failed");
    assert.ok(errorLog);
    assert.equal(errorLog?.level, "error");
    assert.equal(errorLog?.data?.["message"], "Host refused to refresh tokens");

    // Complete the turn so the stream iterator can finish cleanly.
    child.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {},
    })}
`);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(await streamPromise, [{ method: "turn/completed", params: {} }]);
  } finally {
    configureLogger({
      minLevel: "info",
      outputMode: "split",
      forwardLog: undefined,
    });
  }
});

test("CodexAppServerClient yields context_compaction on item/started with contextCompaction type", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events: Array<{ method: string; params?: unknown }> = [];
    for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async () => tokens)) {
      events.push(event);
    }
    return events;
  })();

  await Promise.resolve();
  respond(child, 4, { turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "item/started",
    params: {
      item: {
        id: "compaction-1",
        type: "contextCompaction",
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
    { method: "item/started", params: { item: { id: "compaction-1", type: "contextCompaction" } } },
    { method: "turn/completed", params: {} },
  ]);
});

test("CodexAppServerClient yields context_compaction on item/completed with contextCompaction type", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events: Array<{ method: string; params?: unknown }> = [];
    for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async () => tokens)) {
      events.push(event);
    }
    return events;
  })();

  await Promise.resolve();
  respond(child, 4, { turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      item: {
        id: "compaction-1",
        type: "contextCompaction",
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
    { method: "item/completed", params: { item: { id: "compaction-1", type: "contextCompaction" } } },
    { method: "turn/completed", params: {} },
  ]);
});

test("CodexAppServerClient yields item/started with non-compaction types", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events: Array<{ method: string; params?: unknown }> = [];
    for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async () => tokens)) {
      events.push(event);
    }
    return events;
  })();

  await Promise.resolve();
  respond(child, 4, { turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "item/started",
    params: {
      item: {
        id: "msg-1",
        type: "agentMessage",
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
    { method: "item/started", params: { item: { id: "msg-1", type: "agentMessage" } } },
    { method: "turn/completed", params: {} },
  ]);
});

test("CodexAppServerClient delegates mcpServer/elicitation/request to onServerRequest callback", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const serverRequestCalls: Array<{ method: string; params: unknown }> = [];
  const handler: ServerRequestHandler = async (request) => {
    serverRequestCalls.push({ method: request.method, params: request.params });
    if (request.method === "mcpServer/elicitation/request" && request.params.serverName === "mempalace") {
      return { action: "accept", content: null, _meta: null };
    }
    return { action: "decline", content: null, _meta: null };
  };

  const streamPromise = (async () => {
    const events: Array<{ method: string; params?: unknown }> = [];
    for await (const event of client.streamTurn(
      threadId,
      [{ type: "text", text: "hello" }],
      async () => tokens,
      undefined,
      handler,
    )) {
      events.push(event);
    }
    return events;
  })();

  await Promise.resolve();
  respond(child, 4, { turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 55,
    method: "mcpServer/elicitation/request",
    params: {
      serverName: "mempalace",
      requestId: "req-1",
    },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  const messages = parseWrittenJsonLines(child);
  assert.deepEqual(messages.at(-1), {
    jsonrpc: "2.0",
    id: 55,
    result: {
      action: "accept",
      content: null,
      _meta: null,
    },
  });

  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 56,
    method: "mcpServer/elicitation/request",
    params: {
      serverName: "other-server",
      requestId: "req-2",
    },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  const messages2 = parseWrittenJsonLines(child);
  assert.deepEqual(messages2.at(-1), {
    jsonrpc: "2.0",
    id: 56,
    result: {
      action: "decline",
      content: null,
      _meta: null,
    },
  });

  assert.equal(serverRequestCalls.length, 2);
  assert.deepEqual(serverRequestCalls[0], { method: "mcpServer/elicitation/request", params: { serverName: "mempalace", requestId: "req-1" } });
  assert.deepEqual(serverRequestCalls[1], { method: "mcpServer/elicitation/request", params: { serverName: "other-server", requestId: "req-2" } });

  // Complete turn
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: {} })}\n`);
  await streamPromise;
});

test("CodexAppServerClient returns method-not-found when onServerRequest callback returns null", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const logs: Array<{ level: LogLevel; event: string; data?: Record<string, unknown> }> = [];
  configureLogger({
    minLevel: "debug",
    forwardLog: (payload) => {
      logs.push({ level: payload.level, event: payload.event, data: payload.data });
    },
  });

  try {
    const handler: ServerRequestHandler = async () => null;

    const streamPromise = (async () => {
      const events: Array<{ method: string; params?: unknown }> = [];
      for await (const event of client.streamTurn(
        threadId,
        [{ type: "text", text: "hello" }],
        async () => tokens,
        undefined,
        handler,
      )) {
        events.push(event);
      }
      return events;
    })();

    await Promise.resolve();
    respond(child, 4, { turn: { id: "turn-1" } });
    await new Promise((resolve) => setImmediate(resolve));

    child.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 66,
      method: "attestation/generate",
      params: { attestationKind: "attestation" },
    })}\n`);
    await new Promise((resolve) => setImmediate(resolve));

    const messages = parseWrittenJsonLines(child);
    assert.deepEqual(messages.at(-1), {
      jsonrpc: "2.0",
      id: 66,
      error: {
        code: -32601,
        message: "Method not found: attestation/generate",
      },
    });

    const warnLog = logs.find((entry) => entry.event === "appserver.server_request_unhandled");
    assert.ok(warnLog);

    // Complete the turn so the stream resolves.
    child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: {} })}\n`);
    await streamPromise;
  } finally {
    configureLogger({
      minLevel: "info",
      outputMode: "split",
      forwardLog: undefined,
    });
  }
});

test("CodexAppServerClient does not hardcode mempalace MCP elicitation response without callback", async () => {
  const child = new FakeChildProcess();
  const spawnImpl = ((() => child as unknown as ChildProcessWithoutNullStreams) as unknown) as typeof import("node:child_process").spawn;
  const tokens: ChatGPTExternalTokens = {
    accessToken: "access-token",
    chatgptAccountId: "acct-123",
    chatgptPlanType: "plus",
  };
  const client = await createExternalTokensClient(spawnImpl, child, tokens);

  const startThreadPromise = client.startThread(TEST_WORKER_PROFILE);
  await Promise.resolve();
  respond(child, 3, { thread: { id: "thread-1" } });
  const threadId = await startThreadPromise;

  const streamPromise = (async () => {
    const events: Array<{ method: string; params?: unknown }> = [];
    for await (const event of client.streamTurn(threadId, [{ type: "text", text: "hello" }], async () => tokens)) {
      events.push(event);
    }
    return events;
  })();

  await Promise.resolve();
  respond(child, 4, { turn: { id: "turn-1" } });
  await new Promise((resolve) => setImmediate(resolve));

  // Without callback, mempalace MCP elicitation should NOT be auto-accepted.
  child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 77,
    method: "mcpServer/elicitation/request",
    params: {
      serverName: "mempalace",
      requestId: "req-mp",
    },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));

  const messages = parseWrittenJsonLines(child);
  // Expect method-not-found (or deny) — definitely NOT an accept.
  const lastMessage = messages.at(-1) as Record<string, unknown>;
  assert.ok(lastMessage);
  // Verify it's not an accept response.
  assert.ok(
    !lastMessage["result"] || (lastMessage["result"] as Record<string, unknown>)?.["action"] !== "accept",
    "Client must not auto-accept mempalace without a callback",
  );

  // Complete turn
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: {} })}\n`);
  await streamPromise;
});

test("denyAllServerRequests declines MCP elicitation and denies command/file approvals", () => {
  // MCP elicitation → decline
  let result = denyAllServerRequests({
    method: "mcpServer/elicitation/request",
    id: 1,
    params: { serverName: "any-server", requestId: "r1" },
  } as unknown as Parameters<typeof denyAllServerRequests>[0]);
  assert.deepEqual(result, { action: "decline", content: null, _meta: null });

  // Command execution → decline
  result = denyAllServerRequests({
    method: "item/commandExecution/requestApproval",
    id: 1,
    params: { command: "ls" },
  } as unknown as Parameters<typeof denyAllServerRequests>[0]);
  assert.deepEqual(result, { decision: "decline" });

  // File change → decline
  result = denyAllServerRequests({
    method: "item/fileChange/requestApproval",
    id: 1,
    params: { filePath: "test.txt" },
  } as unknown as Parameters<typeof denyAllServerRequests>[0]);
  assert.deepEqual(result, { decision: "decline" });

  // applyPatchApproval → denied
  result = denyAllServerRequests({
    method: "applyPatchApproval",
    id: 1,
    params: { filePath: "test.txt" },
  } as unknown as Parameters<typeof denyAllServerRequests>[0]);
  assert.deepEqual(result, { decision: "denied" });

  // execCommandApproval → denied
  result = denyAllServerRequests({
    method: "execCommandApproval",
    id: 1,
    params: { command: "ls" },
  } as unknown as Parameters<typeof denyAllServerRequests>[0]);
  assert.deepEqual(result, { decision: "denied" });

  // Unknown method → null (method-not-found)
  result = denyAllServerRequests({
    method: "unknown/method",
    id: 1,
    params: {},
  } as unknown as Parameters<typeof denyAllServerRequests>[0]);
  assert.equal(result, null);
});

test("TEST_WORKER_PROFILE uses danger-full-access sandbox and workspace share", () => {
  assert.equal(TEST_WORKER_PROFILE.sandbox, "danger-full-access");
  assert.equal(TEST_WORKER_PROFILE.cwd, "/workspace/share");
  assert.equal(TEST_WORKER_PROFILE.personality, "none");
});
