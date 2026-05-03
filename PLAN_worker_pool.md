# Worker Bundle Pool Plan

## Goal

Reduce task start latency by keeping one worker bundle prewarmed at all times, while preserving Sandy's per-task isolation model.

This document is a plan only. It does not authorize implementation work yet.

## Design Summary

- Introduce a bundle-pool abstraction responsible for provisioning task bundles.
- Always keep one standby bundle warming or ready.
- If no standby bundle is ready when a task starts, the pool still provisions the required bundle itself.
- Each bundle remains single-task-only: once assigned to a task, it is destroyed after that task finishes and immediately replaced by a new standby bundle in the background.
- Each warmed bundle gets its own dedicated share directory mounted at `/workspace/share` from the moment the bundle is created.
- Always include the HTTP proxy sidecar in the bundle whenever HTTP token support is enabled globally.
- Do not add a config flag. This becomes the default behavior.

## Non-Goals

- Reusing the same worker bundle across multiple completed tasks.
- Mounting the full configured `shareRoot` into a worker.
- Adding a user-facing or config-facing warm-pool toggle.

## Constraints From Current Architecture

The current launch flow binds several things to task launch time:

- worker container creation
- per-task network guard creation
- per-task HTTP proxy sidecar creation
- task-specific share mount
- task-specific MCP proxy credentials and URLs
- task-specific HTTP proxy credentials

The worker protocol is also effectively one-shot:

- the worker emits `worker_connected`
- the host sends exactly one `start_task`
- the worker stays alive only for follow-up messages on that task

The plan below preserves that one-task-only worker behavior.

## Core Approach

### 1. Add a Task Bundle Pool

Create a separate pool layer so `DockerSandboxRunner` is not responsible for warm/cold decisions.

Suggested files:

- `src/sandbox/task-bundle-pool.ts`
- `src/sandbox/task-bundle-launcher.ts`
- `src/sandbox/task-bundle-types.ts`
- `src/sandbox/task-bundle-share.ts` if share handling needs its own helper

Responsibilities of the pool:

- keep one standby bundle ready or warming
- hand out a bundle for a specific task
- provision on demand when no standby bundle is ready
- start replenishing the next standby immediately after a bundle is assigned
- clean up idle and active bundles during shutdown

Suggested high-level API:

- `start(): Promise<void>`
- `acquire(taskId: string): Promise<ReservedTaskBundle>`
- `shutdown(): Promise<void>`

`DockerSandboxRunner.launchTask()` should request a reserved bundle from the pool and then attach task-specific control/event handling.

### 2. Keep Per-Task Isolation With Bundle-Local Shares

Do not mount all of `shareRoot` into workers.

Instead:

- when a bundle is created, allocate a dedicated host share directory for that bundle
- mount that directory into the worker at `/workspace/share`
- when the bundle is assigned to a task, register that host share path as the task's effective share path
- stage user attachments into that already-mounted directory
- when the task completes, destroy the bundle and delete that bundle-local share

This preserves the current isolation model because each worker still sees only one task's workspace.

Implication:

- `getTaskSharePath(taskId)` can no longer be a pure `shareRoot/taskId` derivation for active tasks
- it should resolve through runner or pool state for active bundles
- cleanup after task completion should use the bundle-local share path that was actually mounted

### 3. Treat Standby and On-Demand Provisioning as the Same Mechanism

The pool should own both paths.

Behavior:

- if a standby bundle is ready, reserve it for the task
- if not, the pool provisions a fresh bundle for the task
- in both cases, the pool begins warming the next standby bundle in the background

This keeps task provisioning centralized and avoids split responsibility between runner and pool.

### 4. Keep Bundles Single-Task-Only

Bundle lifecycle:

- warming
- idle
- reserved
- active
- destroyed

Once a bundle has been assigned to a task, it must never be reused for a second task, even if the task was short-lived.

This preserves the current safety model and avoids state leakage across tasks.

### 5. Move Task-Specific Runtime State to Task Assignment / `start_task`

Bundle creation should include only stable inputs:

- worker image
- Codex binary mount
- auth seed mount
- skills mount
- CA mount
- network guard
- HTTP proxy sidecar when globally enabled
- static logging configuration

Task-specific data should be applied when assigning the bundle to a task:

- `taskId`
- MCP proxy token value
- generated MCP config TOML
- HTTP proxy URL with task-specific credentials
- any other task-bound env/config

This likely requires extending `start_task` in `src/types/subagent.ts`.

### 6. Keep Worker-Visible Share Path Unchanged

Because each warmed bundle mounts its dedicated host share directly at `/workspace/share`, worker code can keep using the existing shared-workspace path contract.

That means the worker-visible path model can stay the same:

- workers still operate on `/workspace/share/...`
- host-side resolution changes only in how the task's backing host directory is chosen

This avoids broad worker prompt and path-semantics churn.

### 7. Refactor `DockerSandboxRunner` Into a Facade Over Smaller Collaborators

`DockerSandboxRunner` should remain the public `SandboxRunner` implementation, but delegate new lifecycle logic.

It should mainly:

- request a bundle from the pool
- send `start_task`
- attach stdout/stderr parsing
- surface a `SandboxHandle`
- close/cancel and trigger bundle teardown

