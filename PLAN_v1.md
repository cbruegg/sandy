# PLAN v1: Host Directory Access via Rclone Volume Plugin + WebDAV Broker

## Status

- State: implemented
- Branch: `main`
- Scope: concrete implementation plan for host-directory access using a stable Docker volume mount backed by `rclone/docker-volume-rclone` and a Sandy-hosted WebDAV broker

## Goals

- Let workers request access to host directories through a Sandy MCP tool.
- Preserve worker context after approval; no worker restart is allowed.
- Support exact approval keys of `[canonical host path, access level]`.
- Treat `read_write` approval as satisfying later `read_only` requests for the same canonical path.
- Expose approved directories to the worker as normal filesystem paths.
- Work on Linux, macOS, and Windows when Sandy is using Linux workers.

## Non-Goals

- No `approve once` mode for host-directory access.
- No eager copying or syncing of whole directories into the task share.
- No attempt to make the Docker volume plugin itself understand Sandy's approval policy.
- No attempt to let the plugin read arbitrary macOS or Windows paths directly.

## Final User Behavior

1. The worker starts with a stable mount at `/workspace/host`.
2. The worker calls a new Sandy MCP tool such as `request_host_directory_access` with:
   - `path`: host filesystem path as given by the user
   - `level`: `read_only` or `read_write`
3. Sandy asks the user for approval with only these choices:
   - `Allow in task`
   - `Auto-allow for suitable tasks`
   - `Deny`
4. If approved, Sandy reveals a new subtree inside `/workspace/host/grants/<grant-id>`.
5. The tool response returns that worker-visible path.
6. The worker uses the returned path like a normal directory.

## Core Design

### Key Idea

The worker's `/workspace/host` mount must exist before the task starts and must never change afterward.

To satisfy that constraint without losing warm bundles:

- each warmed bundle gets its own pre-mounted named Docker volume
- that volume is backed by the managed `rclone` volume plugin
- the plugin mounts a bundle-scoped WebDAV namespace from Sandy
- Sandy initially exposes an empty or minimal synthetic filesystem for that bundle
- approvals later update the broker's grant table, causing new paths to appear inside the already-mounted volume

This avoids dynamic Docker mounts and avoids worker restarts.

### Why Bundle-Scoped Instead of Task-Scoped

The current pool warms running worker containers before task assignment.

That means task-specific volume configuration is too late, but bundle-specific configuration is available at bundle creation time because `bundleId` already exists then.

The mounted hostfs namespace should therefore be keyed by `bundleId`, not `taskId`.

When a bundle is reserved for a task, Sandy associates:

- `bundleId -> taskId`
- `taskId -> bundleId`

Approvals for the active task update the grant table for that bundle namespace.

## Architecture

### 1. Worker MCP Tool

Add a new built-in Sandy worker tool in `src/subagent/worker-tools.ts`.

Proposed shape:

```json
{
  "path": "/Users/alice/project",
  "level": "read_only"
}
```

Behavior:

- this is a privileged native Sandy tool
- the host validates and canonicalizes the path
- on approval the tool returns a worker-visible mount path such as `/workspace/host/grants/7f3c...`

### 2. Host Approval Model

Extend the privilege model with a dedicated request kind for host-directory access.

Required behavior:

- approvals key off the canonicalized host path plus requested level
- `read_write` implies `read_only`
- task-scoped approvals and persistent approvals use the same implication rule
- request prompts must clearly display canonical path and requested level

Do not treat this request as a generic host operation because it has different approval choices and different execution semantics.

### 3. Hostfs Broker

Add a new host-side subsystem, likely under `src/hostfs/`, that owns all host-directory brokering.

Responsibilities:

- maintain bundle-scoped namespaces
- maintain granted directory mappings for each active bundle
- canonicalize and validate requested host paths on the real host OS
- enforce per-path `read_only` vs `read_write`
- serve a synthetic filesystem view over WebDAV
- revoke access when bundles are retired

The broker must perform all real host filesystem I/O itself. This is the cross-platform layer.

### 4. WebDAV Transport

Sandy should expose a local WebDAV service reachable from the Docker daemon/plugin environment at `host.docker.internal`.

Proposed namespace shape:

- `/bundles/<bundleId>/`
- `/bundles/<bundleId>/grants/<grantId>/...`

Authentication:

- generate a random bundle-scoped secret at bundle creation time
- configure the rclone volume for that bundle to authenticate with that secret
- reject all unauthenticated requests
- revoke the secret when the bundle is retired

