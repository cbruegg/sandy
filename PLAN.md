# Skill Editing Plan

## Goal

Make Sandy skill editing easier while keeping skills on the filesystem.

Required outcomes:

- Sandy must not require a restart after skill files are added, edited, or removed.
- Sandy's main agent/controller must be able to add, edit, and remove skills at the user's request.
- Every add/edit/remove operation must require a manual user approval.
- No auto-approval mode of any kind may be supported for these skill-management operations.

## Current State

- Skill metadata is discovered once during config parsing via `discoverSkills(configDirectory)` in `src/config.ts`.
- The resulting `config.skills` snapshot is passed into `CodexMainAgentController` at startup in `src/app.ts`.
- Worker bundles already mount the configured skills directory read-only into each worker container in `src/sandbox/task-bundle-launcher.ts`.
- The main agent only includes configured skill metadata on the initial turn of a chat in `src/agent/main-agent-controller.ts`.
- The main agent cannot directly mutate host files today; it can only return `reply` or `launch_task` decisions.
- Existing privilege flows support once, worker-session, and persistent approvals for some request types, which is explicitly not acceptable for skill edits.

## Design Decisions

### 1. Keep the skills directory path stable

The skills directory path can remain fixed for Sandy's whole process lifetime. The contents of that directory may change.

Consequence:

- New worker tasks can continue to mount the same directory read-only.
- Because workers mount the host skills directory, new tasks should see updated skill files without any Sandy restart.

### 2. Refresh skill metadata at runtime instead of only at startup

The main-agent skill list must no longer be a startup snapshot.

Instead:

- Sandy should re-read current skill metadata from disk when the main agent makes a decision.
- The task-launch path should continue using the stable skills directory mount path.

This is sufficient to guarantee no restart is needed for future main-agent decisions and future worker tasks.

### 3. Sandy, not the model, should render `SKILL.md`

To reduce malformed skill writes, the host-side implementation should accept structured skill fields rather than raw freeform `SKILL.md` for normal create/update flows.

Recommended structured inputs:

- `skillId` or directory slug
- `name`
- `description`
- `body`

Sandy should then render `SKILL.md` itself in a consistent format.

### 4. Skill management must use a dedicated approval path

Skill creation, editing, and deletion should not reuse approval behavior that supports session or persistent grants.

Instead:

- introduce a dedicated privilege-request kind for skill mutations
- expose only manual `approve` and `deny` responses
- do not persist any approval state for skill mutations
- do not support any task-policy-driven auto-approval for skill mutations

## Planned Changes

### A. Add a runtime skill service

Create a host-side service responsible for skill discovery and mutation.

Suggested responsibilities:

- expose the fixed skills directory path
- discover current skill metadata from disk on demand
- validate requested skill identifiers
- create a skill directory and `SKILL.md`
- update an existing skill's `SKILL.md`
- delete an existing skill directory

Suggested API shape:

- `getSkillsDirectory(): string`
- `getSkills(): SkillMetadata[]`
- `createSkill(input)`
- `updateSkill(input)`
- `deleteSkill(input)`

The implementation should reuse the existing parsing rules in `src/skills.ts` where possible.

### B. Stop treating skills as startup-only runtime state

Replace long-lived uses of `config.skills` for runtime behavior with live lookups from the skill service.

Specifically:

- `CodexMainAgentController` should read the current skills list at decision time
- worker launch should continue to use the fixed directory path rather than a mutable snapshot

### C. Make the main agent aware of skill changes on later turns

Today, configured skills are only included in the prompt on the initial turn of a chat. That would leave an existing chat thread with stale skill information after edits.

Recommended change:

- include current skill metadata on every main-agent decision prompt, not only the first turn

This is the simplest way to ensure the main agent notices added, changed, or removed skills without resetting its chat thread.

### D. Add Sandy-native worker tools for skill management

Extend `src/subagent/worker-tools.ts` with dedicated host-mediated tools for skill changes.

Suggested tools:

