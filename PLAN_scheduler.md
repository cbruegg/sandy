# Scheduled Jobs Implementation Plan

## Goal

Add scheduled jobs to Sandy so the user can ask Sandy to run recurring or one-shot work without manually starting every task.

Terminology:

- **Job**: a persisted schedule definition. A job does not do work by itself; it triggers task executions.
- **Task**: one concrete worker/subagent execution launched by Sandy.
- **`launchedByUser` task**: a task launched from a user chat request. These tasks are always interactive.
- **`launchedByJob` task**: a task launched by a scheduled job. It may remain silent, or it may become interactive if it needs to message the user, request approval, or present reviewable output.

The first implementation should keep Sandy simple: jobs are schedule definitions that invoke existing Sandy skills. Job-specific persistent data lives in a job workspace directory. Tasks launched by jobs shall have immediate r/w access to that directory and be informed about this and the path in the initial prompt.

## User-Facing Behavior

Example use cases:

- Regular cleanup or deduplication of a shopping list.
- Watching internet topics and notifying the user about important updates.

Expected behavior:

1. The user can ask Sandy to create, update, delete, enable, disable, list, inspect, or manually run jobs.
2. Job definitions are persisted on disk and survive restarts.
3. A job can be one-shot or recurring.
4. Recurring schedules use cron syntax as closely as possible.
5. A job references a Sandy skill that contains the execution instructions.
6. Each job has a persistent workspace directory that every execution of that job can access.
7. A `launchedByJob` task can complete silently if it never interacts with the user.
8. If a `launchedByJob` task interacts with the user, it must follow Sandy's usual safety/review flow.

## Non-Goals For The First Version

- Do not introduce a separate job scripting language.
- Do not support multiple simultaneous user-visible tasks.
- Do not make job mutation approvals persistently auto-approvable.
- Do not give the main agent direct mutation power over jobs. Job mutations should happen through worker/subagent tools, matching the existing skill mutation model.

## Data Model

Keep job definition separate from mutable runtime state.

```ts
type JobDefinition = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: JobSchedule;
  skillId: string;
  prompt?: string;
};

type JobSchedule =
  | { kind: "one_shot"; runAt: string }
  | { kind: "cron"; expression: string; timezone?: string };

type JobRuntimeState = {
  jobId: string;
  lastRunAt: string | null;
  lastTaskId: string | null;
};
```

Do not store per-job chat IDs. Sandy should have one persisted default chat destination for the configured channel.

Do not store `nextRunAt`; infer it from the schedule plus `lastRunAt`.

Do not add `createdAt` or `updatedAt` unless a concrete user-visible need appears.

Recommended persisted shape:

```ts
type JobsFile = {
  definitions: JobDefinition[];
  runtimeState: JobRuntimeState[];
};
```

## State Paths

Add a central state path module, for example `src/state-paths.ts`, so state locations are not scattered through the codebase.

It should define helpers for paths such as:

- Sandy state root: `join(configDirectory, "state")`
- Matrix state root: `join(configDirectory, "state", "matrix")`
- Jobs root: `join(configDirectory, "state", "jobs")`
- Jobs file: `join(configDirectory, "state", "jobs", "jobs.json")`
- Job workspace root: `join(configDirectory, "state", "jobs", "workspaces")`
- Per-job workspace: `join(configDirectory, "state", "jobs", "workspaces", jobId)`
- Channel state file: `join(configDirectory, "state", "channel.json")`

Existing Matrix state path construction should be migrated to this module.

## Persisted Default Chat Destination

Sandy currently may be unable to initiate messages after startup until it has seen a Telegram or Matrix chat ID. Add persisted channel destination state.

Behavior:

1. When Sandy receives an authenticated user event, persist the channel's default chat destination.
2. Scheduled jobs use this destination when they need to message the user.
3. If no destination is known yet, scheduled jobs that need user interaction must wait or fail with an internal/logged reason instead of attempting to send to an unknown chat.
4. The local-test channel can keep using its implicit chat behavior.

## Scheduling

Use the `cron` npm package if it works correctly with Bun and TypeScript.

Recurring jobs should be driven by cron jobs managed by Sandy rather than by a custom 60-second ticker. The scheduler service should create, start, stop, and refresh cron timers for enabled recurring jobs.

One-shot jobs still need scheduling. They can be handled by the same scheduler service with timers, or by a cron-library mechanism if the selected library supports one-shot dates cleanly.

Add a `JobScheduler` service with these responsibilities:

1. Load persisted jobs on startup.
2. Validate schedules before registering timers.
3. Start timers for enabled jobs.
4. Stop timers for disabled/deleted/updated jobs.
5. Re-register timers after job mutations.
6. Avoid duplicate launches for the same job if a prior launch attempt is still in progress.
7. Record `lastRunAt` and `lastTaskId` after a task launch succeeds.
8. Stop all timers cleanly during Sandy shutdown.

