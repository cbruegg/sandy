import * as toml from "@iarna/toml";
import type { McpServerConfig } from "../config.js";
import { ProxyAccess } from "../proxy-access.js";
import { mcpProxyWorkerBaseUrl, workerProxyTokenEnvVar } from "./proxy-access.js";
import { buildMcpProxyWorkerUrl } from "./proxy-route.js";
import { sandyMcpServerId } from "../subagent/worker-tools.js";

type McpWorkerLaunchConfig = {
  codexConfigToml: string | null;
  environment: Record<string, string>;
};

export class McpWorkerLaunchConfigBuilder {
  private readonly serverIds: string[];

  constructor(
    mcpServers: Record<string, McpServerConfig>,
    private readonly access: ProxyAccess,
  ) {
    this.serverIds = Object.keys(mcpServers);
  }

  build(taskId: string): McpWorkerLaunchConfig {
    const serverIds = [sandyMcpServerId, ...this.serverIds];
    const config = {
      mcp_servers: Object.fromEntries(
        serverIds.map((serverId) => [serverId, {
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
