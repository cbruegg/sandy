# Sandy V1 Plan

## Summary
Build a safe MVP for Sandy as a Telegram-first orchestration service around Codex sub-agents running in Docker. V1 is text-first, single-process, and allows at most one active sub-agent per chat. The main agent acts only as a narrow controller for deciding whether to launch a task or reply directly; task execution, cancellation, privilege approval, and dangerous-output reporting are handled deterministically by the host runtime.

## Current Implementation Status
- The current codebase implements a text-first MVP skeleton for Telegram plus Docker-hosted Codex sub-agents.
- Implemented today:
  - Telegram message polling and normalization.
  - Recovery from transient Telegram polling or handler errors without crashing the host process.
  - A narrow main-agent controller that decides whether to reply directly or launch a sub-agent.
  - Single active sub-agent per chat.
  - Per-sub-agent Docker container plus per-sub-agent shared volume.
  - Structured stdio control channel between host and sub-agent worker, including an explicit worker startup handshake.
  - Codex sub-agents run with Docker as the outer sandbox boundary; nested Codex bubblewrap sandboxing is disabled in-container.
  - Deterministic auth selection that prefers local Codex ChatGPT auth over `OPENAI_API_KEY` when both are available.
  - Quarantining of sub-agent output until the user either reports it as dangerous or continues the conversation.
  - Deterministic cancellation and privilege-request routing.
  - Deterministic detection of worker disconnects, handshake timeouts, and control-channel write failures.
  - Structured host-side logging for significant lifecycle and failure events.
- Not fully implemented yet:
  - Real STT, file upload handling, and image handling.
  - Host-side enforcement for approved resource requests such as file copy in/out, mount setup, MCP enablement, and OneCLI enablement.
- The last point means those operations are currently represented in Sandy's typed protocol and approval flow, but an approval does not yet cause Sandy to perform the actual filesystem or resource mutation on the host.

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
  - the normalized chat transcript,
  - host-side task metadata for the active sub-agent if one exists,
  - the allowed action schema.
- Define “normalized chat transcript” as a deterministic representation of user/channel events, not an LLM summary. It should:
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
  - release the quarantined output into the orchestration transcript,
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
- Do not route privilege requests through the main agent. The host forwards them directly to the user and resolves approve/deny deterministically.
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
- Normalize inbound message types as `text`, `image`, `file`, `voice`, but implement only `text` end to end in v1.
- For Telegram v1, support inline buttons and fixed commands/phrases for:
  - cancel
  - approve
  - deny
  - danger report
- Keep voice/file/image handling scaffolded at the interface level, with explicit “not supported in v1” behavior where needed.

### Dependencies and configuration
- Add dependencies for:
  - Telegram bot runtime,
  - runtime schema validation,
  - Docker lifecycle control,
  - testing framework.
- Add config for:
  - `TELEGRAM_BOT_TOKEN`
  - `OPENAI_API_KEY`
  - `SANDY_LOG_LEVEL`
  - Docker worker image/tag
  - per-sub-agent share root path
  - allowlisted host mount roots
  - allowlisted MCP identifiers
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
  - in-memory per-chat state including active task metadata, pending privilege request, quarantined-output flag, and main/sub-agent thread IDs

## Test Plan
- Unit-test normalization of Telegram inputs into canonical chat events.
- Unit-test main-agent decision parsing and rejection of invalid structured output.
- Unit-test active-task routing for normal text, cancellation, approval, denial, and danger reporting.
- Unit-test quarantine behavior:
  - visible sub-agent output is not exposed to the main agent immediately,
  - danger reports discard quarantined output,
  - non-report follow-up releases quarantined output into the transcript.
- Unit-test privilege handling:
  - allowlisted requests can be presented and applied deterministically,
  - non-allowlisted requests are rejected safely,
  - copy-in and copy-out operations target only the requesting sub-agent’s share.
- Unit-test unsupported voice/image/file inputs produce explicit deterministic responses.
- Integration-test happy-path task launch, progress relay, privilege approval, and completion using mocked Codex, mocked Docker, mocked Telegram, and mocked worker transport.
- Integration-test failure cases:
  - container launch failure,
  - worker disconnect,
  - denied privilege request,
  - task cancellation,
  - dangerous-output report termination.

## Assumptions and Defaults
- V1 is Telegram-only, text-first, single-process, and single-active-task-per-chat.
- Runtime state is in memory only; restart recovery is out of scope.
- The main agent is a narrow controller and does not see hidden sub-agent output.
- Voice, image, and file inputs are part of the interface design but not fully implemented in v1.
- Each sub-agent gets its own shared volume; copy operations are scoped to that sub-agent’s share.
- “STT” is the intended term for voice transcription in v1.
