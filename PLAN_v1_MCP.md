# MCP (Model Context Protocol) Integration

Implemented in the current codebase:

- Sandy reads MCP server definitions from the Sandy TOML config file.
- Sandy exposes configured upstream MCP servers to workers through a host-side MCP proxy.
- Workers authenticate to the Sandy MCP proxy with a Sandy-issued JWT bearer token that expires after one day.
- MCP tool calls are mediated by the Sandy host runtime rather than going directly from worker to upstream server.
- Every MCP tool call is treated as a privilege request unless already covered by a worker-session or persisted grant.
- Users can approve an MCP tool call once, for the current worker session, or with `always allow`.
- `Always allow` decisions are written back automatically to Sandy's human-readable TOML config file on disk.
- Upstream MCP OAuth login is handled on the host through `sandy mcp list|status|login|logout`.

Explicitly deferred:

- Rewriting Sandy's own host-mediated worker-tool flow to MCP. V1 keeps the native worker protocol for file copy and channel-file send operations.

Current limitations:

- The current upstream OAuth flow is intended for streamable HTTP MCP servers.
- Dynamic host mounts and OneCLI remain out of scope for v1 and are still rejected by the runtime.