Cron behavior:

- Cron expressions should mirror standard cron syntax as closely as the library allows.
- Validate cron expressions during create/update.
- Use the configured timezone when provided.
- If no timezone is provided, use Sandy's process/system timezone.
- Guard against catch-up storms. After downtime, a recurring job should not launch once for every missed cron occurrence; it should launch at most once when Sandy is running and the cron fires.

One-shot behavior:

- A one-shot job is eligible only if `lastRunAt === null`.
- If its `runAt` is in the future, schedule a timer for that time.
- If its `runAt` is in the past at startup and it has not run yet, launch it once after scheduler startup, subject to task coordination rules.

## Task Coordination

Sandy currently has a strong one-user-visible-task model. Preserve that safety property.

Add a task coordination layer that tracks task origin and interaction state.

```ts
type TaskOrigin =
  | { kind: "launchedByUser"; chatId: string }
  | { kind: "launchedByJob"; jobId: string };

type JobTaskInteractionState =
  | "silent"
  | "waitingToInteract"
  | "interacting";
```

Rules:

1. `launchedByUser` tasks are always interactive.
2. A `launchedByJob` task starts in `silent` mode.
3. A `launchedByJob` task enters `waitingToInteract` when it needs to send user-visible output, request approval, receive user input, or present reviewable output but a `launchedByUser` task is active.
4. A `launchedByJob` task enters `interacting` when it is allowed to communicate with the user.
5. While a `launchedByJob` task is `interacting`, user messages route to that task instead of the main agent.
6. While a `launchedByUser` task is active, `launchedByJob` tasks that need interaction must wait.
7. A `launchedByJob` task that never interacts with the user may terminate itself without the usual user review step.
8. A `launchedByJob` task that has interacted with the user must perform the usual summarization/review flow. It may initiate that summarization itself.

The implementation can start by adapting the existing session active-task model, but the cleaner long-term shape is a coordinator-owned active task registry with session routing layered on top.

## Worker Pool Reuse

Job-launched tasks must reuse the existing task bundle pool.

The current pool keeps one standby bundle but can track multiple active bundles. Add tests to ensure:

1. More than one bundle can be acquired and active at the same time.
2. Active bundles retire independently.
3. The task bundle assignment registry remains correct with multiple active task IDs.
4. Job-launched tasks use the same launch path and pool as user-launched tasks.

Do not add a second worker pool for scheduled jobs.

## Background Interaction Gate

Add a gate around all user-visible operations from `launchedByJob` tasks.

User-visible operations include:

- Sending chat text.
- Sending task updates.
- Sending files.
- Sending privilege requests.
- Sending final summaries for review.

If no `launchedByUser` task is active, the operation may proceed and the job task becomes `interacting`.

If a `launchedByUser` task is active, the operation must wait. This includes permission escalation requests. A job task can ask for more permissions as usual, but the request must not be shown to the user until the active `launchedByUser` task is complete.
One challenge is that Codex does not wait for MCP tool calls to finish forever, so it will probably keep trying for a while and eventually give up.
We have to ensure that it actually finishes the work once the permission is granted. Let's address this concern at the very end of the implementation.

Queued interactions should flush in order after the blocking user-launched task completes.

## Waiting Reminders

If a `launchedByJob` task is waiting to interact because a `launchedByUser` task is active, Sandy should remind the user after prolonged lack of progress on the user-launched task.

Rules:

1. Wait at least 5 minutes after the latest progress on the `launchedByUser` task.
2. Then send a reminder that an unfinished user-launched task is blocking a scheduled job task.
3. Use exponentially increasing reminder intervals, capped at a reasonable maximum such as 1 hour.
4. Reset reminder timing whenever the `launchedByUser` task makes progress.

Progress includes:

- Worker progress events.
- Assistant output.
- Messages sent to the user.
- Messages received from the user.
- Privilege requests.
- Privilege responses.
- Task lifecycle changes.

All reminder strings must live in `messages.ts`.

## Job Workspace

Each job gets a persistent workspace directory.

Behavior:

1. The workspace is available to every execution of that job.
2. The worker can use it for durable notes, generated files, helper scripts, caches, or state.
3. The job's skill remains the primary instruction source.
4. Workspace paths must be resolved through safe path helpers to avoid path traversal.

Implementation:

Mount the job workspace directly if the sandbox and path safety model supports that cleanly.
Our WebDAV server probably comes in handy there.

## Worker Tools For Job Management

Add Sandy worker tools for job management:

- `list_jobs`
- `get_job`
- `create_job`
- `update_job`
- `delete_job`
- `enable_job`
- `disable_job`
- `run_job_now`

Approval rules:

