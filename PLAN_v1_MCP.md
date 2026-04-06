# MCP (Model Context Protocol) Integration

- It should be possible to configure access to MCP servers in the host
  tool.
- The host tool should handle OAuth login to the configured MCP servers.
- MCP server metadata should be passed to the workers.
- Workers should be able to make requests to the MCP servers, but pass
  through the host tool for privilege management.
- By default, each tool call should be considered a privilege request.
- Users may grant access to a tool call once, "always in this worker session"
  or "always allow" (for safe operations).
- "Always allow" choices have to be persisted in a human-readable config file on disk.

→ We need to introduce some config file, maybe also suitable for other config parameters
  we already have right now.

→ The host needs to expose an MCP server to the workers, so that they can make requests to the configured MCP servers.
  The MCP server should listen only on localhost, workers connect through an internal Docker network,
  and workers should receive a JWT token with an expiry of 1 day to authenticate with the host's MCP server.

The MCP server integration should be tested with the Todoist MCP server
and the Home Assistant MCP server.

- As the host already exposes MCP servers to the client, we could also
  refactor Sandy's own tool call flow to MCP.