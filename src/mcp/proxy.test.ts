import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ProxyAccess } from "../proxy-access.js";
import { SandyMcpProxy } from "./proxy.js";
import type { McpServerRegistry } from "./server-registry.js";

class FakeRegistry implements McpServerRegistry {
  private readonly client = {} as Client;

  async getClient(_serverId: string): Promise<Client> {
    return this.client;
  }

  async close() {}
}

class FakeResponse extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  body = "";

  end(chunk?: string): void {
    if (chunk) {
      this.body += chunk;
    }
    this.headersSent = true;
  }
}

function createProxy(access = new ProxyAccess("shared-secret")): SandyMcpProxy {
  return new SandyMcpProxy({
    access,
    registry: new FakeRegistry(),
    authorizeToolCall: async () => ({
      requestId: "approval-1",
      outcome: "approved",
      message: "approved",
    }),
  });
}

function createRequest(input: {
  url: string;
  authorization?: string;
  sessionId?: string;
}) {
  const headers: Record<string, string> = {};
  if (input.authorization) {
    headers["authorization"] = input.authorization;
  }
  if (input.sessionId) {
    headers["mcp-session-id"] = input.sessionId;
  }
  return {
    url: input.url,
    headers,
  };
}

test("SandyMcpProxy rejects requests without a bearer token", async () => {
  const proxy = createProxy();
  const response = new FakeResponse();

  await (proxy as unknown as {
    handleHttpRequest: (req: object, res: FakeResponse) => Promise<void>;
  }).handleHttpRequest(createRequest({
    url: "/mcp/tasks/task-1/servers/todoist",
  }), response);

  assert.equal(response.statusCode, 401);
  assert.equal(response.body, "Missing bearer token.");
});

test("SandyMcpProxy rejects task tokens used against a different task route", async () => {
  const access = new ProxyAccess("shared-secret");
  const proxy = createProxy(access);
  const response = new FakeResponse();

  await (proxy as unknown as {
    handleHttpRequest: (req: object, res: FakeResponse) => Promise<void>;
  }).handleHttpRequest(createRequest({
    url: "/mcp/tasks/task-2/servers/todoist",
    authorization: `Bearer ${access.issueWorkerGrant("task-1").bearerToken}`,
  }), response);

  assert.equal(response.statusCode, 403);
  assert.equal(response.body, "Bearer token does not grant access to this task.");
});

test("SandyMcpProxy accepts the same task token across different MCP server routes", async () => {
  const access = new ProxyAccess("shared-secret");
  const proxy = createProxy(access);
  let handledUrl: string | null = null;

  (proxy as unknown as {
    createSession: (route: { taskId: string; serverId: string }) => Promise<{
      route: { taskId: string; serverId: string };
      server: object;
      transport: {
        handleRequest: (req: { url?: string }, res: FakeResponse) => Promise<void>;
      };
    }>;
  }).createSession = async (route) => ({
    route,
    server: {},
    transport: {
      handleRequest: async (req, res) => {
        handledUrl = req.url ?? null;
        res.statusCode = 202;
        res.end("ok");
      },
    },
  });

  const response = new FakeResponse();
  await (proxy as unknown as {
    handleHttpRequest: (req: object, res: FakeResponse) => Promise<void>;
  }).handleHttpRequest(createRequest({
    url: "/mcp/tasks/task-1/servers/github",
    authorization: `Bearer ${access.issueWorkerGrant("task-1").bearerToken}`,
  }), response);

  assert.equal(response.statusCode, 202);
  assert.equal(response.body, "ok");
  assert.equal(handledUrl, "/mcp/tasks/task-1/servers/github");
});

test("SandyMcpProxy rejects MCP sessions that are reused on a different route", async () => {
  const access = new ProxyAccess("shared-secret");
  const proxy = createProxy(access);
  (proxy as unknown as {
    sessions: Map<string, {
      route: { taskId: string; serverId: string };
      server: object;
      transport: { close: () => Promise<void> };
    }>;
  }).sessions.set("session-1", {
    route: {
      taskId: "task-1",
      serverId: "todoist",
    },
    server: {},
    transport: {
      close: async () => {},
    },
  });
  const response = new FakeResponse();

  await (proxy as unknown as {
    handleHttpRequest: (req: object, res: FakeResponse) => Promise<void>;
  }).handleHttpRequest(createRequest({
    url: "/mcp/tasks/task-1/servers/github",
    sessionId: "session-1",
    authorization: `Bearer ${access.issueWorkerGrant("task-1").bearerToken}`,
  }), response);

  assert.equal(response.statusCode, 404);
  assert.equal(response.body, "Unknown MCP session for this task or server.");
});
