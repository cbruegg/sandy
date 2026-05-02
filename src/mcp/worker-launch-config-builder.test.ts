import { test } from "bun:test";
import assert from "node:assert/strict";
import * as toml from "@iarna/toml";
import type { McpServerConfig } from "../config.js";
import { ProxyAccess } from "../proxy-access.js";
import { sandyMcpServerId } from "../subagent/worker-tools.js";
import { mcpProxyWorkerBaseUrl, workerProxyTokenEnvVar } from "./proxy-access.js";
import { McpWorkerLaunchConfigBuilder } from "./worker-launch-config-builder.js";

test("McpWorkerLaunchConfigBuilder always exposes Sandy's built-in MCP server", async () => {
  const builder = new McpWorkerLaunchConfigBuilder(
    {},
    new ProxyAccess(),
  );
  const launchConfig = builder.build("task-1");

  assert.ok(launchConfig.codexConfigToml);
  const parsed = toml.parse(launchConfig.codexConfigToml) as {
    mcp_servers: Record<string, {
      url: string;
      bearer_token_env_var: string;
    }>;
  };

  assert.deepEqual(Object.keys(parsed.mcp_servers), [sandyMcpServerId]);
  assert.equal(parsed.mcp_servers[sandyMcpServerId]?.url, `${mcpProxyWorkerBaseUrl}/mcp/tasks/task-1/servers/${sandyMcpServerId}`);
  assert.equal(parsed.mcp_servers[sandyMcpServerId]?.bearer_token_env_var, workerProxyTokenEnvVar);
});

test("McpWorkerLaunchConfigBuilder builds worker TOML and env from access data", async () => {
  const mcpServers: Record<string, McpServerConfig> = {
    todoist: {
      transport: "streamable_http",
      url: "https://todoist.example/mcp",
      oauthScopes: [],
    },
    github: {
      transport: "streamable_http",
      url: "https://github.example/mcp",
      oauthScopes: [],
    },
  };
  const access = new ProxyAccess();
  const builder = new McpWorkerLaunchConfigBuilder(mcpServers, access);
  const launchConfig = builder.build("task-1");

  assert.ok(launchConfig.codexConfigToml);
  const parsed = toml.parse(launchConfig.codexConfigToml) as {
    mcp_servers: Record<string, {
      url: string;
      bearer_token_env_var: string;
    }>;
  };

  assert.equal(parsed.mcp_servers["todoist"]?.url, `${mcpProxyWorkerBaseUrl}/mcp/tasks/task-1/servers/todoist`);
  assert.equal(parsed.mcp_servers["todoist"]?.bearer_token_env_var, workerProxyTokenEnvVar);
  assert.equal(parsed.mcp_servers["github"]?.url, `${mcpProxyWorkerBaseUrl}/mcp/tasks/task-1/servers/github`);
  assert.equal(parsed.mcp_servers["github"]?.bearer_token_env_var, workerProxyTokenEnvVar);
  assert.equal(parsed.mcp_servers[sandyMcpServerId]?.url, `${mcpProxyWorkerBaseUrl}/mcp/tasks/task-1/servers/${sandyMcpServerId}`);
  assert.ok(launchConfig.environment[workerProxyTokenEnvVar]);
  assert.deepEqual(access.validateWorkerGrant({
    taskId: "task-1",
    bearerToken: launchConfig.environment[workerProxyTokenEnvVar],
  }), { ok: true });
});

test("McpWorkerLaunchConfigBuilder exposes built-in and configured MCP servers", async () => {
  const mcpServers: Record<string, McpServerConfig> = {
    todoist: {
      transport: "streamable_http",
      url: "https://todoist.example/mcp",
      oauthScopes: [],
    },
    github: {
      transport: "streamable_http",
      url: "https://github.example/mcp",
      oauthScopes: [],
    },
  };
  const builder = new McpWorkerLaunchConfigBuilder(mcpServers, new ProxyAccess());
  const launchConfig = builder.build("task-1");

  assert.ok(launchConfig.codexConfigToml);
  const parsed = toml.parse(launchConfig.codexConfigToml) as {
    mcp_servers: Record<string, unknown>;
  };

  assert.deepEqual(Object.keys(parsed.mcp_servers).sort(), ["github", sandyMcpServerId, "todoist"]);
});
