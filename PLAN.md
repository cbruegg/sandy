# PLAN: Main-Agent-Only MemPalace MCP Integration

## Goal

Replace the current host-managed MemPalace wrapper with direct MemPalace MCP access
for Sandy's main agent only. Subagents must never see MemPalace.

## Relevant Documentation

- MemPalace MCP setup: <https://mempalaceofficial.com/guide/mcp-integration.html>
- MemPalace MCP tool reference: <https://mempalaceofficial.com/reference/mcp-tools.html>
- MemPalace concepts (wings/rooms): <https://mempalaceofficial.com/concepts/the-palace.html>
- Codex app-server protocol: <https://developers.openai.com/codex/app-server>
- Codex config reference (mcp_servers): <https://developers.openai.com/codex/config-reference>

## Design Decision: Autonomous Configuration

Sandy configures MemPalace MCP **autonomously at runtime**, without the user needing
to add it to `~/.codex/config.toml` or to Sandy's `config.toml`.

**How:** The main-agent app-server thread is created with a `config` field on
`ThreadStartParams` that carries an `mcp_servers.mempalace` block. This configures
the server for that thread only — no global Codex config file is touched.

The `ThreadStartParams` type (from the generated app-server v2 schema at
`src/codex-app-server-client/generated/v2/ThreadStartParams.ts:12-19`) includes:

```ts
config?: { [key in string]?: JsonValue } | null
```

We construct a nested config object:

```json
{
  "mcp_servers": {
    "mempalace": {
      "command": "python3",
      "args": ["-m", "mempalace.mcp_server", "--palace", "~/.mempalace/palace"]
    }
  }
}
```

The MemPalace MCP server is launched as a stdio subprocess by the app-server itself,
using the standard `python -m mempalace.mcp_server` entrypoint documented at
<https://mempalaceofficial.com/guide/mcp-integration.html>.

**Fallback consideration:** If thread-level `config` does not propagate MCP server
definitions correctly (it may be intended only for scalar config overrides), a
backup path is to set `CODEX_HOME` in the main-agent app-server's `env` to a
temporary directory containing a pre-written `config.toml` with just the
`[mcp_servers.mempalace]` block. This also avoids touching the global config file.

## Open Risk: `approvalPolicy: never`

The main agent currently runs with `approvalPolicy: "never"` (set in
`buildAppServerThreadStartParams` at `src/codex-app-server-client/app-server-client.ts:159`).

According to the Codex app-server docs (`AskForApproval` type at
`src/codex-app-server-client/generated/v2/AskForApproval.ts`), `"never"` means
all tool calls are auto-rejected. This would prevent the main agent from calling
any MemPalace MCP tools.

**Action:** During implementation, evaluate whether `approvalPolicy: "never"`
blocks MCP tool execution for the main agent. If it does, one of these paths
should be taken:

1. Switch to `approvalPolicy: "on-request"` with `approvalsReviewer: "auto_review"`
   (the reviewer subagent path), keeping sandbox read-only so other tool classes
   remain constrained.
2. Use a granular approval policy that permits `mcp_elicitations` while keeping
   sandbox and other tool classes restricted.
3. (Least preferred) Keep `approvalPolicy: "never"` but separately wire a
   thread-level `config` that enables auto-approval for the MemPalace server via
   Codex's `mcp_servers.<id>.default_tools_approval_mode = "auto"`.

The right answer depends on what Codex's current app-server actually does with
`approvalPolicy: "never"` in practice for MCP tool calls. This must be verified
by testing.

## Tool Allowlist

We trust the main agent, so **all 29 MemPalace MCP tools are exposed** initially.
No tool allowlist is applied. The agent can discover tools via standard MCP tool
discovery.

If future experience suggests that destructive tools (delete, KG mutations) cause
problems, an allowlist can be added later through the same thread `config` path.

## Implementation Plan

All phases are implemented together in a single change. The feature is WIP and
not used by any real users, so temporary regressions in memory behavior during
the transition are acceptable.

### 1. Remove Host-Managed Memory Code

Delete or strip the current host-side MemPalace wrapper entirely:

- Delete `src/memory/mempalace-memory.ts` (the `MemPalaceMainAgentMemory` class,
  `storeConversationMemory`, `storeTaskSummaryMemory`, etc.)
