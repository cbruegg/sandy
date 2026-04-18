# Sandy V1 Plan

## Summary
Build a safe MVP for Sandy as a Telegram-first orchestration service around Codex sub-agents running in Docker. V1 is text-first, single-process, and allows at most one active sub-agent per chat. The main agent acts only as a narrow controller for deciding whether to launch a task or reply directly; task execution, cancellation, privilege approval, and dangerous-output reporting are handled deterministically by the host runtime.

## Current Implementation Status
- The current codebase implements a text-first MVP skeleton for Telegram plus Docker-hosted Codex sub-agents.
- Implemented today:
  - Bun-based local runtime, package-manager, and test-runner workflow, with explicit `tsc --noEmit` type-checking kept in the build.
  - `bun build` support for both bundled JS outputs and single-file executable builds for the host entrypoints.
  - `grammY`-based Telegram transport with deterministic normalization into Sandy chat events.
  - Recovery from transient Telegram polling or handler errors without crashing the host process.
  - A narrow main-agent controller that decides whether to reply directly or launch a sub-agent.
  - Main-agent Codex threads are locked down with `approvalPolicy: "never"`, `sandboxMode: "read-only"`, and a fresh temp working directory per chat thread.
  - Main-agent Codex threads persist per chat and receive only the newly visible entries for each decision, preserving context caching without maintaining a full host-side transcript.
  - Startup-time discovery of config-driven skills from `<config directory>/skills`, with only each skill's `name` and `description` exposed to the main agent.
  - Single active sub-agent per chat.
  - Per-sub-agent Docker container plus per-sub-agent shared volume.
  - Read-only worker mounts for configured skills at `$HOME/.agents/skills`.
  - Structured stdio control channel between host and sub-agent worker, including an explicit worker startup handshake.
  - Codex sub-agents run with Docker as the outer sandbox boundary; nested Codex bubblewrap sandboxing is disabled in-container.
  - The sub-agent's initial Codex input explicitly tells it that `/workspace/share` is the shared workspace for host-visible handoff files.
  - Deterministic auth selection that prefers local Codex ChatGPT auth over `OPENAI_API_KEY` when both are available.
  - Operator-configured worker preinstall overlays built as cached derived Docker images on top of the Sandy-managed worker base image.
  - Eager worker-overlay reconciliation during Sandy startup, with persisted weekly refresh timing stored in Sandy's cache directory.
  - Quarantining of sub-agent output until the user either reports it as dangerous or continues the conversation.
  - Deterministic cancellation and privilege-request routing.
  - Telegram file uploads staged directly into the per-task shared workspace on task launch and during active tasks.
  - Deterministic sub-agent requests to send files from `/workspace/share` back to the user through the channel without privilege escalation.
  - Host-mediated one-off file copy operations into and out of the per-sub-agent shared workspace.
  - File-backed Sandy runtime configuration in `~/.config/sandy/config.toml`, with `SANDY_CONFIG_FILE` as a path override.
  - Telegram voice messages transcribed through a configurable OpenAI-compatible STT endpoint and then processed through the normal text-message path.
  - Deterministic detection of worker disconnects, handshake timeouts, and control-channel write failures.
  - Structured host-side logging for significant lifecycle and failure events.
  - Centralized user-facing message definitions to prepare for future i18n.
  - Channel-owned formatting metadata, with Telegram output sanitized and sent as simple HTML.
  - Automatic deletion of empty per-sub-agent shared workspaces, with explicit user confirmation before deleting non-empty workspaces.
  - Host-side MCP proxying for configured upstream MCP servers, with per-task JWT authentication for workers.
  - Default-deny worker access to local/private network ranges through a per-task network-guard container, while preserving public internet access and MCP sidecar connectivity on both Linux and Docker Desktop.
  - Host-admin MCP OAuth login flow through `sandy mcp <list|status|login|logout>`.
  - MCP privilege approval scopes `once`, `worker_session`, and `always allow`, with `always allow` persisted automatically to the Sandy TOML config.
- Not fully implemented yet:
  - Image handling.
  - Host-side enforcement for approved resource requests beyond shared-workspace file copy and MCP tool access, such as mount setup and OneCLI enablement.
