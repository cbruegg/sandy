# MCP (Model Context Protocol) Integration & HTTP Token Proxy

Implemented in the current codebase:

- Sandy reads MCP server definitions from the Sandy TOML config file.
- Sandy exposes configured upstream MCP servers to workers through a host-side MCP proxy.
- Workers authenticate to the Sandy MCP proxy with a Sandy-issued JWT bearer token that expires after one day.
- MCP tool calls are mediated by the Sandy host runtime rather than going directly from worker to upstream server.
- Every MCP tool call is treated as a privilege request unless already covered by a worker-session or persisted grant.
- Users can approve an MCP tool call once, for the current worker session, or with `always allow`.
- `Always allow` decisions are written back automatically to Sandy's human-readable TOML config file on disk.
- Upstream MCP OAuth login is handled on the host through `sandy mcp list|status|login|logout`.

## HTTP Token Proxy

- Sandy supports injecting preconfigured HTTP token secrets into proxied worker HTTP requests.
- Workers request token use via the native `request_http_token` tool, which follows the same interactive approval flow as MCP tools (once / worker session / always allow).
- Workers use placeholder header values like `Authorization: Bearer SANDY_TOKEN_<name>`. The HTTP proxy replaces these with the real token value only when the task holds an active approval for that token + host.
- If no approval is active when the proxy sees a placeholder token, the request is rejected immediately with HTTP 403.
- Token config lives in `[http.tokens.<name>]` with `value` and `allowed_hosts`. Persistent approvals live in `[approvals.http.<name>]` with `always_allow_hosts`.
- The HTTP proxy runs in the same sidecar container as the MCP proxy, on port 8081 with alias `sandy-http-proxy`.
- Workers receive `HTTP_PROXY` and `HTTPS_PROXY` env vars pointing to the proxy. Only tools that honor proxy env vars are routed through it; direct network access from workers is unchanged.
- Worker network guards are updated to allow-list `sandy-http-proxy` alongside `sandy-mcp-proxy`.
- HTTPS CONNECT tunneling is supported (passthrough without MITM in the current implementation).

Explicitly deferred:

- Rewriting Sandy's own host-mediated worker-tool flow to MCP. V1 keeps the native worker protocol for file copy and channel-file send operations.
- TLS-intercepting MITM for HTTPS header inspection. Current HTTPS CONNECT passes through without header rewriting.

Current limitations:

- The current upstream OAuth flow is intended for streamable HTTP MCP servers.
- Dynamic host mounts remain out of scope for v1.