It should not own standby-slot state directly.

### 8. Always Include the HTTP Proxy Sidecar When Enabled Globally

For simplicity:

- if HTTP token support is enabled globally, every warmed bundle should include its HTTP proxy sidecar from creation time
- do not special-case tasks that may not use HTTP tokens

This keeps the bundle shape predictable and avoids compatibility logic in the pool.

### 9. Startup and Shutdown Behavior

Startup:

- initialize the pool during app startup
- begin warming the first standby bundle asynchronously
- do not block app readiness on standby completion
- if the first task arrives before standby is ready, the pool provisions the task bundle on demand and continues warming the next standby afterward

Shutdown:

- stop any further replenishment
- terminate idle standby bundles
- terminate active task bundles
- clean up bundle-local shares
- wait for in-flight provisioning to settle or be cancelled cleanly

## Protocol Changes

`HostCommand.start_task` will likely need additional fields so a warmed bundle can receive task-bound runtime state after container creation.

Candidate additions:

- `taskId`
- generated `codexConfigToml`
- task-specific environment bindings, or explicit fields for:
  - MCP proxy token
  - HTTP proxy URL

The worker should continue enforcing:

- exactly one `start_task` per worker process
- no follow-up commands before `start_task`

## Host State Changes

The runner and pool will need active mappings such as:

- `taskId -> reserved/active bundle`
- `taskId -> effective host share path`

This affects host logic that currently assumes task share paths are derived from `shareRoot/taskId`.

Review carefully:

- attachment staging
- host-mediated file copy tools
- send-file-to-channel path resolution
- post-task share inspection
- post-task share deletion

## Implementation Steps

1. Extract bundle lifecycle types and helper responsibilities into new `src/sandbox/` files.
2. Implement a bundle launcher that provisions:
   - worker container
   - network guard container when required
   - HTTP proxy sidecar when globally enabled
   - bundle-local share directory mounted to `/workspace/share`
3. Implement a task bundle pool that:
   - maintains one standby bundle
   - provisions on demand if standby is unavailable
   - replenishes after assignment
   - shuts down cleanly
4. Refactor `DockerSandboxRunner` to acquire bundles from the pool instead of launching containers directly inline.
5. Change task-share tracking so active tasks resolve to bundle-local shares rather than assuming `shareRoot/taskId`.
6. Extend `start_task` to carry the task-specific runtime values needed by a warmed worker.
7. Update worker startup logic to apply task-specific config on `start_task` before creating the Codex thread.
8. Update cleanup paths for task completion, cancellation, disconnect, and process shutdown.
9. Add or adjust tests.
10. Update `README.md` if needed once implementation details are finalized.

## Testing Plan

### Unit Tests

Add focused tests for the new pool and launcher components:

- pool returns standby bundle when one is ready
- pool provisions on demand when standby is missing or still warming
- pool starts replenishment immediately after assignment
- pool maintains at most one standby bundle
- pool shutdown cleans up idle and active bundles
- bundle-local share paths are registered and cleaned up correctly

Update `src/sandbox/docker-sandbox-runner.test.ts` to cover integration with the pool:

- runner acquires bundles through the pool
- first task can use on-demand bundle when no standby is ready
- subsequent task can use replenished standby bundle
- disconnect and cancellation still clean up the assigned bundle correctly

Update worker tests:

- worker accepts task-specific config/env delivered in `start_task`
- worker still rejects a second `start_task`
- worker still blocks `user_message` and `privilege_result` before task start

### Integration / Behavioral Testing

Use the local-test channel flow to validate:

- Sandy starts normally while the first standby warms asynchronously
- a task can run when no standby is ready yet
- after task assignment, the next standby begins warming
- attachments and host-mediated file operations continue to work with bundle-local shares

## Risks

### Lifecycle Complexity

The current `DockerSandboxRunner` is already large. The main mitigation is to keep pool and bundle-launch logic in separate files and keep the runner as a thinner facade.

### Share Path Assumptions

Several host-side code paths likely assume a task share is always `shareRoot/taskId`. Those assumptions must be audited carefully to avoid regressions in attachments, file send-back, and cleanup.

### Startup / Provisioning Races

The pool must handle concurrent states cleanly:

- standby still warming when a task arrives
- task assignment while replenishment is being scheduled
- shutdown during standby creation

### Resource Overhead

One idle bundle means steady-state extra resource use:

- one worker container
- one network guard container when required
- one HTTP proxy sidecar when globally enabled
- one mounted bundle-local share directory

This is an accepted tradeoff for lower task-start latency.

## Acceptance Criteria

- Sandy always attempts to keep one standby worker bundle warmed.
- If no standby is ready, the pool provisions the required task bundle itself.
- No worker ever sees more than its own dedicated mounted share.
- Assigned bundles remain one-task-only and are destroyed after task completion.
- HTTP proxy sidecars are included in warmed bundles whenever HTTP token support is globally enabled.
- `DockerSandboxRunner` is slimmer, with pool logic extracted into separate files.
- Existing task behavior remains correct for normal completion, cancellation, privilege flows, share inspection, and cleanup.