- Mount and OneCLI requests remain represented in Sandy's typed protocol for future expansion, but they are currently rejected as unsupported by the host runtime.
- Sandy's own worker-tool flow is intentionally not rewritten to MCP in v1; that remains follow-up work after external MCP support.

## Key Changes
### Host runtime and orchestration
- Replace the current Codex SDK smoke test with a host application that boots:
  - a Telegram channel adapter,
  - an in-memory session store,
  - a main-agent controller,
  - a Docker-based sub-agent runner using structured stdio for host/sub-agent communication.
- Track per-chat session state explicitly with statuses such as `idle`, `running`, `awaiting_privilege_decision`, `completed`, `cancelled`, and `failed`.
- Enforce one active sub-agent per chat. If a user sends a new command while one is running, return a deterministic “cancel the current task first” response.

### Main-agent controller
- Use a dedicated Codex thread as the main controller only when the chat is idle or when host-side state must be interpreted for the next action.
- Constrain the main agent to structured output with only:
  - `launch_task`
  - `reply`
- Build the main-agent prompt from only:
  - the normalized visible chat entries relevant to the current decision turn,
  - host-side task metadata for the active sub-agent if one exists,
  - the allowed action schema.
- Define “normalized visible chat entries” as a deterministic representation of user/channel events, not an LLM summary. It should:
  - convert Telegram-specific inputs into canonical event types such as `user_text`, `cancel_request`, `approval_response`, `danger_report`,
  - keep only semantically relevant text and minimal metadata,
  - exclude raw transport payloads and unsupported binary content.
- Define “host-side task metadata” as lifecycle state only. It may include:
  - task ID and task name,
  - current status,
  - start time / last activity time,
  - whether quarantined output is pending,
  - whether a privilege decision is pending,
  - which resources have already been approved,
  - worker/container health.
- The main agent must never receive:
  - raw sub-agent output hidden by README policy,
  - summaries or paraphrases of hidden sub-agent output,
  - raw privilege request text if those requests are meant to bypass the main agent.

### Sub-agent execution and safety boundary
- Launch each sub-agent in its own Docker container with:
  - internet access,
  - a per-sub-agent shared volume for file exchange,
  - an attached stdio control channel to the host.
- Run the sub-agent with Codex SDK `runStreamed()` so progress and completion events can be forwarded incrementally.
- Forward sub-agent user-visible output directly to the user through the host transport layer, but quarantine it from the main-agent context until the user’s next non-report message.
- If the next user action is a deterministic danger report:
  - terminate the sub-agent,
  - discard quarantined output,
  - notify the user.
- Otherwise:
  - allow the quarantined output to be included in a later main-agent decision input,
  - continue handling the conversation normally.
- Treat unexpected worker exit, container failure, or loss of the stdio control channel as deterministic task failure.

### Privilege and resource requests
- Define a typed stdio protocol for worker-to-host events such as:
  - `progress`
  - `assistant_output`
  - `final_result`
  - `privilege_request`
  - `task_done`
  - `task_error`
- Define privilege request types for:
  - copying files into the per-sub-agent shared volume,
  - copying files out of the per-sub-agent shared volume,
  - read-only host directory mount,
  - read-write host directory mount,
  - enabling access to a preconfigured MCP server identifier,
  - enabling access to a preconfigured OneCLI-backed tool identifier.
- Do not route privilege requests through the main agent. The host forwards them directly to the user and resolves them deterministically.
- For MCP tool calls, support three positive approval scopes:
  - once
  - always in this worker session
  - always allow, persisted to Sandy's TOML config on disk
- Restrict approvable resources to configured allowlists. Unknown host paths or unknown MCP/OneCLI identifiers are denied before user prompting.
- On approval, the host applies the change deterministically and informs the sub-agent. On denial, the host sends a deterministic rejection event.

### Channel and interface design
- Introduce interfaces for:
  - `ChannelAdapter`
  - `AgentController`
  - `SandboxRunner`
  - `PrivilegeBroker`
  - `SessionStore`
  - `TranscriptionProvider`
- Normalize inbound message types as `text`, `image`, `file`, `voice`, with `text` and file attachments implemented end to end in v1.
- Expose channel formatting metadata to both the main agent and sub-agents so user-visible output can target the active channel safely.
- For Telegram v1, support inline buttons and fixed commands/phrases for:
  - cancel
  - approve
  - deny
  - danger report
