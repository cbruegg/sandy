import test from "node:test";
import assert from "node:assert/strict";
import * as toml from "@iarna/toml";
import type { McpServerConfig } from "../config.js";
import { SandyMcpProxyAccess, workerProxyTokenEnvVar } from "./proxy-access.js";
import { McpProxyEndpointState } from "./proxy-endpoint-state.js";
import { McpWorkerLaunchConfigBuilder } from "./worker-launch-config-builder.js";

test("McpWorkerLaunchConfigBuilder returns an empty config when no MCP servers are enabled", async () => {
  const builder = new McpWorkerLaunchConfigBuilder(
    {},
    new SandyMcpProxyAccess(),
    new McpProxyEndpointState(),
  );

  assert.deepEqual(await builder.build("task-1"), {
    codexConfigToml: null,
    environment: {},
  });
});

test("McpWorkerLaunchConfigBuilder waits for a ready proxy endpoint when MCP servers are enabled", async () => {
  const endpointState = new McpProxyEndpointState();
  const builder = new McpWorkerLaunchConfigBuilder(
    {
      todoist: {
        transport: "streamable_http",
        url: "https://todoist.example/mcp",
        command: null,
        args: [],
        env: {},
        oauthScopes: [],
      },
    },
    new SandyMcpProxyAccess(),
    endpointState,
  );

  const pendingBuild = builder.build("task-1");
  endpointState.setWorkerBaseUrl("http://127.0.0.1:43123");

  const launchConfig = await pendingBuild;
  assert.ok(launchConfig.codexConfigToml);
});

test("McpWorkerLaunchConfigBuilder builds worker TOML and env from access data", async () => {
  const mcpServers: Record<string, McpServerConfig> = {
    todoist: {
      transport: "streamable_http",
      url: "https://todoist.example/mcp",
      command: null,
      args: [],
      env: {},
      oauthScopes: [],
    },
    github: {
      transport: "streamable_http",
      url: "https://github.example/mcp",
      command: null,
      args: [],
      env: {},
      oauthScopes: [],
    },
  };
  const access = new SandyMcpProxyAccess();
  const endpointState = new McpProxyEndpointState();
  endpointState.setWorkerBaseUrl("http://127.0.0.1:43123");

  const builder = new McpWorkerLaunchConfigBuilder(mcpServers, access, endpointState);
  const launchConfig = await builder.build("task-1");

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

  assert.equal(parsed.mcp_servers.todoist.url, "http://127.0.0.1:43123/mcp/tasks/task-1/servers/todoist");
  assert.equal(parsed.mcp_servers.todoist.bearer_token_env_var, workerProxyTokenEnvVar);
  assert.equal(parsed.mcp_servers.github.url, "http://127.0.0.1:43123/mcp/tasks/task-1/servers/github");
  assert.equal(parsed.mcp_servers.github.bearer_token_env_var, workerProxyTokenEnvVar);
  assert.ok(launchConfig.environment[workerProxyTokenEnvVar]);
  assert.deepEqual(access.validateWorkerGrant({
    taskId: "task-1",
    bearerToken: launchConfig.environment[workerProxyTokenEnvVar],
  }), { ok: true });
  assert.deepEqual(access.validateWorkerGrant({
    taskId: "task-1",
    bearerToken: launchConfig.environment[workerProxyTokenEnvVar],
  }), { ok: true });
});
