import test from "node:test";
import assert from "node:assert/strict";
import * as toml from "@iarna/toml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SandyMcpProxy } from "./proxy.js";
import type { McpServerRegistry } from "./server-registry.js";

type InitializeResponse = {
  result: {
    serverInfo: {
      name: string;
    };
  };
};

type ListToolsResponse = {
  result: {
    tools: Array<{
      name: string;
    }>;
  };
};

class FakeRegistry implements McpServerRegistry {
  private readonly client = new FakeClient() as unknown as Client;

  async getClient(_serverId: string): Promise<Client> {
    return this.client;
  }

  async close() {}
}

class FakeClient {
  async listTools() {
    return {
      tools: [{
        name: "add_task",
        description: "Add a task.",
        inputSchema: {
          type: "object" as const,
          properties: {
            content: { type: "string" },
          },
          required: ["content"],
          additionalProperties: false,
        },
      }],
    };
  }

  async listResources() {
    return { resources: [] };
  }

  async listResourceTemplates() {
    return { resourceTemplates: [] };
  }

  async readResource() {
    return {
      contents: [{
        uri: "file:///unused.txt",
        text: "unused",
      }],
    };
  }

  async listPrompts() {
    return { prompts: [] };
  }

  async getPrompt() {
    return {
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: "unused",
        },
      }],
    };
  }

  async callTool() {
    return {
      content: [{
        type: "text" as const,
        text: "unused",
      }],
    };
  }
}

test("SandyMcpProxy serves initialize and follow-up MCP requests on the same session", async () => {
  const proxy = new SandyMcpProxy({
    host: "127.0.0.1",
    workerBaseUrlHost: "127.0.0.1",
    mcpServers: {
      todoist: {
        transport: "streamable_http",
        url: "https://todoist.example/mcp",
        command: null,
        args: [],
        env: {},
        oauthScopes: [],
      },
    },
    registry: new FakeRegistry(),
    authorizeToolCall: async () => ({
      requestId: "approval-1",
      outcome: "approved",
      message: "approved",
    }),
  });

  await proxy.start();

  try {
    const launchConfig = proxy.buildWorkerLaunchConfig("task-1");
    assert.ok(launchConfig.codexConfigToml);
    const config = toml.parse(launchConfig.codexConfigToml) as {
      mcp_servers: {
        todoist: {
          url: string;
        };
      };
    };
    const url = config.mcp_servers.todoist.url;
    const authToken = launchConfig.environment.SANDY_MCP_PROXY_TOKEN;

    const initializeResponse = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: {
            name: "test-client",
            version: "1.0.0",
          },
        },
      }),
    });

    assert.equal(initializeResponse.status, 200);
    const sessionId = initializeResponse.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const initializePayload = await readSseJson<InitializeResponse>(initializeResponse);
    assert.equal(initializePayload.result.serverInfo.name, "Sandy MCP Proxy");

    const initializedResponse = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    });

    assert.equal(initializedResponse.status, 202);

    const listToolsResponse = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    });

    assert.equal(listToolsResponse.status, 200);
    const listToolsPayload = await readSseJson<ListToolsResponse>(listToolsResponse);
    assert.equal(listToolsPayload.result.tools[0].name, "add_task");
  } finally {
    await proxy.stop();
  }
});

async function readSseJson<T>(response: Response): Promise<T> {
  const body = await response.text();
  const jsonLines = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .filter((line) => line.trim().length > 0);

  assert.ok(jsonLines.length > 0, `Expected an SSE payload, got: ${body}`);
  return JSON.parse(jsonLines[jsonLines.length - 1]) as T;
}
