import { z } from "zod";

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

type HttpProxyReadyMessage = z.infer<typeof readyMessageSchema>;
type HttpProxyFatalErrorMessage = z.infer<typeof fatalErrorMessageSchema>;
type HttpProxyLogMessage = z.infer<typeof logMessageSchema>;

type HttpProxyContainerMessage =
  | HttpProxyReadyMessage
  | HttpProxyFatalErrorMessage
  | HttpProxyLogMessage;

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
    default:
      throw new Error(`Unsupported HTTP proxy container message type ${(parsed as { type: string }).type}.`);
  }
}
