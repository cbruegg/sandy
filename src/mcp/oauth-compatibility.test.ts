import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildRedirectOriginClientId,
  normalizeOAuthMetadataDocument,
  shouldUseIndieAuthFallbackClientId,
} from "./oauth-compatibility.js";

test("normalizeOAuthMetadataDocument resolves relative endpoint URLs and fills issuer", () => {
  const result = normalizeOAuthMetadataDocument(
    "http://raspinas:8123/.well-known/oauth-authorization-server",
    {
      authorization_endpoint: "/auth/authorize",
      token_endpoint: "/auth/token",
      revocation_endpoint: "/auth/revoke",
      response_types_supported: ["code"],
    },
  );

  assert.deepEqual(result, {
    issuer: "http://raspinas:8123/",
    authorization_endpoint: "http://raspinas:8123/auth/authorize",
    token_endpoint: "http://raspinas:8123/auth/token",
    revocation_endpoint: "http://raspinas:8123/auth/revoke",
    response_types_supported: ["code"],
  });
});

test("normalizeOAuthMetadataDocument leaves absolute metadata unchanged", () => {
  const raw = {
    issuer: "https://example.com",
    authorization_endpoint: "https://example.com/authorize",
    token_endpoint: "https://example.com/token",
    response_types_supported: ["code"],
  };

  assert.equal(normalizeOAuthMetadataDocument("https://example.com/.well-known/oauth-authorization-server", raw), raw);
});

test("shouldUseIndieAuthFallbackClientId only matches missing dynamic registration support", () => {
  assert.equal(
    shouldUseIndieAuthFallbackClientId(new Error("Incompatible auth server: does not support dynamic client registration")),
    true,
  );
  assert.equal(shouldUseIndieAuthFallbackClientId(new Error("boom")), false);
});

test("buildRedirectOriginClientId uses the redirect origin", () => {
  assert.equal(buildRedirectOriginClientId("http://127.0.0.1:12345/callback"), "http://127.0.0.1:12345");
});
