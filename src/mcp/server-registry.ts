import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { join } from "node:path";
import type { McpServerConfig } from "../config.js";
import { logger } from "../logger.js";
import { SandyOAuthClientProvider } from "./oauth-provider.js";
import type { McpUpstreamMethod } from "./sidecar-protocol.js";

export interface McpUpstreamServer {
  listTools(params: Parameters<Client["listTools"]>[0]): ReturnType<Client["listTools"]>;
  listResources(params: Parameters<Client["listResources"]>[0]): ReturnType<Client["listResources"]>;
  listResourceTemplates(params: Parameters<Client["listResourceTemplates"]>[0]): ReturnType<Client["listResourceTemplates"]>;
  readResource(params: Parameters<Client["readResource"]>[0]): ReturnType<Client["readResource"]>;
  listPrompts(params: Parameters<Client["listPrompts"]>[0]): ReturnType<Client["listPrompts"]>;
  getPrompt(params: Parameters<Client["getPrompt"]>[0]): ReturnType<Client["getPrompt"]>;
  callTool(params: Parameters<Client["callTool"]>[0]): ReturnType<Client["callTool"]>;
  close(): Promise<void>;
}

export interface McpServerRegistry {
  getServer(taskId: string, serverId: string): Promise<McpUpstreamServer>;
  close(): Promise<void>;
}

type RequestHostMcp = (request: {
  taskId: string;
  serverId: string;
  method: McpUpstreamMethod;
  params: unknown;
}) => Promise<unknown>;

type ClientRecord = {
  server: McpUpstreamServer;
};

export class McpServerRegistryImpl implements McpServerRegistry {
  private readonly servers = new Map<string, ClientRecord>();

  constructor(
    private readonly oauthStateDirectory: string,
    private readonly mcpServers: Record<string, McpServerConfig>,
    private readonly requestHostMcp: RequestHostMcp,
  ) {}

  async close(): Promise<void> {
    for (const record of this.servers.values()) {
      await record.server.close();
    }
    this.servers.clear();
  }

  async getServer(taskId: string, serverId: string): Promise<McpUpstreamServer> {
    const config = this.mcpServers[serverId];
    if (!config) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }

    const cacheKey = config.transport === "stdio" ? `${taskId}:${serverId}` : serverId;
    const existing = this.servers.get(cacheKey);
    if (existing) {
      logger.debug("mcp.registry.server_reused", {
        taskId,
        serverId,
      });
      return existing.server;
    }

    logger.debug("mcp.registry.server_connecting", {
      taskId,
      serverId,
      transport: config.transport,
      oauthStatePath: join(this.oauthStateDirectory, `${serverId}.json`),
    });

    const server = config.transport === "streamable_http"
      ? await this.createHttpServer(serverId, config)
      : this.createStdioDelegatedServer(taskId, serverId);

    this.servers.set(cacheKey, {
      server,
    });

    logger.debug("mcp.registry.server_ready", {
      taskId,
      serverId,
      transport: config.transport,
    });

    return server;
  }

  private async createHttpServer(serverId: string, config: Extract<McpServerConfig, { transport: "streamable_http" }>): Promise<McpUpstreamServer> {
    const client = new Client({
      name: "Sandy",
      version: "1.0.0",
    });
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      authProvider: new SandyOAuthClientProvider({
        stateFilePath: join(this.oauthStateDirectory, `${serverId}.json`),
        interactive: false,
        configuredServerUrl: config.url,
      }),
    });

    await client.connect(transport);
    return new HttpClientUpstreamServer(client);
  }

  private createStdioDelegatedServer(taskId: string, serverId: string): McpUpstreamServer {
    return new DelegatedUpstreamServer(taskId, serverId, this.requestHostMcp);
  }
}

class HttpClientUpstreamServer implements McpUpstreamServer {
  constructor(private readonly client: Client) {}

  listTools(params: Parameters<Client["listTools"]>[0]): ReturnType<Client["listTools"]> {
    return this.client.listTools(params);
  }

  listResources(params: Parameters<Client["listResources"]>[0]): ReturnType<Client["listResources"]> {
    return this.client.listResources(params);
  }

  listResourceTemplates(params: Parameters<Client["listResourceTemplates"]>[0]): ReturnType<Client["listResourceTemplates"]> {
    return this.client.listResourceTemplates(params);
  }

  readResource(params: Parameters<Client["readResource"]>[0]): ReturnType<Client["readResource"]> {
    return this.client.readResource(params);
  }

  listPrompts(params: Parameters<Client["listPrompts"]>[0]): ReturnType<Client["listPrompts"]> {
    return this.client.listPrompts(params);
  }

  getPrompt(params: Parameters<Client["getPrompt"]>[0]): ReturnType<Client["getPrompt"]> {
    return this.client.getPrompt(params);
  }

  callTool(params: Parameters<Client["callTool"]>[0]): ReturnType<Client["callTool"]> {
    return this.client.callTool(params);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class DelegatedUpstreamServer implements McpUpstreamServer {
  constructor(
    private readonly taskId: string,
    private readonly serverId: string,
    private readonly requestHostMcp: RequestHostMcp,
  ) {}

  listTools(params: Parameters<Client["listTools"]>[0]): Promise<Awaited<ReturnType<Client["listTools"]>>> {
    return this.request("listTools", params) as ReturnType<Client["listTools"]>;
  }

  listResources(params: Parameters<Client["listResources"]>[0]): Promise<Awaited<ReturnType<Client["listResources"]>>> {
    return this.request("listResources", params) as ReturnType<Client["listResources"]>;
  }

  listResourceTemplates(params: Parameters<Client["listResourceTemplates"]>[0]): Promise<Awaited<ReturnType<Client["listResourceTemplates"]>>> {
    return this.request("listResourceTemplates", params) as ReturnType<Client["listResourceTemplates"]>;
  }

  readResource(params: Parameters<Client["readResource"]>[0]): Promise<Awaited<ReturnType<Client["readResource"]>>> {
    return this.request("readResource", params) as ReturnType<Client["readResource"]>;
  }

  listPrompts(params: Parameters<Client["listPrompts"]>[0]): Promise<Awaited<ReturnType<Client["listPrompts"]>>> {
    return this.request("listPrompts", params) as ReturnType<Client["listPrompts"]>;
  }

  getPrompt(params: Parameters<Client["getPrompt"]>[0]): Promise<Awaited<ReturnType<Client["getPrompt"]>>> {
    return this.request("getPrompt", params) as ReturnType<Client["getPrompt"]>;
  }

  callTool(params: Parameters<Client["callTool"]>[0]): Promise<Awaited<ReturnType<Client["callTool"]>>> {
    return this.request("callTool", params) as ReturnType<Client["callTool"]>;
  }

  async close(): Promise<void> {}

  private async request(method: McpUpstreamMethod, params: unknown): Promise<unknown> {
    return await this.requestHostMcp({
      taskId: this.taskId,
      serverId: this.serverId,
      method,
      params,
    });
  }
}
