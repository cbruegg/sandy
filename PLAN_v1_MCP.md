# MCP Integration And HTTP Token Proxy

## Status
Sandy's external MCP integration and HTTP token proxy are implemented in the current codebase.

README.md already documents the operator-facing configuration and runtime behavior. This document keeps only the implementation notes and remaining follow-up work that are not already explained there.

## Remaining Work
- Convert Sandy's native worker tools into MCP server tools in a future follow-up. V1 still uses the native worker protocol for shared-workspace copy operations, channel file send-back, task completion, and HTTP token requests.

## Technical Overview

### Host-mediated MCP boundary
- Workers do not connect to upstream MCP servers directly. They connect to Sandy's MCP proxy with a per-task JWT bearer token.
- The proxy mediates both `callTool` and `readResource` through host authorization before forwarding to the configured upstream MCP server.
- Persisted `always allow` MCP approvals remain task-scoped through main-agent-selected auto-approval policy rather than applying to every future task automatically.

### HTTP token proxy boundary
- Workers request HTTP token use through Sandy's native `request_http_token` tool before sending proxied requests with placeholder headers.
- Token substitution and approval enforcement happen in the host/proxy path, not inside the worker process.
- Once and worker-session token grants remain separate so one-shot approvals cannot be accidentally reused as session grants.

## Out Of Scope
- Dynamic host mounts.
