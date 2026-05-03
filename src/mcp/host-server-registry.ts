import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "../config.js";
import { logger } from "../logger.js";
import { buildStdioEnvironment } from "./stdio-server-registry.js";
import type { McpUpstreamMethod } from "./sidecar-protocol.js";

type ClientFactory = () => Client;
type TransportFactory = (config: Extract<McpServerConfig, { transport: "stdio" }>) => StdioClientTransport;

type ClientRecord = {
  client: Client;
};

export class HostMcpServerRegistry {
  private readonly clients = new Map<string, ClientRecord>();
  private started = false;

  constructor(
    private readonly mcpServers: Record<string, McpServerConfig>,
    private readonly options: {
      clientFactory?: ClientFactory;
      transportFactory?: TransportFactory;
    } = {},
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    try {
      for (const [serverId, config] of Object.entries(this.mcpServers)) {
        if (config.transport !== "stdio") {
          continue;
        }
        await this.getServer("startup", serverId);
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    for (const record of this.clients.values()) {
      await record.client.close();
    }
    this.clients.clear();
    this.started = false;
  }

  async execute(taskId: string, serverId: string, method: McpUpstreamMethod, params: unknown): Promise<unknown> {
    const server = await this.getServer(taskId, serverId);
    switch (method) {
      case "listTools":
        return await server.listTools(params as Parameters<Client["listTools"]>[0]);
      case "listResources":
        return await server.listResources(params as Parameters<Client["listResources"]>[0]);
      case "listResourceTemplates":
        return await server.listResourceTemplates(params as Parameters<Client["listResourceTemplates"]>[0]);
      case "readResource":
        return await server.readResource(params as Parameters<Client["readResource"]>[0]);
      case "listPrompts":
        return await server.listPrompts(params as Parameters<Client["listPrompts"]>[0]);
      case "getPrompt":
        return await server.getPrompt(params as Parameters<Client["getPrompt"]>[0]);
      case "callTool":
        return await server.callTool(params as Parameters<Client["callTool"]>[0]);
      default:
        assertNever(method);
    }
  }

  async getServer(taskId: string, serverId: string): Promise<Client> {
    const existing = this.clients.get(serverId);
    if (existing) {
      logger.debug("mcp.host_registry.server_reused", {
        serverId,
      });
      return existing.client;
    }

    const config = this.mcpServers[serverId];
    if (!config) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }
    if (config.transport !== "stdio") {
      throw new Error(`MCP server "${serverId}" does not use stdio.`);
    }

    logger.debug("mcp.host_registry.server_connecting", {
      taskId,
      serverId,
      command: config.command,
      workingDirectory: config.workingDirectory,
    });

    const client = this.options.clientFactory?.() ?? new Client({
      name: "Sandy",
      version: "1.0.0",
    });
    const transport = this.options.transportFactory?.(config) ?? new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.workingDirectory ?? undefined,
      env: buildStdioEnvironment(config.env),
    });

    await client.connect(transport);
    this.clients.set(serverId, {
      client,
    });

    logger.debug("mcp.host_registry.server_connected", {
      taskId,
      serverId,
      command: config.command,
      workingDirectory: config.workingDirectory,
    });

    return client;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected MCP upstream method: ${String(value)}`);
}
