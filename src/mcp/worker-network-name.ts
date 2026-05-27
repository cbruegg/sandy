import { randomUUID } from "node:crypto";

const mcpWorkerNetworkNamePrefix = "sandy-mcp-";

export function createMcpWorkerNetworkName(): string {
  return `${mcpWorkerNetworkNamePrefix}${randomUUID()}`;
}
