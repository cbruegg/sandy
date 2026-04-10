import * as toml from "@iarna/toml";
import type { McpServerConfig } from "../config.js";
import { SandyMcpProxyAccess, mcpProxyWorkerBaseUrl, workerProxyTokenEnvVar } from "./proxy-access.js";

type McpWorkerLaunchConfig = {
  codexConfigToml: string | null;
  environment: Record<string, string>;
};

type WorkerServerRoute = {
  taskId: string;
  serverId: string;
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
          url: this.buildWorkerServerUrl(mcpProxyWorkerBaseUrl, { taskId, serverId }),
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

  private buildWorkerServerUrl(workerBaseUrl: string, route: WorkerServerRoute): string {
    return `${workerBaseUrl}/mcp/tasks/${encodeURIComponent(route.taskId)}/servers/${encodeURIComponent(route.serverId)}`;
  }
}
