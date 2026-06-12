import type { McpSidecarLayerInput, McpSidecarLayerResult } from "./types.js";
import { McpSidecarManager } from "../mcp/sidecar-manager.js";

export async function createMcpSidecarLayer(input: McpSidecarLayerInput): Promise<McpSidecarLayerResult> {
  const { config, controllerControlDir, workerNetworkName, orchestrator, hostMcpRegistry, proxyAccess } = input;

  const sidecarManager = new McpSidecarManager({
    configDirectory: config.configDirectory,
    mcpServers: config.mcpServers,
    workerNetworkName,
    sidecarImage: config.mcpSidecarImage,
    controllerControlDir,
    authorizeToolCall: orchestrator.authorizeMcpToolCall.bind(orchestrator),
    authorizeResourceRead: orchestrator.authorizeMcpResourceRead.bind(orchestrator),
    executeNativeToolCall: orchestrator.executeNativeWorkerToolCall.bind(orchestrator),
    executeUpstreamMcpRequest: async (input) => await hostMcpRegistry.execute(input.taskId, input.serverId, input.method, input.params),
  }, proxyAccess);

  await sidecarManager.start();

  const stop = async (): Promise<void> => {
    await sidecarManager.stop();
  };

  return {
    name: "mcp-sidecar",
    sidecarManager,
    stop,
  };
}