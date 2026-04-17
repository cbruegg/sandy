import { randomUUID } from "node:crypto";

export const mcpWorkerNetworkNamePrefix = "sandy-mcp-";

export function createMcpWorkerNetworkName(): string {
  return `${mcpWorkerNetworkNamePrefix}${randomUUID()}`;
}
