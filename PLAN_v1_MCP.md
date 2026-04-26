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
- Token config lives in `[http.tokens.<name>]` with `value`. Persistent approvals live in `[approvals.http.<name>]` with `always_allow_hosts`.
- The HTTP proxy runs as a separate per-worker container, not inside the MCP sidecar.
- Workers receive `HTTP_PROXY` and `HTTPS_PROXY` env vars pointing to the proxy with embedded task JWT credentials for automatic proxy authentication.
- The HTTP proxy shares the worker network-guard namespace so it inherits the same effective connectivity restrictions while remaining isolated from the worker process.
- Workers resolve `sandy-http-proxy` to `127.0.0.1` inside the shared namespace; no Docker network alias is required for the proxy.
- The MCP sidecar still runs behind its own network-guard container, but only advertises the `sandy-mcp-proxy` alias.
- HTTPS CONNECT is terminated with TLS MITM when a CA is configured: the proxy generates per-host leaf certs, reads decrypted HTTP requests, and applies the same header-rewriting and approval logic as plain HTTP.
- Workers are provisioned with Sandy's CA certificate for HTTPS trust validation.
- Once and session grants are stored separately (prevents session grants from being consumed and nullifies ambiguity).

Explicitly deferred:

- Rewriting Sandy's own host-mediated worker-tool flow to MCP. V1 keeps the native worker protocol for file copy and channel-file send operations.

Current limitations:

- The current upstream OAuth flow is intended for streamable HTTP MCP servers.
- Dynamic host mounts remain out of scope for v1.
