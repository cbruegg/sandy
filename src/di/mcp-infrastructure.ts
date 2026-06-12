import type { McpInfrastructureLayerInput, McpInfrastructureLayerResult } from "./types.js";
import { HostMcpServerRegistry } from "../mcp/host-server-registry.js";
import { McpWorkerLaunchConfigBuilder } from "../mcp/worker-launch-config-builder.js";
import { createMcpWorkerNetworkName } from "../mcp/worker-network-name.js";

export async function createMcpInfrastructureLayer(input: McpInfrastructureLayerInput): Promise<McpInfrastructureLayerResult> {
  const { config, proxyAccess } = input;

  const hostMcpRegistry = new HostMcpServerRegistry(config.mcpServers);
  await hostMcpRegistry.start();

  const mcpWorkerLaunchConfigBuilder = new McpWorkerLaunchConfigBuilder(
    config.mcpServers,
    proxyAccess,
  );

  const workerNetworkName = createMcpWorkerNetworkName();

  const stop = async (): Promise<void> => {
    await hostMcpRegistry.close();
  };

  return {
    name: "mcp-infrastructure",
    hostMcpRegistry,
    mcpWorkerLaunchConfigBuilder,
    workerNetworkName,
    stop,
  };
}