> _User:_ This branch implements @PLAN_scheduler.md. My main concern now is added, avoidable complexity, unclear responsibilities (i.e. violations of the single responsibility principle), ambiguity (i.e. which file handles what) and unclear code paths. Investigate what changed in this branch and propose changes that would result in clearer architecture.

**Summary**
The scheduler/storage layer is fairly small. The avoidable complexity is mostly in orchestration: “what may be shown to the user now?” is spread across `TaskCoordinator`, `task-lifecycle`, `privileges`, `WorkerToolsHandler`, and raw `channel` calls.

**Highest-Value Changes**

| Priority | Proposed change | Why | Feedback |
| :--- | :--- | :--- | :--- |
| 1 | Rename/model `session.activeTask` as `visibleTask`, or introduce a `VisibleTaskSlot` owned by `TaskCoordinator`. | `activeTask` no longer means all active work; background job tasks are active too. Current routing depends on a job being promoted into `session.activeTask` before user messages route to it. See `src/types/task-state.ts:70-78`, `src/orchestrator/index.ts:53-58`, `src/orchestrator/task-coordinator.ts:93-99`. | Good idea |
| 2 | Make `TaskCoordinator` own one unified queue of deferred user-visible items. | It currently has separate queues for job interactions and share-deletion prompts, while lifecycle still decides some prompt timing. Move job interactions, share-deletion prompts, and final review summaries into one queue. See `src/orchestrator/task-coordinator.ts:23-24`, `src/orchestrator/task-lifecycle.ts:329-342`, `src/orchestrator/task-lifecycle.ts:517-543`. | Good idea |
| 3 | Route all task-originated channel sends through one `TaskVisibleOutput`/`TaskOutputGate` abstraction. | Gate coverage is manual and scattered across lifecycle, privileges, and worker tools. This makes future bypasses likely. See `src/orchestrator/task-lifecycle.ts:88-98`, `src/orchestrator/privileges.ts:399-400`, `src/orchestrator/privileges.ts:672-673`, `src/subagent/worker-tools-handler.ts:24-42`. | Already done separately |
| 4 | Split job worker-tool handling out of `privileges.ts`. | Job tool schema is in `worker-tools.ts`, read-only execution is in `WorkerToolsHandler`, mutation request construction is in `privileges.ts`, and mutation execution is in `ScheduledJobService`. Create a `JobToolController`/`JobMutationPrivilegeHandler` under `src/jobs/` and let `privileges.ts` only gate approval. See `src/subagent/worker-tools.ts:110-131`, `src/subagent/worker-tools-handler.ts:44-50`, `src/orchestrator/privileges.ts:279-318`, `src/jobs/job-service.ts:26-53`. | Good idea |
| 5 | Resolve job workspace policy: all jobs or only recurring jobs. | The plan says every job gets a workspace, but code gives workspaces only to cron jobs and text says “recurring job”. Prefer all jobs for consistency. See `src/jobs/job-scheduler.ts:90`, `src/jobs/job-task-brief.ts:7`, `README.md:217-219`. | This was stale in the plan and is working as intended now |
| 6 | Remove stale `prompt` from job tool schema and plan, or implement it fully. | The current persisted `JobDefinition` rejects `prompt`, but worker tool input accepts it. That creates a confusing API. See `src/subagent/worker-tools.ts:115-122`, `src/jobs/job-validation.ts:11-17`. | Investigate |
| 7 | Serialize `JobStore` read-modify-write operations. | Scheduler launch recording and worker-triggered mutations can race and lose writes. Add one internal `updateJobsFile(fn)` path with a mutex. See `src/jobs/job-store.ts:22-70`. | Good idea |
| 8 | Make one-shot `run_now` consumption explicit. | A future one-shot manually run via `runNow` can still have its original timer registered. Re-check `lastRunAt` inside the timer callback or refresh/stop after `runNow`. See `src/jobs/job-scheduler.ts:41-45`, `src/jobs/job-scheduler.ts:49-68`. | Investigate |
| 9 | Move `ChannelDestinationStore` out of `ChannelAdapter`. | Destination persistence is transport-independent state, but is accessed through `channel.destinationStore` from orchestrator and app wiring. Inject it explicitly at composition. See `src/channel/channel-adapter.ts:12-14`, `src/orchestrator/index.ts:28`, `src/app.ts:344-349`. | Investigate |
| 10 | Make task origin required and discriminated. | Optional `origin`/`interactionState` forces fallback branches and hides invalid states. Model user tasks and job tasks as distinct variants. See `src/types/task-state.ts:39-60`, `src/orchestrator/task-coordinator.ts:76-84`. | I think this is obsolete already, already non-optional. |

**Suggested Target Boundaries**
- `src/jobs/`: job definitions, validation, persistence, scheduling, workspace policy, job mutation execution.
- `TaskCoordinator`: owns visible-slot state and all deferred user-visible work.
- `task-lifecycle`: launches/closes tasks and records summaries; it should enqueue visible output, not decide visibility rules.
- `privileges.ts`: owns privilege request lifecycle only; delegates job mutation and worker-tool specifics.
- `src/channel/`: transport only; destination persistence should be injected beside the adapter, not attached to it.

**Small Cleanup**
Add `TaskCoordinator.stop()` / `BlockedJobReminderScheduler.stop()` and call it during shutdown; reminder timers currently have no explicit shutdown path.