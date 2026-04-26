import { z } from "zod";
import type { HttpTokenConfig, McpServerConfig } from "../config.js";
import { privilegeResolutionResultSchema } from "../types.js";

const streamableHttpServerSchema = z.object({
  transport: z.literal("streamable_http"),
  url: z.string().min(1),
  oauthScopes: z.array(z.string()),
});

const httpTokenConfigSchema = z.object({
  value: z.string().min(1),
  allowedHosts: z.array(z.string()),
});

const bootstrapMessageSchema = z.object({
  type: z.literal("bootstrap"),
  oauthStateDirectory: z.string().min(1),
  workerProxyTokenSecret: z.string().min(1),
  mcpServers: z.record(z.string(), streamableHttpServerSchema),
  httpTokens: z.record(z.string(), httpTokenConfigSchema).default({}),
});

const authorizationRequestMessageSchema = z.object({
  type: z.literal("authorization_request"),
  requestId: z.string().min(1),
  taskId: z.string().min(1),
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.unknown(),
});

const httpTokenAuthorizationRequestMessageSchema = z.object({
  type: z.literal("http_token_authorization_request"),
  requestId: z.string().min(1),
  taskId: z.string().min(1),
  tokenId: z.string().min(1),
  host: z.string().min(1),
});

const authorizationResultMessageSchema = z.object({
  type: z.literal("authorization_result"),
  requestId: z.string().min(1),
  result: privilegeResolutionResultSchema,
});

const httpTokenAuthorizationResultMessageSchema = z.object({
  type: z.literal("http_token_authorization_result"),
  requestId: z.string().min(1),
  result: privilegeResolutionResultSchema,
});

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

export type McpSidecarBootstrapMessage = z.infer<typeof bootstrapMessageSchema> & {
  mcpServers: Record<string, McpServerConfig>;
  httpTokens: Record<string, HttpTokenConfig>;
};
export type McpSidecarAuthorizationRequestMessage = z.infer<typeof authorizationRequestMessageSchema>;
export type McpSidecarHttpTokenAuthorizationRequestMessage = z.infer<typeof httpTokenAuthorizationRequestMessageSchema>;
type McpSidecarAuthorizationResultMessage = z.infer<typeof authorizationResultMessageSchema>;
type McpSidecarHttpTokenAuthorizationResultMessage = z.infer<typeof httpTokenAuthorizationResultMessageSchema>;
type McpSidecarReadyMessage = z.infer<typeof readyMessageSchema>;
type McpSidecarFatalErrorMessage = z.infer<typeof fatalErrorMessageSchema>;
export type McpSidecarLogMessage = z.infer<typeof logMessageSchema>;
type McpSidecarShutdownMessage = z.infer<typeof shutdownMessageSchema>;

type HostToMcpSidecarMessage =
  | McpSidecarBootstrapMessage
  | McpSidecarAuthorizationResultMessage
  | McpSidecarHttpTokenAuthorizationResultMessage
  | McpSidecarShutdownMessage;

type McpSidecarToHostMessage =
  | McpSidecarReadyMessage
  | McpSidecarAuthorizationRequestMessage
  | McpSidecarHttpTokenAuthorizationRequestMessage
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
    case "http_token_authorization_request":
      return httpTokenAuthorizationRequestMessageSchema.parse(parsed);
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
    case "http_token_authorization_result":
      return httpTokenAuthorizationResultMessageSchema.parse(parsed);
    case "shutdown":
      return shutdownMessageSchema.parse(parsed);
    default:
      throw new Error(`Unsupported host-to-sidecar message type ${(parsed as { type: string }).type}.`);
  }
}
