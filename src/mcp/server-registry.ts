import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "../config.js";
import { logger } from "../logger.js";
import { SandyOAuthClientProvider } from "./oauth-provider.js";
import { join } from "node:path";

type ClientRecord = {
  client: Client;
  transport: Transport;
};

export interface McpServerRegistry {
  getClient(serverId: string): Promise<Client>;
  close(): Promise<void>;
}

export class McpServerRegistryImpl implements McpServerRegistry {
  private readonly clients = new Map<string, ClientRecord>();

  constructor(
    private readonly oauthStateDirectory: string,
    private readonly mcpServers: Record<string, McpServerConfig>,
  ) {}

  async close(): Promise<void> {
    for (const record of this.clients.values()) {
      await record.transport.close();
    }
    this.clients.clear();
  }

  async getClient(serverId: string): Promise<Client> {
    const existing = this.clients.get(serverId);
    if (existing) {
      logger.debug("mcp.registry.client_reused", {
        serverId,
      });
      return existing.client;
    }

    const config = this.mcpServers[serverId];
    if (!config) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }

    const client = new Client({
      name: "Sandy",
      version: "1.0.0",
    });
    const transport = this.createTransport(serverId, config);
    logger.debug("mcp.registry.client_connecting", {
      serverId,
      url: config.url,
      oauthStatePath: join(this.oauthStateDirectory, `${serverId}.json`),
    });
    await client.connect(transport);
    this.clients.set(serverId, {
      client,
      transport,
    });
    logger.debug("mcp.registry.client_connected", {
      serverId,
      url: config.url,
    });
    return client;
  }

  private createTransport(serverId: string, config: McpServerConfig): Transport {
    const provider = new SandyOAuthClientProvider({
      stateFilePath: join(this.oauthStateDirectory, `${serverId}.json`),
      interactive: false,
      configuredServerUrl: config.url,
    });
    return new StreamableHTTPClientTransport(new URL(config.url), {
      authProvider: provider,
    });
  }
}