- Send Telegram messages using sanitized HTML rather than plain Markdown text.
- Keep voice/image handling scaffolded at the interface level, with explicit “not supported in v1” behavior where needed.

### Dependencies and configuration
- Add dependencies for:
  - Telegram bot runtime,
  - runtime schema validation,
  - Docker lifecycle control,
  - Bun test runner and TypeScript type-checking.
- Add Sandy TOML config for:
  - Telegram bot token
  - OpenAI/Codex auth selection
  - host log level and debug-content logging
  - Docker worker image/tag
  - per-sub-agent share root path
  - STT endpoint/model credentials
  - configured MCP server definitions
  - persisted `always allow` MCP tool grants
  - allowlisted host mount roots
  - allowlisted OneCLI tool identifiers

## Public Interfaces and Types
- `MainAgentDecision`
  - structured response with `action: "launch_task" | "reply"`
  - optional `taskBrief`, `taskName`, `replyText`
- `NormalizedChatEvent`
  - canonical host event type for user text and deterministic control actions
- `SubAgentEvent`
  - validated union for progress, visible output, privilege requests, completion, and failure
  - `worker_connected`: worker startup handshake confirming the control channel is ready
  - `progress`: incremental task status text
  - `assistant_output`: user-visible sub-agent output that remains quarantined from the main agent
  - `final_result`: explicit final result payload for a completed task
  - `privilege_request`: deterministic capability request routed directly to the user
  - `task_done`: clean completion marker without an explicit final result payload
  - `task_error`: terminal failure reported by the worker
  - `worker_disconnected`: transport failure before any terminal task event was received
- `PrivilegeRequest`
  - validated union for `copy_into_share`, `copy_out_of_share`, `mount_ro`, `mount_rw`, `enable_mcp`, `enable_onecli`
- `SessionState`
  - in-memory per-chat state including active task metadata, quarantined output pending later release, and any pending shared-workspace deletion confirmation

## Test Plan
- Unit-test normalization of Telegram inputs into canonical chat events.
- Unit-test main-agent decision parsing and rejection of invalid structured output.
- Unit-test active-task routing for normal text, cancellation, approval, denial, and danger reporting.
- Unit-test quarantine behavior:
  - visible sub-agent output is not exposed to the main agent immediately,
  - danger reports discard quarantined output,
  - non-report follow-up allows quarantined output to be supplied on a later main-agent decision.
- Unit-test privilege handling:
  - allowlisted requests can be presented and applied deterministically,
  - non-allowlisted requests are rejected safely,
  - copy-in and copy-out operations target only the requesting sub-agent’s share.
- Unit-test unsupported voice/image inputs produce explicit deterministic responses.
- Unit-test file upload staging into the task share and deterministic file send-back through the channel.
- Integration-test happy-path task launch, progress relay, privilege approval, and completion using mocked Codex, mocked Docker, mocked Telegram, and mocked worker transport.
- Integration-test failure cases:
  - container launch failure,
  - worker disconnect,
  - denied privilege request,
  - task cancellation,
  - dangerous-output report termination.
  - non-empty shared workspace requiring user confirmation before deletion.

## Assumptions and Defaults
- V1 is Telegram-only, text-first, single-process, and single-active-task-per-chat.
- Runtime state is in memory only; restart recovery is out of scope.
- The main agent is a narrow controller and does not see hidden sub-agent output.
- Skills are loaded only at Sandy startup and require a Sandy restart before skill file changes take effect.
- Voice and image inputs are part of the interface design but not fully implemented in v1.
- Each sub-agent gets its own shared volume; copy operations are scoped to that sub-agent’s share.
- User-uploaded files are copied into the task share by the channel adapter and do not require privilege escalation.
- Sending a file from `/workspace/share` back to the user through the channel does not require privilege escalation.
- Dynamic host directory mounts are out of scope for v1.
- OneCLI capability enablement is out of scope for v1.
- External MCP server access is in scope for v1 through Sandy's Docker sidecar proxy.
- Sandy's own worker-tool flow is not rewritten to MCP in v1.
- “STT” is the intended term for voice transcription in v1.
