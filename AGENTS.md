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
- `bun run build`: run linting, explicit TypeScript type-checking, Bun bundling, and `knip`.
- `bun start`: run the host application from `src/entrypoint-main.ts` with Bun.
- `bun run test`: rebuild and run the Bun test suite.
- `bun run build:exe`: build the host single-file executable.
- `docker build --target worker-runtime -t sandy-subagent:latest .`: build the worker container image used by sub-agents.
- `docker build --target mcp-proxy-runtime -t sandy-mcp-proxy:latest .`: build the MCP proxy container image.

Run both `bun run build` and `bun run test` before committing changes that affect TypeScript or runtime logic. The explicit build step matters even when tests pass, because it verifies the full project still type-checks and bundles cleanly under Bun.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules and 2-space indentation. Prefer small modules with explicit types at subsystem boundaries. Use:

- `kebab-case` for file names such as `main-agent-controller.ts`
- `PascalCase` for classes and exported types
- `camelCase` for functions and variables

Keep all user-facing strings in `messages.ts` instead of scattering literals through runtime logic. This includes any text the user can see through a channel such as Telegram task updates, prompts, status messages, errors, summaries, and button labels. Add new channel-visible strings there so future i18n work stays localized.

There is no formatter or linter configured yet, so keep style consistent with the existing code and avoid unrelated reformatting.

## Testing Guidelines

Tests use Bun's test runner via `bun test`. Place tests next to the related code as `*.test.ts`. High test coverage is expected for orchestration behavior, normalization, privilege routing, and failure handling. Prefer small fakes over networked or Docker-backed integration in unit tests.

## Documentation Maintenance

Keep `README.md` aligned with the intended target architecture, setup steps, and configuration. Keep the active `PLAN*.md` document aligned with the current implementation status, completed work, and known gaps relative to that target.
