# MCP Resource Read Security Enhancement Plan

## Background

Sandy's current privilege system treats MCP `callTool` as a privileged operation, but `readResource` is forwarded without host approval. This gap means a compromised sub-agent can read arbitrary resources from any configured MCP server without user interaction.

This plan closes that gap by treating `readResource` the same as `callTool` for privilege purposes, while also laying groundwork for a broader task-scoped resource policy model.

## Security Model

### Layer 1: Task-Scoped Resource Access
- **MCP Server Access**: Each active task has a set of MCP servers it may access.
- **HTTP Token Access**: Each active task has a set of HTTP token IDs it may use.
- These grants are established either:
  - Up front by the main agent in the launch decision, or
  - Lazily when the first tool/resource/token use is approved.
- Once established, they remain for the task duration.

### Layer 2: Operation-Level Approval
- **MCP Tool Calls**: Approved once / per task session / persisted (existing behavior).
- **MCP Resource Reads**: Same approval scopes as tool calls.
- **HTTP Token Host Use**: Approved once / per task session / persisted (existing behavior).

### Persisted Approval Semantics
Persisted approvals are user preferences, but their auto-application is gated by task policy:
- A persisted MCP tool/resource approval only auto-applies if the task has MCP server access for that server.
- A persisted HTTP token host approval only auto-applies if the task has token access for that token.

This means "always allow" no longer implies unconditional future auto-approval. The main agent decides per-task whether persisted approvals may apply.

## Implementation Phases

### Phase 1: `readResource` Guard (Immediate)

Scope: Add host-mediated approval for `readResource` only, keeping the current security model otherwise (no new main-agent policy fields yet).

1. **Privilege Types** (`src/types/privilege.ts`)
   - Add `McpResourceReadPrivilegeRequest` kind with `serverId` and `uri`.
   - Include it in the `PrivilegeRequest` union.

2. **MCP Proxy** (`src/mcp/proxy.ts`)
   - Add `authorizeResourceRead` option to `SandyMcpProxyOptions`.
   - In `ReadResourceRequestSchema` handler, call `authorizeResourceRead` before forwarding.
   - Return `buildToolErrorResult` (or equivalent) if denied.

3. **Orchestrator Authorization** (`src/orchestrator.ts`)
   - Add `authorizeMcpResourceRead()` mirroring `authorizeMcpToolCall()`:
     - Check per-task session grant first.
     - Check persistent approval store next.
     - Fall back to interactive privilege request.
   - Add `resolvePendingMcpResourceReadRequest()` mirroring `resolvePendingMcpPrivilegeRequest()`.
   - Handle `mcp_resource_read` in `resolvePendingPrivilegeRequest()`.

4. **Task State** (`src/types/task-state.ts`)
   - Add `McpResourceReadGrant` type with `serverId` and `uri`.
   - Add `approvedMcpResourceReads` array to `ActiveTaskState`.

5. **Persistent Approval Store** (`src/privilege/persistent-approval-store.ts`)
   - Add `isResourceReadAlwaysAllowed(serverId, uri)`.
   - Add `allowResourceRead(serverId, uri)`.
   - Persist to `approvals.mcp.<server>.always_allow_resources` in TOML.

6. **Messages** (`src/messages.ts`)
   - Add resource-read variants of all MCP approval messages:
     - `mcpResourceReadAllowedOnce`
     - `mcpResourceReadAllowedForWorkerSession`
     - `mcpResourceReadAllowedFromPersistentConfig`
     - `mcpResourceReadAllowedAndPersisted`
     - `userDeniedMcpResourceRead`
     - `unsupportedMcpResourceReadPrivilegeRequest`
   - Update `describePrivilegeRequest()` for resource reads.

7. **Channel Adapters**
   - `src/channel/telegram-adapter.ts`
   - `src/channel/matrix-adapter.ts`
   - `src/channel/local-test-adapter.ts`
   - Update `sendPrivilegeRequest()` to handle `mcp_resource_read` in request type logging.
   - Render same button options as `mcp_tool_call` for now.

8. **App Wiring** (`src/app.ts`)
   - Wire `authorizeResourceRead` into `SandyMcpProxy` options.

9. **Tests**
   - `src/mcp/proxy.test.ts`: Verify `readResource` is blocked when authorization denies and forwarded when approved.
   - `src/orchestrator.test.ts`: Verify full resource-read approval flow (once, session, always, deny).
   - `src/privilege/persistent-approval-store.test.ts`: Verify TOML round-trip for resource approvals.

### Phase 2: Task-Scoped Resource Policy (After Phase 1 Review)

Scope: Add main-agent-driven per-task capability policy that gates persisted approvals.

