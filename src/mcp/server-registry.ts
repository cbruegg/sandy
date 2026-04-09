import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "../config.js";
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
    private readonly configDirectory: string,
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
    await client.connect(transport);
    this.clients.set(serverId, {
      client,
      transport,
    });
    return client;
  }

  private createTransport(serverId: string, config: McpServerConfig): Transport {
    if (config.transport === "streamable_http") {
      if (!config.url) {
        throw new Error(`MCP server "${serverId}" is missing its url.`);
      }

      const provider = new SandyOAuthClientProvider({
        stateFilePath: join(this.configDirectory, "oauth", `${serverId}.json`),
        interactive: false,
      });
      return new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider: provider,
      });
    }

    if (!config.command) {
      throw new Error(`MCP server "${serverId}" is missing its command.`);
    }

    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      stderr: "pipe",
    });
  }
}