- `list_jobs` and `get_job` are read-only and do not require user approval.
- `create_job`, `update_job`, `delete_job`, `enable_job`, `disable_job`, and `run_job_now` require explicit user approval.
- Job mutation approvals must not offer an “always approve” option.
- Job mutation payloads shown to the user should include enough detail to validate the change, especially schedule, skill ID, prompt, and enabled state.

The main agent remains an orchestrator. If the user asks to mutate jobs, it should launch a worker task, and the worker should call these tools.

## Job-Scoped Permission Persistence

Tasks launched by jobs use Sandy's normal permission flow.

Additional rules:

1. If a `launchedByJob` task asks for more permission, the request may have to wait behind an active `launchedByUser` task before it is shown to the user.
2. If the user chooses a persistent approval for a permission requested by a job-launched task, persist that approval scoped to the job.
3. A job-scoped approval applies to future executions of the same job.
4. A job-scoped approval does not become a global approval for unrelated user-launched tasks or other jobs.
5. Job mutation operations themselves can never receive persistent approval.

Suggested shape:

```ts
type JobApprovalState = {
  jobId: string;
  mcpTools: Array<{ serverId: string; toolName: string }>;
  mcpResources: Array<{ serverId: string; uri: string }>;
  httpTokens: Array<{ tokenId: string; host: string }>;
  hostDirectories: Array<{ path: string; level: "read_only" | "read_write" }>;
};
```

This may be stored alongside job runtime state or in a separate job approvals file under the centralized jobs state directory.

## Implementation Steps

1. Add centralized state path helpers and migrate existing Matrix state path usage.
2. Add persisted channel destination state.
3. Add job types, validation, and `JobStore`.
4. Add cron/timer scheduling service for one-shot and recurring jobs.
5. Add task origin and interaction state tracking.
6. Add job task launch path reusing the existing task bundle pool.
7. Add the background interaction gate for `launchedByJob` tasks.
8. Add waiting reminders with exponential backoff.
9. Add job workspace provisioning.
10. Add worker tools for job management.
11. Add job mutation approval handling with no persistent approval option.
12. Add job-scoped permission persistence for job-launched task privilege requests.
13. Update README documentation.

## Tests

Add unit and integration coverage for:

- Centralized state paths, including Matrix state path.
- Channel destination persistence.
- Job store load/save/update/delete.
- Job definition and runtime state separation.
- Cron expression validation.
- One-shot scheduling and one-shot consumption.
- Recurring job registration and refresh after mutation.
- Scheduler shutdown stops timers.
- Duplicate job launches are prevented.
- Job-launched tasks reuse the existing task bundle pool.
- Multiple active pool bundles can coexist and retire independently.
- User messages route to an interacting `launchedByJob` task.
- Job-launched interactions wait behind active `launchedByUser` tasks.
- Permission requests from job-launched tasks wait behind active `launchedByUser` tasks.
- Reminder backoff and reset on user-task progress.
- Silent job-launched task self-completion.
- Interacting job-launched task summary/review behavior.
- Job mutation tools require approval.
- Job mutation approvals do not offer “always approve”.
- Job-scoped persistent approvals apply only to future executions of the same job.

Run `bun run build` and `bun run test` after TypeScript/runtime changes.

## Current Implementation Notes

- Centralized state path helpers were added in `src/state-paths.ts`, and Matrix state path construction now uses those helpers.
- Channel default destination state is persisted in `state/channel.json` for non-local-test channels.
- Job definitions and runtime state are persisted in `state/jobs/jobs.json`; recurring job workspaces live under `state/jobs/workspaces/<job-id>`.
- The scheduler supports one-shot jobs and recurring jobs through the `cron` npm package, with duplicate launch protection, refresh after mutations, and shutdown cleanup.
- Task coordination now allows silent job tasks to coexist with a user-visible task. Job tasks move through `silent`, `waitingToInteract`, and `interacting`, and user messages route to an interacting job task.
- A background interaction gate now queues user-visible job-task operations behind the current user-visible flow and flushes them in order once the blocker clears. Permission prompts, files, task updates, and review summaries all go through that gate.
- Waiting reminders now fire after 5 minutes of no progress on the blocking user task, back off exponentially up to 1 hour, and reset whenever the blocking task makes progress.
- Worker job management tools were added. Read-only tools do not require approval; mutation tools require explicit approval through `job_mutation` privilege requests with no persistent approval option.
- Job-launched tasks reuse the existing sandbox/task-bundle launch path and are marked with `origin: launchedByJob` plus a silent/waiting/interacting state. Silent job tasks can complete without summary review.
- Job-scoped approval persistence is now reduced to per-job task policy under `state/jobs/job-approvals.json`: the file remembers which globally persisted MCP servers and HTTP tokens should auto-apply to future executions of that job.