- `create_skill`
- `update_skill`
- `delete_skill`

Suggested payloads:

- `create_skill { skillId, name, description, body }`
- `update_skill { skillId, name, description, body }`
- `delete_skill { skillId }`

The tool schemas should be strict and fully validated.

### E. Add a dedicated privilege request type for skill mutations

Extend `src/types/privilege.ts` with a new request kind for skill edits.

Suggested request variants:

- create skill request
- update skill request
- delete skill request

The request should include enough structured detail for user review, but approval UX should remain concise.

### F. Restrict approval controls for skill mutations

Update `src/channel/control-surface.ts` so skill-mutation privilege requests expose only:

- `Approve`
- `Deny`

Explicitly do not expose:

- `Approve once`
- `Allow in task`
- `Auto-allow for suitable tasks`

### G. Resolve approved skill mutations in the orchestrator

Extend `src/orchestrator/privileges.ts` so approved skill-mutation requests call the runtime skill service.

Expected behavior:

- on approval, apply the requested filesystem mutation
- on denial, report a denied result
- on failure, report a failed result with a useful error message
- never convert approval into reusable session scope or persistent scope

### H. Teach the main agent when to use skill-management tools

Update the main-agent prompt in `src/agent/main-agent-controller.ts` so it knows:

- Sandy can manage skills through launched sub-agent tasks
- skill add/edit/remove requests should usually launch a task instead of receiving a direct reply
- each mutation will later require explicit user approval
- no auto-approval exists for these operations

### I. Keep worker mounts read-only

Workers should continue receiving the skills directory as a read-only mount.

This preserves the security boundary:

- workers can inspect skills
- workers cannot modify host skill files directly
- all modifications remain mediated by Sandy's host approval flow

## Validation and Error Handling

The skill service should reject malformed or unsafe operations, including:

- invalid or unsafe skill directory identifiers
- creation of a skill that already exists
- update or deletion of a missing skill
- invalid rendered frontmatter inputs such as missing name or description

Deletion should remove only the intended skill directory under the configured `skills/` root.

## Testing Plan

Add or update tests for the following:

1. Skill discovery and runtime freshness
   - re-reading skill metadata after on-disk create/update/delete changes

2. Main-agent prompt behavior
   - current skills are included on later turns, not only the initial turn
   - updated skill metadata becomes visible without restarting Sandy

3. Worker tool parsing
   - `create_skill`, `update_skill`, and `delete_skill` payload validation

4. Approval controls
   - skill-mutation requests expose only approve/deny controls
   - no session or persistent approval buttons appear

5. Orchestrator privilege resolution
   - approved create/edit/delete requests call the skill service
   - denied requests do not modify the filesystem
   - failures surface appropriate messages

6. Skill file rendering
   - host-side rendering produces valid `SKILL.md`
   - malformed structured inputs are rejected before write

7. End-to-end local behavior where practical
   - add a skill, then launch a new task and confirm the new skill is available without restart
   - edit or delete a skill, then confirm later main-agent decisions reflect the change without restart

## Implementation Order

1. Add the runtime skill service and host-side `SKILL.md` renderer.
2. Rewire the main agent to fetch live skill metadata on each decision.
3. Add skill-management worker tools and schemas.
4. Add dedicated privilege-request types and approval messaging.
5. Extend orchestrator privilege resolution to execute approved skill mutations.
6. Update control surfaces to remove any non-manual approval options for skill mutations.
7. Add and update tests.
8. Update `README.md` if needed to document that skills are live-reloaded for new decisions and new tasks without restart.

## Success Criteria

This work is complete when all of the following are true:

- Editing skill files on disk does not require restarting Sandy for future main-agent decisions or future worker tasks.
- Sandy can add, edit, and remove skills at the user's request through its normal task flow.
- Every skill mutation requires a fresh manual user approval.
- No session-scoped, once-scoped, persistent, or task-policy auto-approval path exists for skill mutations.
- Workers still receive the skills directory read-only.
