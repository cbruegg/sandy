# Repository Guidelines

## Project Structure & Module Organization

Sandy is a TypeScript project with the application code under `src/`.

- `src/app.ts` boots the host runtime.
- `src/orchestrator.ts` contains the core routing and safety logic.
- `src/channel/` holds channel adapters, currently Telegram.
- `src/agent/` contains main-agent integration.
- `src/sandbox/` contains sub-agent launch and control code.
- `src/subagent/worker.ts` is the container-side worker entrypoint.
- `src/session/` contains session persistence, currently in-memory only.
- `*.test.ts` files in `src/` are the test suite.
- `Dockerfile` builds the worker image.
- `PLAN_v1.md` tracks the current implementation plan and status.

## Build, Test, and Development Commands

- `bun install`: install project dependencies and update `bun.lock`.
- Agents may run `bun install` when dependencies are missing or `bun.lock` changes require it.
- `bun run build`: run linting, explicit TypeScript type-checking, Bun bundling, and `knip`.
- `bun start`: run the host application from `src/entrypoint-main.ts` with Bun.
- `bun run test`: rebuild and run the Bun test suite.
- `bun run build:exe`: build the host single-file executable.
- `docker build --target worker-runtime -t sandy-subagent:latest .`: build the worker container image used by sub-agents.
- `docker build --target mcp-proxy-runtime -t sandy-mcp-proxy:latest .`: build the MCP proxy container image.
- `./scripts/run-local-dev.sh`: build both local runtime images and start Sandy. By default it derives a temporary local-test config from `config/config.toml`, overrides the channel to `local_test`, and prints the derived config plus inbox/outbox paths. Pass `--channel telegram` to use `config/config.toml` directly.
- `./scripts/run-local-test-cli.sh ...`: helper CLI for the local-test channel. Prefer this over hand-writing inbox/outbox files so protocol details stay conformant.

Run both `bun run build` and `bun run test` after making changes that affect TypeScript or runtime logic, and always before committing such changes. The explicit build step matters even when tests pass, because it verifies the full project still type-checks and bundles cleanly under Bun.
Do not run `bun run build` and `bun run test` in parallel: `bun run test` already invokes `bun run build`, and running them concurrently can race on the shared `dist/` output.

## Autonomous Testing

For autonomous interaction testing, do not use Telegram unless the task explicitly requires Telegram behavior. Start Sandy with `./scripts/run-local-dev.sh`, let it boot into the derived `local_test` channel, and use the printed spool paths only as references.

Use the helper CLI for as much as possible:

- `./scripts/run-local-test-cli.sh send --spool-root <spool-root> --text "..."` to send user text
- `./scripts/run-local-test-cli.sh attach --spool-root <spool-root> --file /abs/path/to/file --text "..."` to send attachments
- `./scripts/run-local-test-cli.sh approve|deny --spool-root <spool-root> --request-id <id> ...` for approval responses
- `./scripts/run-local-test-cli.sh cancel|mark-finished|report-danger --spool-root <spool-root> ...` for control actions
- `./scripts/run-local-test-cli.sh wait-for|tail|list-events --spool-root <spool-root> ...` to inspect Sandy output

The local-test channel supports exactly one implicit chat, so agents do not need to discover or pass a chat ID. Prefer the helper CLI over raw spool file edits so message IDs, timestamps, event shapes, and approval payloads remain valid. Raw `inbox/` and `outbox/` manipulation is only for debugging the local-test channel implementation itself.

Typical flow:

- Run `./scripts/run-local-dev.sh`
- Use the printed helper CLI command shape to send a `user_message` event
- Wait for `send_privilege_request` or `send_task_update` via `./scripts/run-local-test-cli.sh wait-for ...`
- Reply with `./scripts/run-local-test-cli.sh approve ...` or `deny ...`
- Verify the final `send_text` or `send_file` event through `wait-for`, `tail`, or `list-events`

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules and 2-space indentation. Prefer small modules with explicit types at subsystem boundaries. Use:

- `kebab-case` for file names such as `main-agent-controller.ts`
- `PascalCase` for classes and exported types
- `camelCase` for functions and variables

Sandy is an application, not a library. There is no stable public API surface; all exported symbols are internal implementation details and subject to change without notice. Do not add `@public` annotations or maintain exported functions solely for external consumption.

Keep all user-facing strings in `messages.ts` instead of scattering literals through runtime logic. This includes any text the user can see through a channel such as Telegram task updates, prompts, status messages, errors, summaries, and button labels. Add new channel-visible strings there so future i18n work stays localized.

There is no formatter or linter configured yet, so keep style consistent with the existing code and avoid unrelated reformatting, especially w.r.t. to indentation.
Keep the runtime dependency graph acyclic. Do not introduce circular construction or callback wiring between core services when a direct dependency order or extracted helper can express the relationship cleanly.
Avoid module-scope mutable runtime state. Keep mutable coordination state inside explicit objects or function scopes so concurrent work does not share hidden globals.
When code depends on process environment values, inject an env object at the function boundary so tests do not need to mutate the global `process.env`.
Do not make dependencies optional merely so production code can fall back to globals while tests override them. If a function or class needs injectable collaborators, require them explicitly and provide production values at the composition boundary.
Do not make functions return a Promise when they can complete synchronously. Prefer plain synchronous return types unless the implementation actually needs asynchronous behavior.

## Testing Guidelines

Tests use Bun's test runner via `bun test`. Place tests next to the related code as `*.test.ts`. High test coverage is expected for orchestration behavior, normalization, privilege routing, and failure handling. Prefer small fakes over networked or Docker-backed integration in unit tests.
Do not make properties or parameters nullable merely to avoid constructing fakes or dummies in tests. Prefer explicit test doubles at the boundary so production dependencies stay accurately typed.
Prefer `$projectDir/tmp` over `/tmp` when creating temporary files or directories during the dev/test cycle. Accessing `/tmp/` may require user approval on each invocation, while project-local `tmp/` avoids that friction.
Do not commit without asking, unless the user specifically requested it.

## Maintenance

Keep `README.md` aligned with the intended target architecture, setup steps, and configuration. Keep the active `PLAN*.md` document aligned with the current implementation status, completed work, and known gaps relative to that target.
When adding a new build artifact, image, executable, or other release output, update the publication pipeline and release documentation in the same change so published builds do not reference artifacts that were never pushed.
