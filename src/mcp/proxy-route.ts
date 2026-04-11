export const mcpProxyContainerAlias = "sandy-mcp-proxy";
const mcpProxyPort = 8080;

export type McpProxyRoute = {
  taskId: string;
  serverId: string;
};

export const mcpProxyWorkerBaseUrl = `http://${mcpProxyContainerAlias}:${mcpProxyPort}`;

export function buildMcpProxyPath(route: McpProxyRoute): string {
  return `/mcp/tasks/${encodeURIComponent(route.taskId)}/servers/${encodeURIComponent(route.serverId)}`;
}

export function buildMcpProxyWorkerUrl(
  route: McpProxyRoute,
  workerBaseUrl: string = mcpProxyWorkerBaseUrl,
): string {
  return `${workerBaseUrl}${buildMcpProxyPath(route)}`;
}

export function parseMcpProxyPath(pathname: string): McpProxyRoute | null {
  const match = /^\/mcp\/tasks\/([^/]+)\/servers\/([^/]+)$/.exec(pathname);
  if (!match) {
    return null;
  }
  const [, taskId, serverId] = match;
  if (!taskId || !serverId) {
    return null;
  }
  return {
    taskId: decodeURIComponent(taskId),
    serverId: decodeURIComponent(serverId),
  };
}
