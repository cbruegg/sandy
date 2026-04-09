import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import * as toml from "@iarna/toml";
import jwt from "jsonwebtoken";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../config.js";
import type { McpServerRegistry } from "./server-registry.js";
import type { PrivilegeResolutionResult } from "../types.js";

const workerProxyTokenEnvVar = "SANDY_MCP_PROXY_TOKEN";

type McpProxyTokenPayload = {
  taskId: string;
  serverIds: string[];
};

type ProxyRouteContext = {
  taskId: string;
  serverId: string;
};

type McpWorkerLaunchConfig = {
  codexConfigToml: string | null;
  environment: Record<string, string>;
};

type SandyMcpProxyOptions = {
  mcpServers: Record<string, McpServerConfig>;
  registry: McpServerRegistry;
  authorizeToolCall: (input: {
    taskId: string;
    serverId: string;
    toolName: string;
    arguments: unknown;
  }) => Promise<PrivilegeResolutionResult>;
  host?: string;
  workerBaseUrlHost?: string;
};

export class SandyMcpProxy {
  private readonly secret = randomBytes(32).toString("hex");
  private readonly sessions = new Map<string, {
    route: ProxyRouteContext;
    server: Server;
    transport: StreamableHTTPServerTransport;
  }>();
  private httpServer = createServer((req, res) => {
    void this.handleHttpRequest(req, res);
  });
  private port: number | null = null;
  private readonly host: string;
  private readonly workerBaseUrlHost: string;

  constructor(private readonly options: SandyMcpProxyOptions) {
    this.host = options.host ?? "0.0.0.0";
    this.workerBaseUrlHost = options.workerBaseUrlHost ?? "host.docker.internal";
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(0, this.host, () => {
        this.httpServer.off("error", reject);
        resolve();
      });
    });

    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine MCP proxy port.");
    }
    this.port = address.port;
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.transport.close();
    }
    this.sessions.clear();
    await this.options.registry.close();
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  buildWorkerLaunchConfig(taskId: string): McpWorkerLaunchConfig {
    if (Object.keys(this.options.mcpServers).length === 0) {
      return {
        codexConfigToml: null,
        environment: {},
      };
    }

    if (this.port === null) {
      throw new Error("MCP proxy must be started before building worker launch config.");
    }

    const token = jwt.sign({
      taskId,
      serverIds: Object.keys(this.options.mcpServers),
    } satisfies McpProxyTokenPayload, this.secret, {
      expiresIn: "1d",
    });
    const config = {
      mcp_servers: Object.fromEntries(
        Object.keys(this.options.mcpServers).map((serverId) => [serverId, {
          url: this.buildWorkerServerUrl(taskId, serverId),
          bearer_token_env_var: workerProxyTokenEnvVar,
        }]),
      ),
    };

    return {
      codexConfigToml: toml.stringify(config),
      environment: {
        [workerProxyTokenEnvVar]: token,
      },
    };
  }

  private buildWorkerServerUrl(taskId: string, serverId: string): string {
    if (this.port === null) {
      throw new Error("MCP proxy port is not available.");
    }
    return `http://${this.workerBaseUrlHost}:${this.port}/mcp/tasks/${encodeURIComponent(taskId)}/servers/${encodeURIComponent(serverId)}`;
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const route = matchProxyRoute(requestUrl.pathname);
    if (!route) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.statusCode = 401;
      res.end("Missing bearer token.");
      return;
    }

    try {
      const payload = jwt.verify(authHeader.slice("Bearer ".length), this.secret) as McpProxyTokenPayload;
      if (payload.taskId !== route.taskId || !payload.serverIds.includes(route.serverId)) {
        res.statusCode = 403;
        res.end("Bearer token does not grant access to this task or server.");
        return;
      }
    } catch (error) {
      res.statusCode = 401;
      res.end(error instanceof Error ? error.message : "Invalid bearer token.");
      return;
    }

    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    let session = sessionId ? this.sessions.get(sessionId) ?? null : null;
    if (session && !sameRoute(session.route, route)) {
      res.statusCode = 404;
      res.end("Unknown MCP session for this task or server.");
      return;
    }

    if (!session) {
      session = await this.createSession(route);
    }

    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : "Internal MCP proxy error.");
        return;
      }
      throw error;
    }
  }

  private createServer(route: ProxyRouteContext): Server {
    const server = new Server({
      name: "Sandy MCP Proxy",
      version: "1.0.0",
    });

    server.registerCapabilities({
      tools: {},
      resources: {},
      prompts: {},
    });

    const getClient = async () => this.options.registry.getClient(route.serverId);

    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      return (await getClient()).listTools(request.params);
    });
    server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      return (await getClient()).listResources(request.params);
    });
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      return (await getClient()).listResourceTemplates(request.params);
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return (await getClient()).readResource(request.params);
    });
    server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      return (await getClient()).listPrompts(request.params);
    });
    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return (await getClient()).getPrompt(request.params);
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const approval = await this.options.authorizeToolCall({
        taskId: route.taskId,
        serverId: route.serverId,
        toolName: request.params.name,
        arguments: request.params.arguments ?? {},
      });

      if (approval.outcome !== "approved") {
        return buildToolErrorResult(approval.message);
      }

      return (await getClient()).callTool(request.params);
    });

    return server;
  }

  private async createSession(route: ProxyRouteContext) {
    const server = this.createServer(route);
    let sessionId: string | null = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (createdSessionId) => {
        sessionId = createdSessionId;
        this.sessions.set(createdSessionId, {
          route,
          server,
          transport,
        });
      },
    });
    transport.onclose = () => {
      if (sessionId) {
        this.sessions.delete(sessionId);
      }
    };
    await server.connect(transport);
    return {
      route,
      server,
      transport,
    };
  }

}

function sameRoute(left: ProxyRouteContext, right: ProxyRouteContext): boolean {
  return left.taskId === right.taskId && left.serverId === right.serverId;
}

function matchProxyRoute(pathname: string): ProxyRouteContext | null {
  const match = /^\/mcp\/tasks\/([^/]+)\/servers\/([^/]+)$/.exec(pathname);
  if (!match) {
    return null;
  }
  return {
    taskId: decodeURIComponent(match[1]),
    serverId: decodeURIComponent(match[2]),
  };
}

function buildToolErrorResult(message: string): CallToolResult {
  return {
    content: [{
      type: "text",
      text: message,
    }],
    isError: true,
  };
}
