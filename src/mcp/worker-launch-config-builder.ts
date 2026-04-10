import * as toml from "@iarna/toml";
import type { McpServerConfig } from "../config.js";
import { SandyMcpProxyAccess, workerProxyTokenEnvVar } from "./proxy-access.js";
import { McpProxyEndpointState } from "./proxy-endpoint-state.js";

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
    private readonly endpointState: McpProxyEndpointState,
  ) {
    this.serverIds = Object.keys(mcpServers);
  }

  async build(taskId: string): Promise<McpWorkerLaunchConfig> {
    if (this.serverIds.length === 0) {
      return {
        codexConfigToml: null,
        environment: {},
      };
    }

    const workerBaseUrl = await this.endpointState.getWorkerBaseUrl();
    const config = {
      mcp_servers: Object.fromEntries(
        this.serverIds.map((serverId) => [serverId, {
          url: this.buildWorkerServerUrl(workerBaseUrl, { taskId, serverId }),
          bearer_token_env_var: buildWorkerProxyTokenEnvVar(),
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

function buildWorkerProxyTokenEnvVar(): string {
  return workerProxyTokenEnvVar;
}