1. **Main-Agent Decision Schema** (`src/types/main-agent.ts`, `src/agent/main-agent-decision.ts`)
   - Add to `launch_task`:
     ```
     mcpServers: Array<{ serverId: string; accessMode: "pregranted_for_task" | "require_first_task_use_confirmation"; allowPersistedApprovals: boolean }>
     httpTokens: Array<{ tokenId: string; accessMode: "pregranted_for_task" | "require_first_task_use_confirmation"; allowPersistedApprovals: boolean }>
     ```
   - Rename terms if needed, but keep them explicit.

2. **Main-Agent Prompt** (`src/agent/main-agent-controller.ts`)
   - Include configured MCP servers and HTTP tokens with descriptions.
   - Add rules for the model to choose minimal subsets and set `accessMode`/`allowPersistedApprovals`.

3. **Task State Policy** (`src/types/task-state.ts`)
   - Add policy fields to `ActiveTaskState`:
     - `mcpServerPolicies: Array<{ serverId; accessMode; allowPersistedApprovals }>`
     - `httpTokenPolicies: Array<{ tokenId; accessMode; allowPersistedApprovals }>`
     - `approvedMcpServers: string[]`
     - `approvedHttpTokens: string[]`

4. **Orchestrator Launch** (`src/orchestrator.ts`)
   - Store main-agent policy in task state on launch.
   - Pre-populate `approvedMcpServers`/`approvedHttpTokens` for servers/tokens with `pregranted_for_task`.

5. **MCP Proxy Server Allowlist** (`src/mcp/proxy.ts`)
   - Before any request, verify the server is in `approvedMcpServers` for the task.
   - Reject with 403 if not.

6. **HTTP Token Proxy Gating** (`src/http/token-authorizer.ts`)
   - Before checking persisted approvals, verify the token is in `approvedHttpTokens`.
   - Reject if not.

7. **Persisted Approval Gating**
   - MCP tool/resource: Only auto-apply persisted approvals if:
     - Task policy says `allowPersistedApprovals: true` for that server, OR
     - The server already has a task session grant.
   - HTTP token host: Only auto-apply persisted approvals if:
     - Task policy says `allowPersistedApprovals: true` for that token, OR
     - The token already has a task session grant.

8. **New Worker Tools**
   - `request_mcp_server_access` in `src/subagent/worker-tools.ts`
   - `request_http_token_access` in `src/subagent/worker-tools.ts`
   - Add protocol instructions in `src/subagent/worker-prompt.ts`

9. **New Privilege Request Kinds**
   - `mcp_server_access` in `src/types/privilege.ts`
   - `http_token_access` in `src/types/privilege.ts`
   - Session-only approve/deny.

10. **Approval UX for Ungated Resources**
    - When an MCP tool/resource request arrives for a server not yet task-granted:
      - Approval buttons should indicate dual effect (approve action + grant server access).
      - Use labels like "Approve once and allow server for task".
    - Same pattern for HTTP tokens.

11. **Worker Launch Subset**
    - `src/mcp/worker-launch-config-builder.ts`: Only emit MCP server entries for `approvedMcpServers`.
    - Docker runner: Only list HTTP tokens in prompt for `approvedHttpTokens`.

12. **Tests**
    - Main-agent prompt/schema tests for new policy fields.
    - Orchestrator tests for pregranted vs require_first_use_confirmation.
    - MCP proxy tests for server allowlist enforcement.
    - HTTP token authorizer tests for token allowlist enforcement.
    - Full end-to-end flow tests for lazy server/token access establishment.

## Terminology

- **Task access**: Whether a task may use a given MCP server or HTTP token at all.
- **Task session grant**: Runtime approval that establishes task access for the remainder of the task.
- **Pregranted for task**: Main agent grants task access up front.
- **Require first task use confirmation**: Task access must be established by approving the first actual use.
- **Allow persisted approvals**: Main agent allows persisted "always allow" decisions to auto-apply for this task.

## Files Changed Summary (Phase 1)

- `src/types/privilege.ts` – add `mcp_resource_read` kind
- `src/types/task-state.ts` – add `approvedMcpResourceReads`
- `src/privilege/persistent-approval-store.ts` – add resource-read persistence
- `src/orchestrator.ts` – add resource-read authorization and resolution
- `src/mcp/proxy.ts` – gate `readResource`
- `src/app.ts` – wire proxy option
- `src/messages.ts` – add resource-read messages
- `src/channel/telegram-adapter.ts` – handle resource-read in privilege request logging
- `src/channel/matrix-adapter.ts` – handle resource-read in privilege request logging
- `src/channel/local-test-adapter.ts` – handle resource-read in privilege request logging
- `src/mcp/proxy.test.ts` – test proxy gating
- `src/orchestrator.test.ts` – test orchestrator flow
- `src/privilege/persistent-approval-store.test.ts` – test persistence
