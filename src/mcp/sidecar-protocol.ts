import { z } from "zod";
import type { McpServerConfig } from "../config.js";
import { privilegeResolutionResultSchema } from "../types.js";

const streamableHttpServerSchema = z.object({
  transport: z.literal("streamable_http"),
  url: z.string().min(1),
  oauthScopes: z.array(z.string()),
});

const stdioServerSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1).nullable(),
  env: z.record(z.string(), z.string()),
});

const mcpUpstreamMethodSchema = z.enum([
  "listTools",
  "listResources",
  "listResourceTemplates",
  "readResource",
  "listPrompts",
  "getPrompt",
  "callTool",
]);

const bootstrapMessageSchema = z.object({
  type: z.literal("bootstrap"),
  oauthStateDirectory: z.string().min(1),
  workerProxyTokenSecret: z.string().min(1),
  mcpServers: z.record(z.string(), z.discriminatedUnion("transport", [
    streamableHttpServerSchema,
    stdioServerSchema,
  ])),
});

const authorizationRequestMessageSchema = z.object({
  type: z.literal("authorization_request"),
  requestId: z.string().min(1),
  taskId: z.string().min(1),
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.unknown(),
});

const resourceAuthorizationRequestMessageSchema = z.object({
  type: z.literal("resource_authorization_request"),
  requestId: z.string().min(1),
  taskId: z.string().min(1),
  serverId: z.string().min(1),
  uri: z.string().min(1),
});

const authorizationResultMessageSchema = z.object({
  type: z.literal("authorization_result"),
  requestId: z.string().min(1),
  result: privilegeResolutionResultSchema,
});

const nativeToolCallRequestMessageSchema = z.object({
  type: z.literal("native_tool_call_request"),
  requestId: z.string().min(1),
  taskId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.unknown(),
});

const nativeToolCallResultMessageSchema = z.object({
  type: z.literal("native_tool_call_result"),
  requestId: z.string().min(1),
  isError: z.boolean(),
  message: z.string(),
});

const upstreamRequestMessageSchema = z.object({
  type: z.literal("upstream_request"),
  requestId: z.string().min(1),
  taskId: z.string().min(1),
  serverId: z.string().min(1),
  method: mcpUpstreamMethodSchema,
  params: z.unknown(),
});

const upstreamResultMessageSchema = z.discriminatedUnion("ok", [
  z.object({
    type: z.literal("upstream_result"),
    requestId: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal("upstream_result"),
    requestId: z.string().min(1),
    ok: z.literal(false),
    errorMessage: z.string().min(1),
  }),
]);

const readyMessageSchema = z.object({
  type: z.literal("ready"),
});

const fatalErrorMessageSchema = z.object({
  type: z.literal("fatal_error"),
  message: z.string().min(1),
});

const logMessageSchema = z.object({
  type: z.literal("log"),
  timestamp: z.string().min(1),
  level: z.enum(["debug", "info", "warn", "error"]),
  event: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
});

const shutdownMessageSchema = z.object({
  type: z.literal("shutdown"),
});

const releaseTaskMessageSchema = z.object({
  type: z.literal("release_task"),
  taskId: z.string().min(1),
});

export type McpSidecarBootstrapMessage = z.infer<typeof bootstrapMessageSchema> & {
  mcpServers: Record<string, McpServerConfig>;
};
export type McpUpstreamMethod = z.infer<typeof mcpUpstreamMethodSchema>;
export type McpSidecarAuthorizationRequestMessage = z.infer<typeof authorizationRequestMessageSchema>;
export type McpSidecarResourceAuthorizationRequestMessage = z.infer<typeof resourceAuthorizationRequestMessageSchema>;
export type McpSidecarNativeToolCallRequestMessage = z.infer<typeof nativeToolCallRequestMessageSchema>;
export type McpSidecarUpstreamRequestMessage = z.infer<typeof upstreamRequestMessageSchema>;
type McpSidecarAuthorizationResultMessage = z.infer<typeof authorizationResultMessageSchema>;
type McpSidecarNativeToolCallResultMessage = z.infer<typeof nativeToolCallResultMessageSchema>;
export type McpSidecarUpstreamResultMessage = z.infer<typeof upstreamResultMessageSchema>;
type McpSidecarReadyMessage = z.infer<typeof readyMessageSchema>;
type McpSidecarFatalErrorMessage = z.infer<typeof fatalErrorMessageSchema>;
export type McpSidecarLogMessage = z.infer<typeof logMessageSchema>;
type McpSidecarShutdownMessage = z.infer<typeof shutdownMessageSchema>;
type McpSidecarReleaseTaskMessage = z.infer<typeof releaseTaskMessageSchema>;

type HostToMcpSidecarMessage =
  | McpSidecarBootstrapMessage
  | McpSidecarAuthorizationResultMessage
  | McpSidecarNativeToolCallResultMessage
  | McpSidecarUpstreamResultMessage
  | McpSidecarReleaseTaskMessage
  | McpSidecarShutdownMessage;

type McpSidecarToHostMessage =
  | McpSidecarReadyMessage
  | McpSidecarAuthorizationRequestMessage
  | McpSidecarResourceAuthorizationRequestMessage
  | McpSidecarNativeToolCallRequestMessage
  | McpSidecarUpstreamRequestMessage
  | McpSidecarFatalErrorMessage
  | McpSidecarLogMessage;

export function parseMcpSidecarToHostMessage(raw: string): McpSidecarToHostMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
    throw new Error("Invalid sidecar control message.");
  }

  switch ((parsed as { type: string }).type) {
    case "ready":
      return readyMessageSchema.parse(parsed);
    case "authorization_request":
      return authorizationRequestMessageSchema.parse(parsed);
    case "resource_authorization_request":
      return resourceAuthorizationRequestMessageSchema.parse(parsed);
    case "native_tool_call_request":
      return nativeToolCallRequestMessageSchema.parse(parsed);
    case "upstream_request":
      return upstreamRequestMessageSchema.parse(parsed);
    case "fatal_error":
      return fatalErrorMessageSchema.parse(parsed);
    case "log":
      return logMessageSchema.parse(parsed);
    default:
      throw new Error(`Unsupported sidecar control message type ${(parsed as { type: string }).type}.`);
  }
}

export function parseHostToMcpSidecarMessage(raw: string): HostToMcpSidecarMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
    throw new Error("Invalid host-to-sidecar message.");
  }

  switch ((parsed as { type: string }).type) {
    case "bootstrap":
      return bootstrapMessageSchema.parse(parsed);
    case "authorization_result":
      return authorizationResultMessageSchema.parse(parsed);
    case "native_tool_call_result":
      return nativeToolCallResultMessageSchema.parse(parsed);
    case "upstream_result":
      return upstreamResultMessageSchema.parse(parsed);
    case "shutdown":
      return shutdownMessageSchema.parse(parsed);
    case "release_task":
      return releaseTaskMessageSchema.parse(parsed);
    default:
      throw new Error(`Unsupported host-to-sidecar message type ${(parsed as { type: string }).type}.`);
  }
}
