import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildStdioEnvironment, StdioMcpServerRegistry } from "./stdio-server-registry.js";

class FakeClient {
  public readonly connectCalls: unknown[] = [];
  public readonly closeCalls: number[] = [];
  public readonly listToolsCalls: unknown[] = [];
  public readonly callToolCalls: unknown[] = [];

  async connect(transport: unknown): Promise<void> {
    this.connectCalls.push(transport);
  }

  async close(): Promise<void> {
    this.closeCalls.push(this.closeCalls.length + 1);
  }

  async listTools(params: unknown): Promise<{ tools: Array<{ name: string }> }> {
    this.listToolsCalls.push(params);
    return {
      tools: [{
        name: "ping",
      }],
    };
  }

  async listResources(): Promise<{ resources: [] }> {
    return { resources: [] };
  }

  async listResourceTemplates(): Promise<{ resourceTemplates: [] }> {
    return { resourceTemplates: [] };
  }

  async readResource(): Promise<{ contents: [] }> {
    return { contents: [] };
  }

  async listPrompts(): Promise<{ prompts: [] }> {
    return { prompts: [] };
  }

  async getPrompt(): Promise<{ description: string; messages: [] }> {
    return { description: "", messages: [] };
  }

  async callTool(params: unknown): Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }> {
    this.callToolCalls.push(params);
    return {
      content: [{
        type: "text",
        text: "pong",
      }],
      isError: false,
    };
  }
}

test("buildStdioEnvironment keeps a minimal base environment", () => {
  const originalPath = process.env["PATH"];
  const originalHome = process.env["HOME"];
  const originalTmpdir = process.env["TMPDIR"];
  const originalTmp = process.env["TMP"];
  const originalTemp = process.env["TEMP"];

  try {
    process.env["PATH"] = "/usr/local/bin";
    process.env["HOME"] = "/home/sandy";
    delete process.env["TMPDIR"];
    delete process.env["TMP"];
    delete process.env["TEMP"];

    assert.deepEqual(buildStdioEnvironment({
      SPOTIFY_CLIENT_ID: "client-id",
    }), {
      HOME: "/home/sandy",
      PATH: "/usr/local/bin",
      SPOTIFY_CLIENT_ID: "client-id",
    });
  } finally {
    if (originalPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = originalPath;
    }
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    if (originalTmpdir === undefined) {
      delete process.env["TMPDIR"];
    } else {
      process.env["TMPDIR"] = originalTmpdir;
    }
    if (originalTmp === undefined) {
      delete process.env["TMP"];
    } else {
      process.env["TMP"] = originalTmp;
    }
    if (originalTemp === undefined) {
      delete process.env["TEMP"];
    } else {
      process.env["TEMP"] = originalTemp;
    }
  }
});

test("StdioMcpServerRegistry eagerly connects and reuses stdio servers", async () => {
  const fakeClient = new FakeClient();
  const transportConfigs: Array<{
    command: string;
    args: string[];
    cwd?: string;
    env: Record<string, string>;
  }> = [];
  const registry = new StdioMcpServerRegistry({
    spotify: {
      transport: "stdio",
      command: "node",
      args: ["build/index.js"],
      cwd: "/tmp/spotify",
      env: {
        SPOTIFY_CLIENT_ID: "client-id",
      },
    },
  }, {
    clientFactory: () => fakeClient as unknown as Client,
    transportFactory: (config) => {
      transportConfigs.push({
        command: config.command,
        args: config.args,
        cwd: config.cwd ?? undefined,
        env: config.env,
      });
      return {} as StdioClientTransport;
    },
  });

  await registry.start();
  const result = await registry.execute("spotify", "callTool", {
    name: "play",
    arguments: {},
  });
  await registry.close();

  assert.deepEqual(transportConfigs, [{
    command: "node",
    args: ["build/index.js"],
    cwd: "/tmp/spotify",
    env: {
      SPOTIFY_CLIENT_ID: "client-id",
    },
  }]);
  assert.equal(fakeClient.connectCalls.length, 1);
  assert.equal(fakeClient.closeCalls.length, 1);
  assert.deepEqual(fakeClient.callToolCalls, [{
    name: "play",
    arguments: {},
  }]);
  assert.deepEqual(result, {
    content: [{
      type: "text",
      text: "pong",
    }],
    isError: false,
  });
});
