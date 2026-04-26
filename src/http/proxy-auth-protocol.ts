import { z } from "zod";

const proxyRequestHeaderSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
});

const proxyAuthRequestSchema = z.object({
  proxyAuthUsername: z.string().min(1),
  proxyAuthPassword: z.string().min(1),
  targetHost: z.string().min(1),
  headers: z.array(proxyRequestHeaderSchema),
});

const approvedProxyAuthResponseSchema = z.object({
  outcome: z.literal("approved"),
  headers: z.array(proxyRequestHeaderSchema),
});

const rejectedProxyAuthResponseSchema = z.object({
  outcome: z.enum(["denied", "failed"]),
  message: z.string().min(1),
});

const proxyAuthResponseSchema = z.union([
  approvedProxyAuthResponseSchema,
  rejectedProxyAuthResponseSchema,
]);

export type ProxyRequestHeader = z.infer<typeof proxyRequestHeaderSchema>;
export type ProxyAuthRequest = z.infer<typeof proxyAuthRequestSchema>;
export type ProxyAuthResponse = z.infer<typeof proxyAuthResponseSchema>;

export function parseProxyAuthRequest(raw: string): ProxyAuthRequest {
  return proxyAuthRequestSchema.parse(JSON.parse(raw) as unknown);
}

export function serializeProxyAuthRequest(message: ProxyAuthRequest): string {
  return `${JSON.stringify(proxyAuthRequestSchema.parse(message))}\n`;
}

export function serializeProxyAuthResponse(message: ProxyAuthResponse): string {
  return `${JSON.stringify(proxyAuthResponseSchema.parse(message))}\n`;
}
