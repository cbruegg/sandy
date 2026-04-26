import { z } from "zod";

const proxyRequestHeaderSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
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

const authRequestMessageSchema = z.object({
  type: z.literal("auth_request"),
  requestId: z.string().min(1),
  proxyAuthUsername: z.string().min(1),
  proxyAuthPassword: z.string().min(1),
  targetHost: z.string().min(1),
  headers: z.array(proxyRequestHeaderSchema),
});

const approvedAuthResponseMessageSchema = z.object({
  type: z.literal("auth_response"),
  requestId: z.string().min(1),
  outcome: z.literal("approved"),
  headers: z.array(proxyRequestHeaderSchema),
});

const rejectedAuthResponseMessageSchema = z.object({
  type: z.literal("auth_response"),
  requestId: z.string().min(1),
  outcome: z.enum(["denied", "failed"]),
  message: z.string().min(1),
});

const authResponseMessageSchema = z.union([
  approvedAuthResponseMessageSchema,
  rejectedAuthResponseMessageSchema,
]);

type HttpProxyReadyMessage = z.infer<typeof readyMessageSchema>;
type HttpProxyFatalErrorMessage = z.infer<typeof fatalErrorMessageSchema>;
type HttpProxyLogMessage = z.infer<typeof logMessageSchema>;
export type HttpProxyAuthRequestMessage = z.infer<typeof authRequestMessageSchema>;
export type HttpProxyAuthResponseMessage = z.infer<typeof authResponseMessageSchema>;
export type HttpProxyRequestHeader = z.infer<typeof proxyRequestHeaderSchema>;

type HttpProxyContainerMessage =
  | HttpProxyReadyMessage
  | HttpProxyFatalErrorMessage
  | HttpProxyLogMessage
  | HttpProxyAuthRequestMessage;

type HttpProxyHostMessage = HttpProxyAuthResponseMessage;

export function parseHttpProxyContainerMessage(raw: string): HttpProxyContainerMessage {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
    throw new Error("Invalid HTTP proxy container message.");
  }

  switch ((parsed as { type: string }).type) {
    case "ready":
      return readyMessageSchema.parse(parsed);
    case "fatal_error":
      return fatalErrorMessageSchema.parse(parsed);
    case "log":
      return logMessageSchema.parse(parsed);
    case "auth_request":
      return authRequestMessageSchema.parse(parsed);
    default:
      throw new Error(`Unsupported HTTP proxy container message type ${(parsed as { type: string }).type}.`);
  }
}

export function serializeHttpProxyHostMessage(message: HttpProxyHostMessage): string {
  return `${JSON.stringify(authResponseMessageSchema.parse(message))}\n`;
}
