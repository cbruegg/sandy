import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

export type RecordedOAuthResponse = {
  url: string;
  status: number;
  body: string;
};

type OAuthCompatibilityFetchState = {
  fetchFn: FetchLike;
  lastResponse?: RecordedOAuthResponse;
};

const oauthMetadataUrlFields = [
  "authorization_endpoint",
  "token_endpoint",
  "revocation_endpoint",
  "registration_endpoint",
  "jwks_uri",
  "userinfo_endpoint",
  "introspection_endpoint",
  "device_authorization_endpoint",
  "end_session_endpoint",
  "pushed_authorization_request_endpoint",
] as const;

export function createOAuthCompatibilityFetch(): OAuthCompatibilityFetchState {
  const state: OAuthCompatibilityFetchState = {
    fetchFn: async (input, init) => {
      const response = await fetch(input, init);
      const responseUrl = response.url || (typeof input === "string" ? input : String(input));

      if (shouldRecordOAuthResponse(responseUrl, response)) {
        const rawBody = await response.clone().text();
        state.lastResponse = {
          url: responseUrl,
          status: response.status,
          body: truncateResponseBody(rawBody),
        };

        if (shouldNormalizeOAuthMetadataResponse(responseUrl, response)) {
          // Some otherwise-functional MCP/OAuth servers return metadata that is
          // close to RFC 8414 but not fully compliant, such as relative endpoint
          // URLs or a missing issuer. Normalize those responses before the SDK's
          // strict schema validation so Sandy can interoperate without carrying
          // server-specific branches.
          return normalizeOAuthMetadataResponse(response, responseUrl, rawBody);
        }
      }

      return response;
    },
  };
  return state;
}

export function normalizeOAuthMetadataDocument(documentUrl: string, raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }

  const normalized: Record<string, unknown> = { ...raw as Record<string, unknown> };
  let touched = false;

  for (const field of oauthMetadataUrlFields) {
    const value = normalized[field];
    if (typeof value !== "string" || value.length === 0 || URL.canParse(value)) {
      continue;
    }

    if (!URL.canParse(value, documentUrl)) {
      continue;
    }

    normalized[field] = new URL(value, documentUrl).href;
    touched = true;
  }

  if (normalized["issuer"] === undefined && looksLikeAuthorizationServerMetadata(normalized)) {
    normalized["issuer"] = new URL("/", documentUrl).href;
    touched = true;
  }

  return touched ? normalized : raw;
}

export function shouldUseIndieAuthFallbackClientId(error: unknown): boolean {
  return error instanceof Error && error.message === "Incompatible auth server: does not support dynamic client registration";
}

export function buildRedirectOriginClientId(redirectUrl: string | URL): string {
  // IndieAuth-style servers identify the client by the base of the redirect
  // URL. Sandy uses the actual loopback redirect origin chosen for this login
  // attempt so the derived client ID matches the callback host/port in use.
  return new URL(redirectUrl).origin;
}

export function rewriteUrlOrigin(url: string, fromServerUrl: string | URL, toServerUrl: string | URL): string {
  const parsedUrl = new URL(url);
  const fromOrigin = new URL(fromServerUrl).origin;
  if (parsedUrl.origin !== fromOrigin) {
    return url;
  }

  const toOrigin = new URL(toServerUrl).origin;
  const rewritten = new URL(parsedUrl.pathname + parsedUrl.search + parsedUrl.hash, toOrigin);
  return rewritten.href;
}

function shouldRecordOAuthResponse(url: string, response: Response): boolean {
  if (url.includes("/.well-known/")) {
    return true;
  }

  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("json");
}

function shouldNormalizeOAuthMetadataResponse(url: string, response: Response): boolean {
  if (!url.includes("/.well-known/")) {
    return false;
  }

  const contentType = response.headers.get("content-type") ?? "";
  return contentType === "" || contentType.includes("json");
}

function normalizeOAuthMetadataResponse(response: Response, responseUrl: string, rawBody: string): Response {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    const normalized = normalizeOAuthMetadataDocument(responseUrl, parsed);
    if (normalized === parsed) {
      return response;
    }

    return new Response(JSON.stringify(normalized), {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  } catch {
    return response;
  }
}

function looksLikeAuthorizationServerMetadata(raw: Record<string, unknown>): boolean {
  return typeof raw["authorization_endpoint"] === "string"
    || typeof raw["token_endpoint"] === "string"
    || typeof raw["revocation_endpoint"] === "string"
    || raw["response_types_supported"] !== undefined;
}

function truncateResponseBody(body: string, limit = 4000): string {
  if (body.length <= limit) {
    return body;
  }

  return `${body.slice(0, limit)}\n... [truncated]`;
}
