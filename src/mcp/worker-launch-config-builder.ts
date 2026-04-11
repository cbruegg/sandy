import * as toml from "@iarna/toml";
import type { McpServerConfig } from "../config.js";
import { SandyMcpProxyAccess, mcpProxyWorkerBaseUrl, workerProxyTokenEnvVar } from "./proxy-access.js";
import { buildMcpProxyWorkerUrl } from "./proxy-route.js";

type McpWorkerLaunchConfig = {
  codexConfigToml: string | null;
  environment: Record<string, string>;
};

export class McpWorkerLaunchConfigBuilder {
  private readonly serverIds: string[];

  constructor(
    mcpServers: Record<string, McpServerConfig>,
    private readonly access: SandyMcpProxyAccess,
    private readonly sidecarEnabled: boolean,
  ) {
    this.serverIds = Object.keys(mcpServers);
  }

  build(taskId: string): McpWorkerLaunchConfig {
    if (this.serverIds.length === 0) {
      return {
        codexConfigToml: null,
        environment: {},
      };
    }

    if (!this.sidecarEnabled) {
      throw new Error("MCP sidecar runtime is not configured.");
    }
    const config = {
      mcp_servers: Object.fromEntries(
        this.serverIds.map((serverId) => [serverId, {
          url: buildMcpProxyWorkerUrl({ taskId, serverId }, mcpProxyWorkerBaseUrl),
          bearer_token_env_var: workerProxyTokenEnvVar,
        }]),
      ),
    };

    return {
      codexConfigToml: toml.stringify(config),
      environment: {
        [workerProxyTokenEnvVar]: this.access.issueWorkerGrant(taskId).bearerToken,
      },
    };
  }
}
