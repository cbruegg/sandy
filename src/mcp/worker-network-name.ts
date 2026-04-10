import { randomUUID } from "node:crypto";

export function createMcpWorkerNetworkName(): string {
  return `sandy-mcp-${randomUUID()}`;
}
