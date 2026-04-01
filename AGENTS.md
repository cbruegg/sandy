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

- `npm install`: install project dependencies.
- `npm run build`: compile TypeScript to `dist/`.
- `npm start`: run the built host application from `dist/index.js`.
- `npm test`: rebuild and run the Node test suite from compiled output.
- `docker build -t sandy-subagent:latest .`: build the worker container image used by sub-agents.

Run `npm test` before committing changes that affect runtime logic.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules and 2-space indentation. Prefer small modules with explicit types at subsystem boundaries. Use:

- `kebab-case` for file names such as `main-agent-controller.ts`
- `PascalCase` for classes and exported types
- `camelCase` for functions and variables

There is no formatter or linter configured yet, so keep style consistent with the existing code and avoid unrelated reformatting.

## Testing Guidelines

Tests use the built-in Node test runner via `node --test`. Place tests next to the related code as `*.test.ts`. High test coverage is expected for orchestration behavior, normalization, privilege routing, and failure handling. Prefer small fakes over networked or Docker-backed integration in unit tests.

## Commit & Pull Request Guidelines

Follow the existing commit style: short, imperative summaries such as `Implement Sandy orchestration skeleton` or `Use stdio for sub-agent control channel`.

## Documentation Maintenance

Keep `README.md` aligned with the actual implementation, especially status, supported features, setup steps, and configuration. Also keep the active `PLAN*.md` document up to date with the current implementation status and any meaningful scope or architecture changes made during the work.