- Delete `src/memory/noop-memory.ts` (`NoopMainAgentMemory`)
- Delete `src/memory/types.ts` (`MainAgentMemory` interface, `RelevantMemory`,
  `MemorySearchInput`)
- Delete `src/memory/constants.ts`
- Delete `scripts/mempalace-helper.py`
- Remove all references to `MainAgentMemory` from:
  - `src/app.ts` (import, construction of MemPalaceMainAgentMemory/NoopMainAgentMemory)
  - `src/orchestrator/shared.ts` (`mainAgentMemory` dependency)
  - `src/orchestrator/test-helpers.ts` (`mainAgentMemory` option, NoopMainAgentMemory import)
  - `src/orchestrator/index.ts` (`searchRelevantMemories` call, `storeConversationMemory` calls)
  - `src/orchestrator/task-lifecycle.ts` (`storeTaskSummaryMemory` call, `RelevantMemory` type)
- Remove `relevantMemories` from:
  - `src/types/main-agent.ts` (`DecideContext.relevantMemories`)
  - `src/agent/main-agent-controller.ts` (prompt sections for memory)
  - `src/orchestrator/worker-input.ts` (`injectMemoryIntoTaskInput`, `buildMemoryContextText`)

### 2. Add MemPalace MCP to Main-Agent Thread Config

Add code to construct the MemPalace MCP server config and pass it through
thread start:

- Create a function that builds the `mempalace` MCP server config block.
  It should use the `MEMPALACE_PALACE_PATH` constant currently defined in
  `src/memory/constants.ts` (move it to a suitable location, or keep and
  repurpose the constants file).
  ```ts
  function buildMainAgentMcpConfig(): { [key: string]: JsonValue } | null {
    // Only configure if mempalace is available (python3 -c "import mempalace")
    if (!isMemPalaceAvailable()) return null;
    return {
      mcp_servers: {
        mempalace: {
          command: "python3",
          args: ["-m", "mempalace.mcp_server", "--palace", MEMPALACE_PALACE_PATH],
        },
      },
    };
  }
  ```

- Pass this config into `createMainAgentProfile()` or the thread-start path in
  `CodexMainAgentController`. This requires modifying `createMainAgentProfile()`
  (at `src/codex-app-server-client/app-server-client.ts:164`) to accept an optional
  config parameter, and `CodexMainAgentController.getOrCreateThreadId()` (at
  `src/agent/main-agent-controller.ts:202`) to pass it into `ThreadStartParams.config`.

- The availability check should be a lightweight `spawnSync("python3", ["-c", "import mempalace"])`
  done once at startup and cached. If unavailable, no MCP config is injected and
  the main agent simply has no memory tools (graceful degradation).

### 3. Update Main-Agent Prompt

Update the main-agent decision prompt in `src/agent/main-agent-controller.ts`
in `buildMainAgentPrompt()`:

- Remove the old `relevantMemoriesSection` and `memoryRules`.
- Add a new instruction section about MemPalace MCP availability when MemPalace
  is configured. Use tool discovery language rather than hardcoding tool names:
  ```
  "A MemPalace memory server is available to you via MCP. Use MCP tool
   discovery to list its tools. Use it to:",
  "- Search past Sandy memories before answering questions about past events,
    decisions, or user preferences.",
  "- File stable facts, preferences, and longer-lived context worth remembering.",
  "- Never delegate memory management to sub-agents.",
  "- Prefer current visible chat context over older memories.",
  "- Do not assume a memory is authoritative if it conflicts with current user input.",
  "- Return your decision JSON after optional tool use."
  ```
- This goes into the prompt only when MemPalace is available (runtime detection).
- Remove `relevantMemories` from `buildMainAgentPrompt`'s input type signature.

### 4. Update Orchestrator

In `src/orchestrator/index.ts`:

- Remove the `searchRelevantMemories()` call before each `user_message`.
- Remove the `storeConversationMemory()` calls after user messages and direct replies.
- Remove the `relevantMemories` parameter from `executeMainAgentDecision()`.

In `src/orchestrator/task-lifecycle.ts`:

- Remove `storeTaskSummaryMemory()` call when releasing pending task summaries.
- Remove `injectMemoryIntoTaskInput()` call when launching tasks.
- Remove `relevantMemories` parameter from `executeMainAgentDecision()`.
- Remove the `RelevantMemory` import and related code.

