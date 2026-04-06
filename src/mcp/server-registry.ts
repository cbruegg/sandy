import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  CallToolRequest,
  GetPromptRequest,
  ListPromptsRequest,
  ListResourcesRequest,
  ListResourceTemplatesRequest,
  ListToolsRequest,
  ReadResourceRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "../config.js";
import { SandyOAuthClientProvider } from "./oauth-provider.js";
import { join } from "node:path";

type ClientRecord = {
  client: Client;
  transport: Transport;
};

export interface McpServerRegistry {
  listTools(serverId: string, params?: ListToolsRequest["params"]): Promise<Awaited<ReturnType<Client["listTools"]>>>;
  listResources(serverId: string, params?: ListResourcesRequest["params"]): Promise<Awaited<ReturnType<Client["listResources"]>>>;
  listResourceTemplates(
    serverId: string,
    params?: ListResourceTemplatesRequest["params"],
  ): Promise<Awaited<ReturnType<Client["listResourceTemplates"]>>>;
  readResource(serverId: string, params: ReadResourceRequest["params"]): Promise<Awaited<ReturnType<Client["readResource"]>>>;
  listPrompts(serverId: string, params?: ListPromptsRequest["params"]): Promise<Awaited<ReturnType<Client["listPrompts"]>>>;
  getPrompt(serverId: string, params: GetPromptRequest["params"]): Promise<Awaited<ReturnType<Client["getPrompt"]>>>;
  callTool(serverId: string, params: CallToolRequest["params"]): Promise<Awaited<ReturnType<Client["callTool"]>>>;
  close(): Promise<void>;
}

export class McpServerRegistryImpl implements McpServerRegistry {
  private readonly clients = new Map<string, ClientRecord>();

  constructor(
    private readonly configDirectory: string,
    private readonly mcpServers: Record<string, McpServerConfig>,
  ) {}

  async listTools(serverId: string, params?: ListToolsRequest["params"]) {
    return (await this.getClient(serverId)).listTools(params);
  }

  async listResources(serverId: string, params?: ListResourcesRequest["params"]) {
    return (await this.getClient(serverId)).listResources(params);
  }

  async listResourceTemplates(serverId: string, params?: ListResourceTemplatesRequest["params"]) {
    return (await this.getClient(serverId)).listResourceTemplates(params);
  }

  async readResource(serverId: string, params: ReadResourceRequest["params"]) {
    return (await this.getClient(serverId)).readResource(params);
  }

  async listPrompts(serverId: string, params?: ListPromptsRequest["params"]) {
    return (await this.getClient(serverId)).listPrompts(params);
  }

  async getPrompt(serverId: string, params: GetPromptRequest["params"]) {
    return (await this.getClient(serverId)).getPrompt(params);
  }

  async callTool(serverId: string, params: CallToolRequest["params"]) {
    return (await this.getClient(serverId)).callTool(params);
  }

  async close(): Promise<void> {
    for (const record of this.clients.values()) {
      await record.transport.close();
    }
    this.clients.clear();
  }

  private async getClient(serverId: string): Promise<Client> {
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
