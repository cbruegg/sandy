import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { SandyMcpProxyAccess } from "./proxy-access.js";
import type { McpServerRegistry } from "./server-registry.js";
import type { PrivilegeResolutionResult } from "../types.js";

type ProxyRouteContext = {
  taskId: string;
  serverId: string;
};

type SandyMcpProxyOptions = {
  access: SandyMcpProxyAccess;
  registry: McpServerRegistry;
  authorizeToolCall: (input: {
    taskId: string;
    serverId: string;
    toolName: string;
    arguments: unknown;
  }) => Promise<PrivilegeResolutionResult>;
  host?: string;
  port?: number;
};

export class SandyMcpProxy {
  private readonly sessions = new Map<string, {
    route: ProxyRouteContext;
    server: McpServer;
    transport: StreamableHTTPServerTransport;
  }>();
  private httpServer = createServer((req, res) => {
    void this.handleHttpRequest(req, res);
  });
  private readonly host: string;
  private readonly port: number;

  constructor(private readonly options: SandyMcpProxyOptions) {
    this.host = options.host ?? "0.0.0.0";
    this.port = options.port ?? 0;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, this.host, () => {
        this.httpServer.off("error", reject);
        resolve();
      });
    });

    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine MCP proxy port.");
    }
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.server.close();
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

    const validation = this.options.access.validateWorkerGrant({
      taskId: route.taskId,
      bearerToken: authHeader.slice("Bearer ".length),
    });
    if (!validation.ok) {
      res.statusCode = validation.code === "invalid_token" ? 401 : 403;
      res.end(validation.message);
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

  private createServer(route: ProxyRouteContext): McpServer {
    const server = new McpServer({
      name: "Sandy MCP Proxy",
      version: "1.0.0",
    }, {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    });

    const getClient = async () => this.options.registry.getClient(route.serverId);

    server.server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      return (await getClient()).listTools(request.params);
    });
    server.server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
      return (await getClient()).listResources(request.params);
    });
    server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async (request) => {
      return (await getClient()).listResourceTemplates(request.params);
    });
    server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      return (await getClient()).readResource(request.params);
    });
    server.server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
      return (await getClient()).listPrompts(request.params);
    });
    server.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      return (await getClient()).getPrompt(request.params);
    });
    server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
