import { z } from "zod";

const proxyAuthRequestSchema = z.object({
  taskId: z.string().min(1),
  tokenId: z.string().min(1),
  host: z.string().min(1),
});

const proxyAuthResponseSchema = z.object({
  outcome: z.enum(["approved", "denied", "failed"]),
  message: z.string().min(1),
});

export type ProxyAuthRequest = z.infer<typeof proxyAuthRequestSchema>;
export type ProxyAuthResponse = z.infer<typeof proxyAuthResponseSchema>;

export function parseProxyAuthRequest(raw: string): ProxyAuthRequest {
  return proxyAuthRequestSchema.parse(JSON.parse(raw) as unknown);
}

export function parseProxyAuthResponse(raw: string): ProxyAuthResponse {
  return proxyAuthResponseSchema.parse(JSON.parse(raw) as unknown);
}

export function serializeProxyAuthRequest(message: ProxyAuthRequest): string {
  return `${JSON.stringify(proxyAuthRequestSchema.parse(message))}\n`;
}

export function serializeProxyAuthResponse(message: ProxyAuthResponse): string {
  return `${JSON.stringify(proxyAuthResponseSchema.parse(message))}\n`;
}
