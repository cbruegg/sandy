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
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../logger.js";
import { ProxyAccess } from "../proxy-access.js";
import { parseMcpProxyPath, type McpProxyRoute } from "./proxy-route.js";
import type { McpServerRegistry } from "./server-registry.js";
import {
  parseWorkerToolPayload,
  sandyMcpServerId,
  workerToolEntries,
} from "../subagent/worker-tools.js";
import type {
  AuthorizeMcpResourceRead,
  AuthorizeMcpToolCall,
  ExecuteNativeToolCall,
} from "./proxy-contract.js";

type SandyMcpProxyOptions = {
  access: ProxyAccess;
  registry: McpServerRegistry;
  authorizeToolCall: AuthorizeMcpToolCall;
  authorizeResourceRead: AuthorizeMcpResourceRead;
  executeNativeToolCall: ExecuteNativeToolCall;
  host?: string;
  port?: number;
};

export class SandyMcpProxy {
  private readonly sessions = new Map<string, {
    route: McpProxyRoute;
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
    const route = parseMcpProxyPath(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    if (!route) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    logger.debug("mcp.proxy.request_received", {
      method: req.method ?? "UNKNOWN",
      taskId: route.taskId,
      serverId: route.serverId,
      sessionId: typeof req.headers["mcp-session-id"] === "string"
        ? req.headers["mcp-session-id"]
        : Array.isArray(req.headers["mcp-session-id"])
          ? req.headers["mcp-session-id"][0] ?? null
          : null,
    });

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      logger.debug("mcp.proxy.request_rejected_missing_bearer", {
        taskId: route.taskId,
        serverId: route.serverId,
      });
      res.statusCode = 401;
      res.end("Missing bearer token.");
      return;
    }

    const validation = this.options.access.validateWorkerGrant({
      taskId: route.taskId,
      bearerToken: authHeader.slice("Bearer ".length),
    });
    if (!validation.ok) {
      logger.debug("mcp.proxy.request_rejected_invalid_grant", {
        taskId: route.taskId,
        serverId: route.serverId,
        code: validation.code,
        message: validation.message,
      });
      res.statusCode = validation.code === "invalid_token" ? 401 : 403;
      res.end(validation.message);
      return;
    }

    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    let session = sessionId ? this.sessions.get(sessionId) ?? null : null;
    if (session && !sameRoute(session.route, route)) {
      logger.debug("mcp.proxy.request_rejected_session_route_mismatch", {
        sessionId,
        taskId: route.taskId,
        serverId: route.serverId,
      });
      res.statusCode = 404;
      res.end("Unknown MCP session for this task or server.");
      return;
    }

    if (!session) {
      logger.debug("mcp.proxy.session_creating", {
        taskId: route.taskId,
        serverId: route.serverId,
      });
      session = await this.createSession(route);
    } else {
      logger.debug("mcp.proxy.session_reused", {
        sessionId,
        taskId: route.taskId,
        serverId: route.serverId,
      });
    }

    try {
      await session.transport.handleRequest(req, res);
      logger.debug("mcp.proxy.request_handled", {
        taskId: route.taskId,
        serverId: route.serverId,
        sessionId: sessionId ?? null,
        statusCode: res.statusCode,
      });
    } catch (error) {
      logger.warn("mcp.proxy.request_failed", {
        taskId: route.taskId,
        serverId: route.serverId,
        sessionId: sessionId ?? null,
        message: error instanceof Error ? error.message : "Internal MCP proxy error.",
      });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : "Internal MCP proxy error.");
        return;
      }
      throw error;
    }
  }

  private createServer(route: McpProxyRoute): McpServer {
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

    if (route.serverId === sandyMcpServerId) {
      this.configureBuiltInSandyServer(server, route);
      return server;
    }

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
      const approval = await this.options.authorizeResourceRead({
        taskId: route.taskId,
        serverId: route.serverId,
        uri: request.params.uri,
      });

      if (approval.outcome !== "approved") {
        return buildResourceErrorResult(approval.message);
      }

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

  private configureBuiltInSandyServer(server: McpServer, route: McpProxyRoute): void {
    server.server.setRequestHandler(ListToolsRequestSchema, () => Promise.resolve(buildNativeToolListResult()));
    server.server.setRequestHandler(ListResourcesRequestSchema, () => Promise.resolve({ resources: [] }));
    server.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => Promise.resolve({ resourceTemplates: [] }));
    server.server.setRequestHandler(ListPromptsRequestSchema, () => Promise.resolve({ prompts: [] }));
    server.server.setRequestHandler(GetPromptRequestSchema, () => {
      throw new Error(`MCP server ${sandyMcpServerId} does not expose prompts.`);
    });
    server.server.setRequestHandler(ReadResourceRequestSchema, () => Promise.resolve(buildResourceErrorResult(`MCP server ${sandyMcpServerId} does not expose resources.`)));
    server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        parseWorkerToolPayload(request.params.name, request.params.arguments ?? {});
      } catch (error) {
        return buildToolErrorResult(error instanceof Error ? error.message : "Invalid Sandy tool arguments.");
      }

      const result = await this.options.executeNativeToolCall({
        taskId: route.taskId,
        toolName: request.params.name,
        arguments: request.params.arguments ?? {},
      });

      return buildToolTextResult(result.message, result.isError);
    });
  }

  private async createSession(route: McpProxyRoute) {
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
        logger.debug("mcp.proxy.session_initialized", {
          sessionId: createdSessionId,
          taskId: route.taskId,
          serverId: route.serverId,
        });
      },
    });
    transport.onclose = () => {
      if (sessionId) {
        this.sessions.delete(sessionId);
        logger.debug("mcp.proxy.session_closed", {
          sessionId,
          taskId: route.taskId,
          serverId: route.serverId,
        });
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

function sameRoute(left: McpProxyRoute, right: McpProxyRoute): boolean {
  return left.taskId === right.taskId && left.serverId === right.serverId;
}

function buildToolErrorResult(message: string): CallToolResult {
  return buildToolTextResult(message, true);
}

function buildToolTextResult(message: string, isError: boolean): CallToolResult {
  return {
    content: [{
      type: "text",
      text: message,
    }],
    isError,
  };
}

function buildNativeToolListResult() {
  return {
    tools: workerToolEntries.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    })),
  };
}

function buildResourceErrorResult(message: string): ReadResourceResult {
  return {
    contents: [{
      uri: "error://sandy/denied",
      text: message,
    }],
  };
}
