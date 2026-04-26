import * as toml from "@iarna/toml";
import type { McpServerConfig } from "../config.js";
import { SandyMcpProxyAccess, mcpProxyWorkerBaseUrl, workerProxyTokenEnvVar } from "./proxy-access.js";
import { buildMcpProxyWorkerUrl } from "./proxy-route.js";

type McpWorkerLaunchConfig = {
  codexConfigToml: string | null;
  environment: Record<string, string>;
  httpProxyUrl: string | null;
};

export class McpWorkerLaunchConfigBuilder {
  private readonly serverIds: string[];

  constructor(
    mcpServers: Record<string, McpServerConfig>,
    private readonly access: SandyMcpProxyAccess,
    private readonly sidecarEnabled: boolean,
    private readonly httpTokensEnabled: boolean = false,
  ) {
    this.serverIds = Object.keys(mcpServers);
  }

  build(taskId: string): McpWorkerLaunchConfig {
    const config: McpWorkerLaunchConfig = {
      codexConfigToml: null,
      environment: {},
      httpProxyUrl: null,
    };

    if (this.serverIds.length > 0) {
      if (!this.sidecarEnabled) {
        throw new Error("MCP sidecar runtime is not configured.");
      }
      const mcpConfig = {
        mcp_servers: Object.fromEntries(
          this.serverIds.map((serverId) => [serverId, {
            url: buildMcpProxyWorkerUrl({ taskId, serverId }, mcpProxyWorkerBaseUrl),
            bearer_token_env_var: workerProxyTokenEnvVar,
          }]),
        ),
      };
      config.codexConfigToml = toml.stringify(mcpConfig);
      config.environment[workerProxyTokenEnvVar] = this.access.issueWorkerGrant(taskId).bearerToken;
    }

    if (this.httpTokensEnabled) {
      const jwt = this.access.issueWorkerGrant(taskId).bearerToken;
      const encodedJwt = encodeURIComponent(jwt);
      config.httpProxyUrl = `http://Bearer:${encodedJwt}@sandy-http-proxy:8081`;
    }

    return config;
  }
}
