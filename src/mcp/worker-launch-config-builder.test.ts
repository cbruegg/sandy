import { test } from "bun:test";
import assert from "node:assert/strict";
import * as toml from "@iarna/toml";
import type { McpServerConfig } from "../config.js";
import { ProxyAccess } from "../proxy-access.js";
import { mcpProxyWorkerBaseUrl, workerProxyTokenEnvVar } from "./proxy-access.js";
import { McpWorkerLaunchConfigBuilder } from "./worker-launch-config-builder.js";

test("McpWorkerLaunchConfigBuilder returns an empty config when no MCP servers are enabled", async () => {
  const builder = new McpWorkerLaunchConfigBuilder(
    {},
    new ProxyAccess(),
    false,
  );

  assert.deepEqual(builder.build("task-1"), {
    codexConfigToml: null,
    environment: {},
  });
});

test("McpWorkerLaunchConfigBuilder throws when MCP servers are enabled without a sidecar", async () => {
  const builder = new McpWorkerLaunchConfigBuilder(
    {
      todoist: {
        transport: "streamable_http",
        url: "https://todoist.example/mcp",
        oauthScopes: [],
      },
    },
    new ProxyAccess(),
    false,
  );

  assert.throws(() => builder.build("task-1"), /MCP sidecar runtime is not configured/);
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
  const builder = new McpWorkerLaunchConfigBuilder(mcpServers, access, true);
  const launchConfig = builder.build("task-1");

  assert.ok(launchConfig.codexConfigToml);
  const parsed = toml.parse(launchConfig.codexConfigToml) as {
    mcp_servers: {
      todoist: {
        url: string;
        bearer_token_env_var: string;
      };
      github: {
        url: string;
        bearer_token_env_var: string;
      };
    };
  };

  assert.equal(parsed.mcp_servers.todoist.url, `${mcpProxyWorkerBaseUrl}/mcp/tasks/task-1/servers/todoist`);
  assert.equal(parsed.mcp_servers.todoist.bearer_token_env_var, workerProxyTokenEnvVar);
  assert.equal(parsed.mcp_servers.github.url, `${mcpProxyWorkerBaseUrl}/mcp/tasks/task-1/servers/github`);
  assert.equal(parsed.mcp_servers.github.bearer_token_env_var, workerProxyTokenEnvVar);
  assert.ok(launchConfig.environment[workerProxyTokenEnvVar]);
  assert.deepEqual(access.validateWorkerGrant({
    taskId: "task-1",
    bearerToken: launchConfig.environment[workerProxyTokenEnvVar],
  }), { ok: true });
});

test("McpWorkerLaunchConfigBuilder exposes all configured MCP servers", async () => {
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
  const builder = new McpWorkerLaunchConfigBuilder(mcpServers, new ProxyAccess(), true);
  const launchConfig = builder.build("task-1");

  assert.ok(launchConfig.codexConfigToml);
  const parsed = toml.parse(launchConfig.codexConfigToml) as {
    mcp_servers: Record<string, unknown>;
  };

  assert.deepEqual(Object.keys(parsed.mcp_servers).sort(), ["github", "todoist"]);
});
