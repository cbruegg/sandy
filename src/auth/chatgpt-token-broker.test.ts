import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChatGPTTokenBroker } from "./chatgpt-token-broker.js";

const originalFetch = globalThis.fetch;

test("ChatGPTTokenBroker getInitialTokens reloads auth.json from disk", async () => {
  const { root, authFilePath } = await createAuthFixture({
    accessToken: "access-token-1",
    refreshToken: "refresh-token-1",
    idTokenPayload: {
      chatgpt_account_id: "acct-123",
      chatgpt_plan_type: "plus",
    },
  });

  try {
    const broker = new ChatGPTTokenBroker(authFilePath);
    const firstTokens = await broker.getInitialTokens();
    assert.equal(firstTokens.accessToken, "access-token-1");

    await writeAuthFile(authFilePath, {
      accessToken: "access-token-2",
      refreshToken: "refresh-token-1",
      idTokenPayload: {
        chatgpt_account_id: "acct-123",
        chatgpt_plan_type: "plus",
      },
    });

    const secondTokens = await broker.getInitialTokens();
    assert.equal(secondTokens.accessToken, "access-token-2");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("ChatGPTTokenBroker refreshTokens returns null after refresh failure even if auth.json changes elsewhere", async () => {
  const { root, authFilePath } = await createAuthFixture({
    accessToken: "expired-access-token",
    refreshToken: "refresh-token-1",
    idTokenPayload: {
      chatgpt_account_id: "acct-123",
      chatgpt_plan_type: "plus",
    },
  });

  try {
    globalThis.fetch = buildFetchMock(async () => {
      await writeAuthFile(authFilePath, {
        accessToken: "fresh-access-token",
        refreshToken: "refresh-token-2",
        idTokenPayload: {
          chatgpt_account_id: "acct-123",
          chatgpt_plan_type: "plus",
        },
      });
      return new Response(JSON.stringify({ error: { code: "refresh_token_reused" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    const broker = new ChatGPTTokenBroker(authFilePath);
    const refreshedTokens = await broker.refreshTokens("acct-123");

    assert.equal(refreshedTokens, null);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("ChatGPTTokenBroker refreshTokens returns null when refresh fails and auth.json is unchanged", async () => {
  const { root, authFilePath } = await createAuthFixture({
    accessToken: "expired-access-token",
    refreshToken: "refresh-token-1",
    idTokenPayload: {
      chatgpt_account_id: "acct-123",
      chatgpt_plan_type: "plus",
    },
  });

  try {
    globalThis.fetch = buildFetchMock(async () => new Response(JSON.stringify({ error: { code: "refresh_token_reused" } }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }));

    const broker = new ChatGPTTokenBroker(authFilePath);
    const refreshedTokens = await broker.refreshTokens("acct-123");

    assert.equal(refreshedTokens, null);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("ChatGPTTokenBroker refreshTokens persists tokens after successful refresh", async () => {
  const { root, authFilePath } = await createAuthFixture({
    accessToken: "expired-access-token",
    refreshToken: "refresh-token-1",
    idTokenPayload: {
      chatgpt_account_id: "acct-123",
      chatgpt_plan_type: "plus",
    },
  });

  try {
    globalThis.fetch = buildFetchMock(async () => new Response(JSON.stringify({
      access_token: "fresh-access-token",
      refresh_token: "refresh-token-2",
      id_token: buildJwt({
        chatgpt_account_id: "acct-123",
        chatgpt_plan_type: "pro",
      }),
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const broker = new ChatGPTTokenBroker(authFilePath);
    const refreshedTokens = await broker.refreshTokens("acct-123");

    assert.deepEqual(refreshedTokens, {
      accessToken: "fresh-access-token",
      chatgptAccountId: "acct-123",
      chatgptPlanType: "pro",
    });

    const savedAuth = JSON.parse(await readFile(authFilePath, "utf8")) as {
      tokens: { access_token: string; refresh_token: string };
      last_refresh?: string;
    };
    assert.equal(savedAuth.tokens.access_token, "fresh-access-token");
    assert.equal(savedAuth.tokens.refresh_token, "refresh-token-2");
    assert.ok(savedAuth.last_refresh);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test("ChatGPTTokenBroker coalesces concurrent refreshes behind one in-flight request", async () => {
  const { root, authFilePath } = await createAuthFixture({
    accessToken: "expired-access-token",
    refreshToken: "refresh-token-1",
    idTokenPayload: {
      chatgpt_account_id: "acct-123",
      chatgpt_plan_type: "plus",
    },
  });

  let fetchCalls = 0;
  let releaseFetch: () => void = () => {};
  const fetchStarted = new Promise<void>((resolve) => {
    releaseFetch = () => resolve();
  });

  try {
    globalThis.fetch = buildFetchMock(async () => {
      fetchCalls += 1;
      await fetchStarted;
      return new Response(JSON.stringify({
        access_token: "fresh-access-token",
        refresh_token: "refresh-token-2",
        id_token: buildJwt({
          chatgpt_account_id: "acct-123",
          chatgpt_plan_type: "pro",
        }),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const broker = new ChatGPTTokenBroker(authFilePath);
    const firstRefresh = broker.refreshTokens("acct-123");
    const secondRefresh = broker.refreshTokens("acct-123");
    releaseFetch();

    const [firstTokens, secondTokens] = await Promise.all([firstRefresh, secondRefresh]);

    assert.equal(fetchCalls, 1);
    assert.deepEqual(firstTokens, secondTokens);
    assert.deepEqual(firstTokens, {
      accessToken: "fresh-access-token",
      chatgptAccountId: "acct-123",
      chatgptPlanType: "pro",
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

async function createAuthFixture(input: {
  accessToken: string;
  refreshToken: string;
  idTokenPayload: Record<string, unknown>;
}): Promise<{ root: string; authFilePath: string }> {
  const tmpRoot = join(process.cwd(), "tmp");
  await mkdir(tmpRoot, { recursive: true });
  const root = await mkdtemp(join(tmpRoot, "chatgpt-token-broker-"));
  const authFilePath = join(root, "auth.json");
  await writeAuthFile(authFilePath, input);
  return { root, authFilePath };
}

async function writeAuthFile(
  authFilePath: string,
  input: {
    accessToken: string;
    refreshToken: string;
    idTokenPayload: Record<string, unknown>;
  },
): Promise<void> {
  await writeFile(authFilePath, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: input.accessToken,
      refresh_token: input.refreshToken,
      id_token: buildJwt(input.idTokenPayload),
      account_id: String(input.idTokenPayload["chatgpt_account_id"]),
    },
  }, null, 2) + "\n", "utf8");
}

function buildFetchMock(
  handler: (...args: Parameters<typeof fetch>) => Promise<Response>,
): typeof fetch {
  const fetchMock: typeof fetch = Object.assign(handler, {
    preconnect: originalFetch.preconnect.bind(originalFetch),
  });
  return fetchMock;
}

function buildJwt(payload: Record<string, unknown>): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value))
    .toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}
