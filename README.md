# Sandy

Sandy aims to be a safer alternative to the OpenClaw agent, executing actions in a sandboxed environment
with granular control over the agent's capabilities.

This README describes Sandy's intended target architecture and product direction. For the current v1 implementation
status, completed work, and known gaps relative to that target, see `PLAN_v1.md`.

## Usage

### Prerequisites

- Bun 1.3 or newer.
- Docker installed and available as `docker`.
- A Telegram bot token.
- The Telegram numeric user ID or username of the one person allowed to control Sandy.
- Either:
  - a local Codex ChatGPT login on the host machine, or
  - an OpenAI API key.

### Configuration

Sandy reads its runtime config from `~/.config/sandy/config.toml` by default.
The only environment variable still used for configuration is:

- `SANDY_CONFIG_FILE`: optional override for the Sandy config file path.

If the config directory contains a sibling `skills/` folder, Sandy loads
[skills](https://developers.openai.com/codex/skills) from there at startup.
For the default config path, that means `~/.config/sandy/skills/`.

Example config:
Commented entries below show built-in defaults. Uncommented values are required or example overrides.

```toml
[logging]
# level = "info"

[channel]
kind = "telegram" # or "local_test"

[channel.telegram]
bot_token = "123456:telegram-token"
allowed_user = "123456789" # or "@cbruegg"

[channel.local_test]
# spool_root = "/tmp/sandy-local-test"

[auth]
# codex_auth_file = "~/.codex/auth.json"
# openai_api_key = "sk-..." # optional override, no default

[worker]
# image = "sandy-subagent:latest" # explicit override; otherwise Sandy uses a baked GHCR sha tag when present, or this local default
# share_root = "/tmp/sandy-shares"

[worker.preinstall]
# commands = [
#   "zypper --non-interactive install jq",
#   "brew install gh"
# ]
# refresh = "weekly" # one of: "weekly", "manual"

# Optional STT config for voice message support.
# If `stt.api_key` is not set, voice messages are not supported and will be rejected with an error message.
[stt]
# api_key = "stt-api-key" # optional override, no default
# base_url = "https://api.openai.com/v1"
# model = "gpt-4o-mini-transcribe"

# Optional:
[mcp]
# sidecar_image = "sandy-mcp-proxy:latest" # explicit override; otherwise Sandy uses a baked GHCR sha tag when present, or this local default

[updates]
# mode = "disabled" # one of: "disabled", "relaunch", "exit"

[mcp.servers.todoist]
# Currently the only allowed transport:
transport = "streamable_http"
url = "https://todoist.example/mcp"
# oauth_scopes = []

[approvals.mcp.todoist]
# always_allow_tools = []
```

Telegram auth behavior:

- `channel.kind = "telegram"` requires `channel.telegram.allowed_user`. Set it to either a numeric Telegram user ID or a username like `@cbruegg`.
- Username values are matched case-insensitively after removing a leading `@`.
- Sandy ignores every Telegram update whose sender does not match `channel.telegram.allowed_user`.
- Sandy also ignores all non-private Telegram chats, even when the sender matches the configured user.

Local test channel behavior:

- `channel.kind = "local_test"` uses a file-backed inbox/outbox transport for autonomous local testing.
- `channel.local_test.spool_root` is the root directory that contains `inbox/`, `inbox-processed/`, `inbox-failed/`, and `outbox/`.
- The local-test channel supports exactly one implicit chat, so there is no chat-ID discovery step.
- The poll interval is fixed in code and is not configurable.
- The recommended way to interact with this channel is `./scripts/run-local-test-cli.sh ...`, not direct file editing.

Codex auth behavior:

- If the host already has Codex logged in with ChatGPT and `auth.codex_auth_file` exists, Sandy mounts that file into the sub-agent container automatically.
- If `auth.openai_api_key` is set and no Codex auth file is available, Sandy passes the API key to the main agent and sub-agent worker.
- If both are present, Sandy prefers the Codex ChatGPT auth file and does not pass the API key.
- OAuth for upstream MCP servers is handled on the host through the Sandy CLI, not inside Telegram chats.

MCP OAuth behavior:

- `mcp.servers.<name>.oauth_scopes` optionally sets OAuth scopes to request during `sandy mcp login <name>`.
- Sandy runs upstream MCP connections from an MCP sidecar container, not from the host process directly.
- If an MCP server runs on the same host as Sandy, use `http://host.docker.internal:<port>/...` when configuring `mcp.servers.<name>.url`.

Update behavior:

- `updates.mode` defaults to `"disabled"`.
- `updates.mode = "disabled"` turns off automatic executable updates.
- `updates.mode = "relaunch"` stages an update, exits once idle, and has the updater relaunch Sandy directly.
- `updates.mode = "exit"` replaces the on-disk Sandy executable first and then exits the running process so an external supervisor can restart it.
- If you use `updates.mode = "exit"` under systemd, configure the unit with `Restart=always`. In this mode Sandy does not relaunch itself after updating.
- If you explicitly pin `worker.image` or `mcp.sidecar_image`, you must also set `[updates].mode = "disabled"`. Sandy refuses to start with pinned Docker images while automatic updates remain enabled in either `"relaunch"` or `"exit"` mode.

Worker preinstall behavior:

- `worker.preinstall.commands` is an ordered list of Docker build-time shell commands used to create a local derived worker image on top of `worker.image`.
- If `worker.preinstall.commands` is empty, Sandy launches workers from `worker.image` directly.
- If `worker.preinstall.commands` is configured, Sandy reconciles the derived worker image during startup before it begins serving chats.
- `worker.preinstall.refresh = "weekly"` keeps the derived image on a persisted 7-day cadence from the last successful rebuild, even across Sandy restarts.
- `worker.preinstall.refresh = "manual"` disables scheduled refreshes; Sandy still rebuilds when the configured commands change, the cached overlay is missing, or the base `worker.image` resolves to a different image ID.
- The derived worker image is local cache state. It does not count as an explicit `worker.image` override, so the existing `updates.mode` rules still apply only to the configured base image.

Skills behavior:

- Sandy looks for skills only in a `skills/` directory next to the active `config.toml`.
- Sandy parses only the skill `name` and `description` from the leading frontmatter block in `SKILL.md`.
- The main agent receives only that metadata and is instructed to delegate requests that require one of those skills to a sub-agent.
- Skills are loaded only during Sandy startup. If you add, remove, or edit a skill, restart Sandy before the change will take effect.

### Build and run

Install dependencies:

```bash
bun install
```

Build the worker image:

```bash
docker build --target worker-runtime -t sandy-subagent:latest .
```

Build the MCP sidecar image:

```bash
docker build --target mcp-proxy-runtime -t sandy-mcp-proxy:latest .
```

The host runtime is intentionally not containerized, because it is designed to mediate host-system access directly.

Published Sandy executables built in GitHub Actions are baked with the matching `github.sha` and default to
`ghcr.io/<owner>/sandy-subagent:sha-<git revision>` and `ghcr.io/<owner>/sandy-mcp-proxy:sha-<git revision>`.
Local `bun start` runs and locally built executables fall back to `sandy-subagent:latest` and
`sandy-mcp-proxy:latest` unless the config file overrides them.

Build the Bun bundles and verify linting, TypeScript type-checking, and dependency hygiene:

```bash
bun run build
```

Run lint checks:

```bash
bun run lint
```

Run TypeScript type-checking explicitly:

```bash
bun run typecheck
```

Start Sandy:

```bash
bun start
```

Start Sandy in local autonomous test mode:

```bash
./scripts/run-local-dev.sh
```

Send and inspect local-test channel events with the helper CLI:

```bash
./scripts/run-local-test-cli.sh send --spool-root /tmp/sandy-local-test-XXXXXX/spool --text "inspect the repo"
./scripts/run-local-test-cli.sh wait-for --spool-root /tmp/sandy-local-test-XXXXXX/spool --type send_task_update
./scripts/run-local-test-cli.sh list-events --spool-root /tmp/sandy-local-test-XXXXXX/spool
```

Manage MCP server auth:

```bash
bun start -- mcp list
bun start -- mcp status todoist
bun start -- mcp login todoist
bun start -- mcp logout todoist
```

The host emits structured JSON logs to stdout/stderr for significant events such as startup, Telegram message handling,
main-agent decisions, task lifecycle transitions, privilege requests, and sandbox/container failures.
If `logging.debug=true`, those logs also include full user message content and model responses, which may contain sensitive
data.

Run tests:

```bash
bun run test
```

Build single-file executables:

```bash
bun run build:exe
bun run build:exe:updater
bun run build:exe:worker
bun run build:exe:mcp
```

`bun run build` still performs explicit TypeScript type-checking via `tsc --noEmit`; Bun’s runtime transpilation is not used as a substitute for static type-checking.

## Architecture

At its core, Sandy wraps an existing agent tool, which for now will be the OpenAI Codex agent using the Codex SDK.
Over time, it might make sense to use the [Pi agent](https://github.com/badlogic/pi-mono/tree/main/packages/agent),
providing a more flexible API that is not tied to a specific LLM provider.

Sandy receives messages from the user through a channel abstraction.
This repository includes both a Telegram adapter and a file-backed `local_test` adapter for autonomous local testing.
Each channel also defines its own formatting contract for user-visible agent output.

Allowed message types are text messages, file uploads (with images receiving dedicated handling) and voice messages.
Voice messages are transcribed to text using STT, and the resulting text is then processed as a normal text message.
In the current implementation, voice support is enabled only when `stt.api_key` is configured. By default,
Sandy sends STT requests to the OpenAI API with `gpt-4o-mini-transcribe`, and the endpoint can be overridden with an
OpenAI-compatible base URL.

Whenever the user sends a message, Sandy lets the wrapped agent tool evaluate the message to determine what to
do with it:

- Launch a sub-agent in a sandboxed environment to execute the user's command, if it is not related to any ongoing 
  command execution.
  - Sandy assigns the sub-agent a unique name, ideally based on the command being executed.
  - Sandy then immediately responds to the user with a message indicating that the command is being executed,
    and that they will receive updates on the progress.
  - Responses from the sub-agent are sent back to the main agent, which then forwards them to the user as updates on
    the command execution.
    - To prevent prompt injection, by default the main agent is not allowed to see the responses from the sub-agent.
      Instead, the sub-agent sends them to the host runtime over its container control channel, which then forwards them
      to the user.
    - When the user sees a dangerous response, they can report it to the main agent. Depending on the channel,
      this can either be through a well-defined emoji reaction or a predefined phrase.
      The main agent then immediately terminates the sub-agent, discards its responses and notifies the user of the
      termination.
    - If the user's message after a response is not a report, Sandy may expose that response to the main agent on a
      later decision turn once it is no longer quarantined.
  - Sub-agents determine their own completion and notify Sandy when they are done, at which point Sandy sends a final
    message to the user with the results.
- Route the message to the appropriate sub-agent if it is related to an ongoing command execution.
- Cancel a sub-agent if the user requests it, and notify the user of the cancellation.
- Respond to the user with a message, without launching a sub-agent.

The main-agent thread for a chat is persistent so Codex can benefit from context caching. Sandy does not keep a full
host-side conversation transcript for the main agent. Instead, it keeps only the quarantine state and feeds the main
agent the newly visible entries relevant to each decision turn.

## Safety

Sub-agents do not receive the full message history from the main agent. The main agent only tells them what they need to
know to execute the command, and nothing more. This way, if a sub-agent is compromised, it does not have access to the
full context of the conversation.

The main agent itself is also restricted. Its Codex thread runs with approval requests disabled, a read-only sandbox,
and a fresh temporary working directory rather than the Sandy repository root. This keeps the controller focused on
classification and orchestration instead of local execution.

Sub-agents are launched in isolated containers, initially using Docker.
Allowed interfaces are internet access, a per-sub-agent shared volume for file exchange and the container control
channel to the host runtime.
- The host mounts a cached Linux Codex binary into each worker container read-only so workers do not re-download it.
- If configured, the host also mounts the Sandy `skills/` directory read-only into each worker at `$HOME/.agents/skills`.

User file uploads are a normal channel capability rather than a privileged host operation. Sandy downloads uploaded
files directly into the target sub-agent's shared workspace before launch, and can also stage additional uploads into
the same workspace while a task is running.

Sub-agents may also send files that already exist under `/workspace/share` back to the user through the active channel
without privilege escalation. This channel-file send path is deterministic and bypasses the main agent in the same way
as quarantined visible output.

Inside the sub-agent container, Codex itself runs without an additional nested sandbox. Docker is the isolation
boundary for v1, which avoids bubblewrap/user-namespace failures inside the container.

Inside their sandbox, agents are free to install any dependencies or tools they need to execute the command.
The default worker image is based on openSUSE Tumbleweed and also includes Homebrew. The worker tells Codex when
`zypper` and `brew` are available so it can use `zypper` for system packages and `brew` for fast-moving CLI or
developer tools during task execution. Operators can also configure a cached derived worker image with
`worker.preinstall.commands` so frequently needed tools are rebuilt ahead of time instead of being reinstalled by
workers after they spawn.

Sub-agents may request access to additional resources from the user, such as:
- Certain host files to be copied in and out of the shared volume.
- Read-only mount access to a specific directory on the host machine.
- Read-write mount access to a specific directory on the host machine.
- MCP tools exposed through Sandy's host-side MCP proxy.
- Tools to send authenticated HTTPS requests through OneCLI,
  [similar to NanoClaw](https://docs.nanoclaw.dev/concepts/security#6-credential-handling).

Privilege evaluation requests are forwarded to the user verbatim, without the main agent getting to see them.
As such, these requests from the sub-agent must use a special message type on the container control channel that is then
*not* forwarded to the main agent, but instead directly to the user.

For MCP, Sandy exposes configured upstream servers to workers through an app-wide Docker sidecar on a dedicated Docker
network. The worker receives Codex MCP configuration pointing at that sidecar plus a Sandy-issued JWT bearer token
valid for one day. Upstream OAuth credentials stay in the host's Sandy config directory and are mounted into the
sidecar. By default, each MCP tool call is treated as a privilege request, and the user can approve it once, for the
current worker session, or permanently. Permanent approvals are written back to Sandy's TOML config file automatically.

Channel-native file transfer is separate from privilege evaluation. User uploads go straight into the shared workspace,
and sub-agent requests to send files back to the user through the channel do not require approval as long as the file
path stays under `/workspace/share`.

The user can then choose to approve or deny the request, and if they approve it using predefined phrases or emoji
reactions, the host runtime deterministically performs the requested operation without the LLM of the main
agent involved. It then notifies the sub-agent of the result so it can proceed with its execution.

Sandy's own host-mediated worker tools are not rewritten to MCP in v1. External MCP access and Sandy's native
copy/file-send flows coexist for now.

## Testing

Testing is crucial for ensuring the safety and reliability of Sandy. Every component must be testable, and
non-deterministic components such as the LLM and TTS providers should be mocked in tests to ensure consistent results.

## Future work

- Add support for more channels, such as Discord, Slack, etc.
- Add support for more LLM providers, such as Anthropic, etc.
- Add support for more TTS providers, such as Google Cloud Speech-to-Text, AWS
- Add support for scheduled tasks, allowing sub-agents to schedule tasks for later execution, 
  and notify the user when they are executed.
- Add support for memory.
- Add tools for audio and video transcription
- Add support for sandboxed headless browser use