In `src/orchestrator/worker-input.ts`:

- Remove `buildMemoryContextText()` and `injectMemoryIntoTaskInput()`.
- Remove `RelevantMemory` import.

### 5. Update App Wiring

In `src/app.ts`:

- Remove the `MemPalaceMainAgentMemory` / `NoopMainAgentMemory` construction block.
- Remove `mainAgentMemory` from `SandyOrchestrator` constructor call.
- Pass the MemPalace availability flag to `CodexMainAgentController` so it can
  conditionally inject MCP config and prompt instructions.

### 6. Update Tests

- Remove memory-related tests from `src/agent/main-agent-controller.test.ts`
  (the `"buildMainAgentPrompt renders relevant memories as plain bullets"` test
  and any others that inject `relevantMemories`).
- Update `src/orchestrator/task-lifecycle.test.ts`: remove `"Potential memories: none"`
  lines from expected summaries, remove memory-related assertions.
- Remove or update `src/orchestrator/test-helpers.ts`: remove `mainAgentMemory` option,
  remove `NoopMainAgentMemory` import.
- Update `src/subagent/worker.test.ts`: remove the `"Potential memories:"` assertion
  from `buildTaskSummaryInput` test (the `Potential memories` field was added in the
  previous commit and is no longer needed since the host won't be parsing it).
- Revert `src/subagent/worker-prompt.ts`: remove `"Potential memories:"` from
  `buildTaskSummaryInput()`.
- Update `src/orchestrator/index.test.ts` if any tests reference memory behavior.

### 7. Update README

Update `README.md` to reflect the new autonomous MemPalace MCP approach:

- Remove the manual installation steps for MemPalace CLI / `mempalace init`.
- Document that Sandy auto-configures MemPalace MCP if `mempalace` is Python-importable.
- Note that MemPalace memories are now managed by the main agent directly, not by
  the host wrapper.
- Update memory behavior documentation accordingly.

### 8. Remove `Potential memories` from Worker Summary Prompt

Revert `src/subagent/worker-prompt.ts` `buildTaskSummaryInput()` to remove the
`"Potential memories"` field that was added in the previous commit. The host no
longer parses task summaries for memory extraction — the main agent handles memory
autonomously via MCP.

## Files Changed (Summary)

| Action | Files |
|--------|-------|
| Delete | `src/memory/mempalace-memory.ts`, `src/memory/noop-memory.ts`, `src/memory/types.ts`, `src/memory/constants.ts`, `scripts/mempalace-helper.py` |
| Modify | `src/agent/main-agent-controller.ts` (remove memory prompt sections, add MCP config/prompt) |
| Modify | `src/codex-app-server-client/app-server-client.ts` (extend `createMainAgentProfile`) |
| Modify | `src/app.ts` (remove memory service wiring, pass config to controller) |
| Modify | `src/orchestrator/index.ts` (remove host-managed memory operations) |
| Modify | `src/orchestrator/task-lifecycle.ts` (remove memory persistence calls) |
| Modify | `src/orchestrator/worker-input.ts` (remove memory injection) |
| Modify | `src/orchestrator/shared.ts` (remove `mainAgentMemory` dependency) |
| Modify | `src/orchestrator/test-helpers.ts` (remove memory option) |
| Modify | `src/types/main-agent.ts` (remove `relevantMemories` from `DecideContext`) |
| Modify | `src/subagent/worker-prompt.ts` (revert `Potential memories` addition) |
| Modify | `README.md` (update memory docs) |
| Modify | `src/agent/main-agent-controller.test.ts` (remove memory tests) |
| Modify | `src/orchestrator/task-lifecycle.test.ts` (remove memory assertions) |
| Modify | `src/subagent/worker.test.ts` (remove `Potential memories` assertion) |

## Verification

- `bun run build` — must pass (type-check, lint, bundle)
- `bun run test` — all existing tests must pass after updates
- Manual: start Sandy with `./scripts/run-local-dev.sh`, verify the main agent
  can discover and use MemPalace MCP tools
- Manual: verify that `approvalPolicy: "never"` does not block MemPalace MCP
  tool calls; if it does, adjust the approval policy as discussed above