The broker should not trust any path coming from WebDAV requests beyond the bundle namespace and grant mappings it already owns.

### 5. Rclone Volume Plugin

Reuse `rclone/docker-volume-rclone` as the Docker volume driver.

Plugin role:

- mount the WebDAV namespace into a named volume
- keep the mount stable for the life of the bundle
- surface the mounted path to Docker so Docker can mount it into the worker container

Important constraint:

- the plugin is only the mount client
- it does not know or enforce host approvals
- it does not access arbitrary host paths directly

### 6. Plugin State Directories

Do not store the plugin's config/cache directories on the real host filesystem.

Instead, provision stable paths inside the Docker daemon's Linux environment, for example:

- `/tmp/sandy-rclone-plugin/config`
- `/tmp/sandy-rclone-plugin/cache`

This avoids macOS and Windows path translation problems.

Sandy should ensure these paths exist before plugin installation, likely via a small helper container or equivalent Docker-managed setup step.

### 7. Bundle Lifecycle Integration

At bundle creation time:

1. generate `bundleId`
2. create bundle-scoped broker credentials
3. create a named Docker volume such as `sandy-hostfs-<bundleId>` using the `rclone` driver
4. point that volume at the bundle's WebDAV namespace
5. mount the volume into the worker container at `/workspace/host`

At bundle retirement:

1. revoke bundle credentials
2. drop bundle grant state from the hostfs broker
3. remove the named Docker volume

## Repo Changes

### New Modules

- `src/hostfs/hostfs-broker.ts`
- `src/hostfs/webdav-server.ts`
- `src/hostfs/path-policy.ts`
- `src/hostfs/bundle-registry.ts`
- `src/hostfs/rclone-plugin-manager.ts`
- `src/hostfs/hostfs-volume-manager.ts`

Names can change, but these responsibilities should remain separate.

### Existing Files To Update

- `src/subagent/worker-tools.ts`
- `src/subagent/worker-prompt.ts`
- `src/types/privilege.ts`
- `src/types/task-state.ts`
- `src/messages.ts`
- `src/orchestrator.ts`
- `src/sandbox/task-bundle-types.ts`
- `src/sandbox/task-bundle-launcher.ts`
- `src/sandbox/task-bundle-pool.ts` only if bundle metadata needs to expose hostfs details
- `src/sandbox/docker-sandbox-runner.ts` if new cleanup hooks are needed
- `src/config.ts`
- `src/privilege/persistent-approval-store.ts`
- `src/app.ts`
- `Dockerfile` only if worker images need extra mount/client support beyond what the plugin provides
- `README.md` to document configuration and operational prerequisites

## Detailed Implementation Plan

### Phase 0: Validate the Stack With a Narrow Spike

Status: partially validated through unit tests; full Docker-mounted validation pending manual testing.

Deliverable:

- a minimal proof that a worker container can mount a bundle-scoped `rclone` WebDAV volume at `/workspace/host` and that new directories become visible after the broker updates grant state

Tasks:

- install `rclone/docker-volume-rclone` in managed plugin mode with Sandy-owned paths under `/tmp/sandy-rclone-plugin/...`
- start a tiny host WebDAV server outside the main app
- create a volume manually against `http://host.docker.internal:<port>/bundles/<bundleId>`
- mount it into a test container
- confirm that broker-side grant changes appear inside the mounted path without restarting the container
- measure how aggressive cache settings need to be so newly approved directories appear quickly enough

Exit criteria:

- the mounted tree updates in-place fast enough for the worker UX
- WebDAV semantics are good enough for common worker file operations

### Phase 1: Add Hostfs Infrastructure

Status: completed.

Deliverable:

- hostfs broker and WebDAV service live inside Sandy

Implemented modules:

- `src/hostfs/path-policy.ts` – canonical path resolution and access-level implication
- `src/hostfs/bundle-registry.ts` – bundle-scoped credential issuance
- `src/hostfs/webdav-server.ts` – minimal WebDAV server (PROPFIND, GET, HEAD, OPTIONS)
- `src/hostfs/hostfs-broker.ts` – grant table management and synthetic tree generation

### Phase 2: Install and Manage the Rclone Plugin

Status: completed.

Deliverable:

- Sandy ensures the `rclone` plugin exists and is usable before warming bundles

Implemented modules:

- `src/hostfs/rclone-plugin-manager.ts` – detects, installs, enables, and health-checks the managed plugin

### Phase 3: Create Bundle-Scoped Hostfs Volumes

Status: completed.

Deliverable:

- each warmed bundle has a stable `/workspace/host` mount from creation time onward

Implemented modules:

- `src/hostfs/hostfs-volume-manager.ts` – creates and removes bundle-scoped `rclone` volumes
- `src/sandbox/task-bundle-launcher.ts` – extended to mount hostfs volume at `/workspace/host`
- `src/sandbox/task-bundle-pool.ts` – extended with optional acquire/retire callbacks

### Phase 4: Add the Worker Tool and Approval Flow

Status: completed.

Deliverable:

- workers can request host-directory access through the Sandy MCP server

Changes:

- `src/subagent/worker-tools.ts` – added `request_host_directory_access` tool
- `src/types/privilege.ts` – added `host_directory_access` privilege request kind
- `src/types/task-state.ts` – added `approvedHostDirectories` to `ActiveTaskState`
- `src/orchestrator.ts` – added approval flow with task-scoped and persistent grants, `read_write` implies `read_only`
- `src/messages.ts` – added host-directory access messages
- `src/channel/telegram-adapter.ts` and `src/channel/matrix-adapter.ts` – updated privilege keyboards to exclude `approve once` for host-directory requests

### Phase 5: Persist Exact Approvals

Status: completed.

Deliverable:

- host-directory approvals survive restarts when approved with `Auto-allow for suitable tasks`

Config shape:

```toml
[[approvals.host_directories]]
path = "/Users/alice/project"
level = "read_only"
```

Changes:

- `src/config.ts` – parses `approvals.host_directories` array
- `src/privilege/persistent-approval-store.ts` – persists host-directory approvals to config TOML

### Phase 6: Worker Guidance and UX

Status: completed.

Deliverable:

- workers know when and how to use the feature correctly

Changes:

- `src/subagent/worker-prompt.ts` – updated initial prompt to mention `/workspace/host` and the `request_host_directory_access` tool

### Phase 7: Test Coverage

Status: completed for unit tests; integration and manual tests pending.

Unit tests added:

- `src/hostfs/path-policy.test.ts`
- `src/hostfs/bundle-registry.test.ts`
- `src/hostfs/hostfs-broker.test.ts`
- `src/hostfs/webdav-server.test.ts`
- existing tests updated for new fields and interfaces

Integration-style tests pending:

- `src/sandbox/docker-sandbox-runner.test.ts` or new bundle-launcher tests for added hostfs volume mount wiring
- local-test workflow that requests directory access, approves it, and verifies the worker can read from the returned mount path

Manual validation matrix pending:

- Linux host with Docker Engine
- macOS with Docker Desktop
- Windows with Docker Desktop using Linux containers

## Risks

### WebDAV Semantics and Caching

Rclone's directory and metadata caching may delay visibility of newly granted paths.

Mitigation:

- keep cache settings conservative for the first implementation
- explicitly validate visibility latency in Phase 0

### Plugin Operational Complexity

Managed Docker plugins are harder to debug than normal containers.

Mitigation:

- centralize plugin setup in one manager
- emit explicit startup diagnostics
- document recovery commands for plugin reset/reinstall

### Host Path Semantics Across OSes

Canonicalization and symlink behavior differ between Linux, macOS, and Windows.

Mitigation:

- keep all host path resolution in the Sandy host process
- add OS-specific unit tests where possible

### Warm Bundle Cleanup

Leaving stale volumes or broker state behind will leak access.

Mitigation:

- tie bundle retirement to volume removal and credential revocation
- add cleanup logging and tests for failure cases

## Rollout Strategy

1. Complete Phase 0 before broad implementation.
2. Land hostfs broker and plugin management behind a feature flag if needed.
3. Wire the worker tool and approvals after the mount path is proven stable.
4. Run local-test end-to-end checks on all supported host platforms.
5. Update README configuration and operational docs once the implementation shape is fixed in code.

## Open Questions To Resolve During Phase 0

- Which exact `rclone` options provide the best freshness/performance tradeoff for dynamically appearing grant directories?
- Is WebDAV sufficient for the worker's common rename, stat, and directory traversal patterns?
- Do we need periodic broker-side invalidation hints or is low-cache configuration enough?
- Should the first shipped version restrict `read_write` to directories only, with explicit rejection for single files, to reduce policy complexity?
