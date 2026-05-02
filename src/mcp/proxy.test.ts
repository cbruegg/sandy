import { test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

class ReadResourceRegistry implements McpServerRegistry {
  public readonly calls: string[] = [];

  constructor(private readonly result: Awaited<ReturnType<Client["readResource"]>>) {}

  async getClient(_serverId: string): Promise<Client> {
    return {
      readResource: async (params: { uri: string }) => {
        this.calls.push(params.uri);
        return this.result;
      },
    } as unknown as Client;
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
    authorizeResourceRead: async () => ({
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

function getRequestHandler(server: McpServer, method: string) {
  return (server.server as unknown as {
    _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
  })._requestHandlers.get(method);
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

test("SandyMcpProxy forwards readResource when authorization approves it", async () => {
  const registry = new ReadResourceRegistry({
    contents: [{
      uri: "test://resource",
      text: "approved resource",
    }],
  });
  const proxy = new SandyMcpProxy({
    access: new ProxyAccess("shared-secret"),
    registry,
    authorizeToolCall: async () => ({
      requestId: "approval-tool",
      outcome: "approved",
      message: "approved",
    }),
    authorizeResourceRead: async () => ({
      requestId: "approval-resource",
      outcome: "approved",
      message: "approved",
    }),
  });

  const server = (proxy as unknown as {
    createServer: (route: { taskId: string; serverId: string }) => McpServer;
  }).createServer({ taskId: "task-1", serverId: "todoist" });
  const handler = getRequestHandler(server, "resources/read");

  assert.ok(handler);
  const result = await handler?.({
    method: "resources/read",
    params: {
      uri: "test://resource",
    },
  }, undefined) as { contents: Array<{ uri: string; text: string }> };

  assert.deepEqual(registry.calls, ["test://resource"]);
  assert.deepEqual(result, {
    contents: [{
      uri: "test://resource",
      text: "approved resource",
    }],
  });
});

test("SandyMcpProxy blocks readResource when authorization denies it", async () => {
  const registry = new ReadResourceRegistry({
    contents: [{
      uri: "test://resource",
      text: "should not be returned",
    }],
  });
  const proxy = new SandyMcpProxy({
    access: new ProxyAccess("shared-secret"),
    registry,
    authorizeToolCall: async () => ({
      requestId: "approval-tool",
      outcome: "approved",
      message: "approved",
    }),
    authorizeResourceRead: async () => ({
      requestId: "approval-resource",
      outcome: "denied",
      message: "denied by test",
    }),
  });

  const server = (proxy as unknown as {
    createServer: (route: { taskId: string; serverId: string }) => McpServer;
  }).createServer({ taskId: "task-1", serverId: "todoist" });
  const handler = getRequestHandler(server, "resources/read");

  assert.ok(handler);
  const result = await handler?.({
    method: "resources/read",
    params: {
      uri: "test://resource",
    },
  }, undefined) as { contents: Array<{ uri: string; text: string }> };

  assert.deepEqual(registry.calls, []);
  assert.deepEqual(result, {
    contents: [{
      uri: "error://sandy/denied",
      text: "denied by test",
    }],
  });
});
