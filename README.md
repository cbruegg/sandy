# Sandy

Sandy aims to be a safer alternative to the OpenClaw agent, executing actions in a sandboxed environment
with granular control over the agent's capabilities.

This README describes Sandy's intended target architecture and product direction.

## Usage

### Prerequisites

- Bun 1.3 or newer.
- Docker installed and available as `docker`.
- `openssl` installed and available as `openssl` on the host. Sandy uses it at startup to generate the local CA for HTTPS interception when HTTP token proxying is enabled.
- Either:
  - a Telegram bot token plus the Telegram numeric user ID or username of the one person allowed to control Sandy, or
  - a Matrix homeserver URL and the full Matrix user ID of the bot account and the one person allowed to control Sandy (Sandy acquires the access token via its login CLI).
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

Sandy also attempts to enable host-side memory via [MemPalace](https://github.com/MemPalace/mempalace).
To make MemPalace available, install [uv](https://docs.astral.sh/uv/getting-started/installation/). When memory is enabled, Sandy runs MemPalace via `uv run --with mempalace python3 -m mempalace.mcp_server`, which automatically downloads MemPalace if needed.
If MemPalace is unavailable, memory will be disabled.

Example config:
Commented entries below show built-in defaults. Uncommented values are required or example overrides.

```toml
[logging]
# level = "info"

[channel]
kind = "telegram" # or "matrix" or "local_test"

[channel.telegram]
bot_token = "123456:telegram-token"
allowed_user = "123456789" # or "@cbruegg"

[channel.matrix]
homeserver_url = "https://matrix.org"
bot_user_id = "@sandy:matrix.org"
allowed_user_id = "@cbruegg:matrix.org"

[channel.local_test]
# Only mandatory if the local_test channel is configured:
# spool_root = "/tmp/sandy-local-test-XXXXXX/spool"

[auth]
# codex_auth_strategy = "copy_file" # or "external_tokens" (experimental)
# openai_api_key = "sk-..." # optional override, no default

[agent]
# model = "gpt-5.4-mini" # optional override, no default

[memory]
# enabled = true

[worker]
# image = "sandy-subagent:latest" # explicit override; otherwise Sandy uses a baked GHCR sha tag when present, or this local default
# share_root = "/tmp/sandy-shares"

[worker.network]
# mode = "public_internet_only" # one of: "public_internet_only", "unrestricted"
# allow_local_cidrs = [] # can contain values like "192.168.1.0/24"

[worker.preinstall]
# commands = [] # e.g. "zypper --non-interactive install jq" or "brew install gh"
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
transport = "streamable_http"
url = "https://todoist.example/mcp"
# oauth_scopes = []

[mcp.servers.spotify]
transport = "stdio"
command = "node"
args = ["/absolute/path/to/mcp-claude-spotify/build/index.js"]
# working_directory = "/absolute/path/to/mcp-claude-spotify"

[mcp.servers.spotify.env]
SPOTIFY_CLIENT_ID = "your_client_id_here"
SPOTIFY_CLIENT_SECRET = "your_client_secret_here"

[approvals.mcp.todoist]
# always_allow_tools = []
# always_allow_resources = []

# Optional HTTP token injection for proxied worker requests:

[http]
# proxy_image = "sandy-http-proxy:latest" # explicit override; otherwise Sandy uses a baked GHCR sha tag when present, or this local default

[http.tokens.vid2text]
# description = "Token for the Vid2Text API"
# value = "real-api-key-or-token"

[approvals.http.vid2text]
# always_allow_hosts = [] # e.g. "api.vid2text.example"

# Optional persisted host-directory approvals:
# [[approvals.host_directories]]
# path = "/Users/alice/project"
# level = "read_only" # or read_write
```

`agent.model` optionally overrides the Codex model used by both Sandy's main agent and worker sub-agents.
If unset, Sandy lets Codex use its current built-in default model. For cheaper/faster runs, consider setting a
small model such as `gpt-5.4-mini`.

Memory behavior:

- Sandy auto-configures a MemPalace MCP server for its main agent when `uv` is available on the host.
- The palace is stored under Sandy's config directory (e.g. `~/.config/sandy/mempalace/palace`).
- Memory is **enabled by default**. Set `memory.enabled = false` in the config file to disable it.
- MemPalace memories are managed directly by the main agent via MCP tool calls. The main agent can search past memories and file new stable facts and preferences.
- Sub-agents never see MemPalace or any memory tools; memory management stays main-agent-only.
- Sub-agents are prompted in their summary turn to identify stable facts and preferences worth remembering, which the main agent may choose to store.
- If `uv` is not installed, Sandy simply starts without memory capabilities and continues normally.

Telegram auth behavior:

- `channel.kind = "telegram"` requires `channel.telegram.allowed_user`. Set it to either a numeric Telegram user ID or a username like `@cbruegg`.
- Username values are matched case-insensitively after removing a leading `@`.
- Sandy ignores every Telegram update whose sender does not match `channel.telegram.allowed_user`.
- Sandy also ignores all non-private Telegram chats, even when the sender matches the configured user.

Matrix channel behavior:

- `channel.kind = "matrix"` requires `channel.matrix.homeserver_url`, `channel.matrix.bot_user_id`, and `channel.matrix.allowed_user_id`.
- Both `channel.matrix.bot_user_id` and `channel.matrix.allowed_user_id` must be full Matrix user IDs such as `@user:matrix.org`.
- Sandy auto-joins invites from the configured Matrix user and leaves rooms that are unencrypted, multi-user, or otherwise fail that qualification.
- Matrix task controls and approvals are exposed through Matrix polls only. Use a client with poll support such as Element or FluffyChat.
- Sandy uses a dedicated Matrix device session for encryption. The access token is managed separately from the config file.

To set up Matrix authentication:

1. Create a dedicated account for the bot on your Matrix homeserver.
2. Configure `channel.matrix.homeserver_url`, `channel.matrix.bot_user_id`, and `channel.matrix.allowed_user_id` in your config file.
3. Run the login command to authenticate and store the access token:

```bash
sandy matrix login
```

Or with a specific device name:

```bash
sandy matrix login "My Sandy Bot"
```

4. Check the login status with `sandy matrix status`.

The access token is stored in a state file (not the config file) and is bound to the configured homeserver URL and bot user ID. If you change either in the config, you must run `sandy matrix login` again.

`login` and `logout` clear the stored Matrix auth and crypto state under `state/matrix/`. Re-login creates a new device session and requires re-verification in the user's Matrix client.

`status` reports the configured homeserver, bot user ID, device ID, and whether the stored auth matches the config. It does not report encryption trust or device verification state. Use `sandy matrix verify status` for that.

To verify the bot device so that Matrix clients stop showing "encrypted by a device not verified by its owner" warnings:

1. Log into the bot account from a second Matrix client that supports cross-signing, such as Element Web or Element Desktop.
2. In that client, set up Secure Backup and enable cross-signing (typically under Settings → Security & Privacy).
3. Copy or save the recovery key shown during Secure Backup setup.
4. Run the verification command in Sandy, which will prompt for the recovery key securely:

```bash
sandy matrix verify recovery-key
```

5. Confirm the device is verified:

```bash
sandy matrix verify status
```

After this, the homeserver knows Sandy's device is signed by the bot account's self-signing key. Other clients that check device trust will no longer show the unverified-device warning for Sandy's messages.

If Sandy is later re-logged in (`sandy matrix logout` followed by `sandy matrix login`), the new device session needs to be verified again.

Local test channel behavior:

- `channel.kind = "local_test"` uses a file-backed inbox/outbox transport for autonomous local testing.
- `channel.local_test.spool_root` is the root directory that contains `inbox/`, `inbox-processed/`, `inbox-failed/`, and `outbox/`.
- The local-test channel supports exactly one implicit chat, so there is no chat-ID discovery step.
- The poll interval is fixed in code and is not configurable.
- The recommended way to interact with this channel is `./scripts/run-local-test-cli.sh ...`, not direct file editing.

Scheduled jobs:

- Sandy can persist one-shot and recurring scheduled jobs under `state/jobs/jobs.json` in the config directory.
- Jobs reference a Sandy skill by `skillId`; worker executions are still normal Sandy sub-agent tasks and use the same sandbox and approval flow, but may have to wait for active user-invoked tasks to complete.
- Recurring jobs have a persistent workspace directory for durable notes, caches, generated files, and job state.
- Workers manage jobs through Sandy worker tools: `list_jobs`, `get_job`, `create_job`, `update_job`, `delete_job`, `enable_job`, `disable_job`, and `run_job_now`.

Codex auth behavior:

- Sandy supports two Codex auth modes:
  - `auth.openai_api_key`: Sandy passes the configured API key to the main agent and sub-agent worker.
  - Host Codex ChatGPT login: Sandy infers the auth file from the host's default Codex location (`~/.codex/auth.json`).
- If `auth.openai_api_key` is configured, it takes precedence over the inferred Codex auth file.
- If Sandy uses the inferred Codex auth file, `auth.codex_auth_strategy` controls worker auth handling and defaults to `"copy_file"`.
- With `auth.codex_auth_strategy = "copy_file"`, Sandy copies the inferred auth file into each sub-agent container.
- `auth.codex_auth_strategy = "external_tokens"` is experimental. It is more secure because Sandy does not write the ChatGPT auth file into the container filesystem. Only the worker process receives the auth tokens it needs, which reduces the risk that other software in the container could read or exfiltrate the full auth file.
- OAuth for upstream MCP servers is handled on the host through the Sandy CLI, not inside channel chats.

MCP OAuth behavior:

- Every worker also gets a built-in MCP server named `sandy`. It exposes Sandy's host-mediated tools such as shared-workspace copy operations, file send-back, task completion, and HTTP token requests.
- `mcp.servers.sandy` is reserved for that built-in server and must not be configured by users.
- `mcp.servers.<name>.oauth_scopes` optionally sets OAuth scopes to request during `sandy mcp login <name>`.
- Sandy runs `streamable_http` MCP connections from an MCP sidecar container and starts `stdio` MCP processes eagerly on the host. The sidecar bridges stdio-backed servers back to the host over its control channel.
- If an MCP server runs on the same host as Sandy, use `http://host.docker.internal:<port>/...` when configuring `mcp.servers.<name>.url`.
- `mcp.servers.<name>.env` only applies to `stdio` servers and is merged on top of a minimal inherited base environment.

HTTP token behavior:

- `http.tokens.<name>` defines a named token secret with both `description` and `value`. Sandy includes token IDs and descriptions in the main-agent and sub-agent prompts so they know what each token is for. Workers use placeholder headers like `Authorization: Bearer SANDY_TOKEN_<name>` in proxied HTTP requests. The HTTP proxy replaces these placeholders with the real token value at request time, but only if the requesting task holds an active approval for that token + host.
- `approvals.http.<name>` persists `auto-allow for suitable tasks` decisions for specific hosts via `always_allow_hosts`. This is persistent approval state only; it does not make the token globally available to every future task. A persisted host approval auto-applies only when the main agent marks that token's configured auto-approvals as suitable for the task. New hosts can still go through the interactive approval flow and become persisted later if approved with `auto-allow for suitable tasks`.
- Workers _must_ explicitly request token use via the built-in `sandy.request_http_token` MCP tool before making proxied requests. This tool requires privilege escalation and follows the same approval flow as other sensitive host-mediated tools.
- If no approval is active when the proxy sees a placeholder token, the request is rejected immediately with HTTP 403.
- Workers do not receive global proxy environment variables anymore. Instead, Sandy tells sub-agents to run commands that need HTTP token injection through `/usr/local/bin/sandy-http-proxy-exec`, which sets `HTTP_PROXY`, `HTTPS_PROXY`, their lowercase variants, and `NO_PROXY` only for that child process while pointing at the per-worker Sandy HTTP proxy with embedded task credentials.
- The HTTP proxy runs in its own container per worker. It shares the worker's network-guard namespace so it sees the same effective connectivity restrictions, while remaining isolated from worker process control.
- The wrapper targets the proxy on `127.0.0.1:8081` inside the shared namespace.
- The MCP sidecar remains separate and runs behind its own network-guard container for network isolation.
- The host exchanges proxy authorization and header-rewrite decisions with the proxy container over the Docker stdio stream, so this bridge does not depend on Unix-domain sockets.
- HTTPS connections are handled via TLS interception (MITM). Sandy generates a root CA at startup, mounts it into a per-worker `mitmproxy` container, and workers trust Sandy's CA for HTTPS request inspection and header rewriting.
- The HTTP proxy container now runs on `mitmproxy`. Sandy keeps request approval and token placeholder resolution on the host side, while the proxy container handles the battle-tested HTTP/TLS interception layer.

Update behavior:

- `updates.mode` defaults to `"disabled"`.
- `updates.mode = "disabled"` turns off automatic executable updates.
- `updates.mode = "relaunch"` stages an update, exits once idle, and has the updater relaunch Sandy directly.
- `updates.mode = "exit"` replaces the on-disk Sandy executable first and then exits the running process so an external supervisor can restart it.
- If you use `updates.mode = "exit"` under systemd, configure the unit with `Restart=always`. In this mode Sandy does not relaunch itself after updating.
- If you explicitly pin `worker.image`, `mcp.sidecar_image`, or `http.proxy_image`, you must also set `[updates].mode = "disabled"`. Sandy refuses to start with pinned Docker images while automatic updates remain enabled in either `"relaunch"` or `"exit"` mode.

Worker preinstall behavior:

- `worker.preinstall.commands` is an ordered list of Docker build-time shell commands used to create a local derived worker image on top of `worker.image`.
- If `worker.preinstall.commands` is empty, Sandy launches workers from `worker.image` directly.
- If `worker.preinstall.commands` is configured, Sandy reconciles the derived worker image during startup before it begins serving chats.
- `worker.preinstall.refresh = "weekly"` keeps the derived image on a persisted 7-day cadence from the last successful rebuild, even across Sandy restarts.
- `worker.preinstall.refresh = "manual"` disables scheduled refreshes; Sandy still rebuilds when the configured commands change, the cached overlay is missing, or the base `worker.image` resolves to a different image ID.
- The derived worker image is local cache state. It does not count as an explicit `worker.image` override, so the existing `updates.mode` rules still apply only to the configured base image.

Worker network behavior:

- `worker.network.mode` defaults to `"public_internet_only"`.
- In `"public_internet_only"` mode, Sandy starts a per-task network-guard container and runs the worker in that guard's network namespace. This works on Docker Desktop as well as native Linux.
- In `"public_internet_only"` mode, workers keep normal public internet access but cannot reach local/private network ranges unless they are explicitly allowlisted in `worker.network.allow_local_cidrs`.
- `worker.network.allow_local_cidrs` accepts only literal IP addresses and CIDR blocks.
- Set `worker.network.mode = "unrestricted"` only if you intentionally want workers to be able to reach local/private network addresses directly.

[Skills](https://github.com/anthropics/skills) behavior:

- Sandy looks for skills only in a `skills/` directory next to the active `config.toml`.
- Sandy parses only the skill `name` and `description` from the leading frontmatter block in `SKILL.md`.
- The main agent receives only that metadata and is instructed to delegate requests that require one of those skills to a sub-agent.
- Skills can be updated while Sandy is running.

You can ask Sandy to create, edit, or delete skills in natural language — for example
*"create a skill for posting to my blog"*. Sandy will show you the proposed skill and
ask for approval before applying any change.

### Build and run

Install dependencies:

```bash
bun install
```

Build the worker image:

```bash
docker build --target worker-runtime -t sandy-subagent:latest .
```

Build the sidecar image (hosts Sandy's MCP proxy):

```bash
docker build --target mcp-proxy-runtime -t sandy-mcp-proxy:latest .
```

Build the HTTP proxy image:

```bash
docker build --target http-proxy-runtime -t sandy-http-proxy:latest .
```

Build the network-guard image:

```bash
docker build --target network-guard-runtime -t sandy-network-guard:latest .
```

The host runtime is intentionally not containerized, because it is designed to mediate host-system access directly.

Published Sandy executables built in GitHub Actions are baked with the matching `github.sha` and default to
`ghcr.io/<owner>/sandy-subagent:sha-<git revision>`, `ghcr.io/<owner>/sandy-mcp-proxy:sha-<git revision>`,
`ghcr.io/<owner>/sandy-http-proxy:sha-<git revision>`, and `ghcr.io/<owner>/sandy-network-guard:sha-<git revision>`.
Local `bun start` runs and locally built executables fall back to `sandy-subagent:latest`, `sandy-mcp-proxy:latest`,
and `sandy-http-proxy:latest` for the worker-side images unless the config file overrides them.

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

The host emits structured JSON logs to stdout/stderr for significant events such as startup, channel message handling,
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
This repository includes Telegram and Matrix adapters plus a file-backed `local_test` adapter for autonomous local testing.
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
  - Responses from the sub-agent are sent back to the host runtime, which then forwards them
    to the user as updates on the command execution.
    - To prevent prompt injection, by default the main agent is not allowed to see the responses from the sub-agent.
      Instead, the sub-agent sends them directly to the host runtime, which forwards them to the user.
    - When the user sees a dangerous response in the completion summary, they can report it. Depending on the channel,
      this can either be through channel-native controls such as Telegram buttons or Matrix polls.
      The host runtime then discards the pending summary and notifies the user.
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
- Read-only or read-write a ccess to a host directory through the built-in `sandy.request_host_directory_access` MCP tool,
  which mounts the approved path inside the worker at `/workspace/host/grants/...`.
- MCP tool calls and resource reads exposed through Sandy's host-side MCP proxy.
- Tools to send authenticated HTTP requests through Sandy's HTTP token proxy,
  [similar to NanoClaw](https://docs.nanoclaw.dev/concepts/security#6-credential-handling).

Privilege evaluation requests are forwarded to the user verbatim, without the main agent getting to see them.
As such, these requests from the sub-agent must use a special message type on the container control channel that is then
*not* forwarded to the main agent, but instead directly to the user.

For MCP, Sandy exposes configured upstream servers to workers through an app-wide Docker sidecar on a dedicated Docker
network. `streamable_http` servers stay proxied through the sidecar, while `stdio` servers are started eagerly on the
host and reached through the sidecar control channel. Upstream OAuth credentials stay in the host's Sandy config
directory and are mounted into the sidecar. The worker receives Codex MCP configuration for the configured servers,
plus a Sandy-issued JWT bearer token valid for one day.

MCP `callTool` and `readResource` operations are privilege-managed independently. The user can approve one operation
once, for the current worker session, or as `auto-allow for suitable tasks`; persisted approvals are written back to
Sandy's TOML config file automatically. A persisted MCP tool or resource approval does not auto-apply to every future
task. It auto-applies only when the main agent marks that MCP server's configured auto-approvals as suitable for the
task. Otherwise, the worker can still ask the user for explicit approval of individual MCP tool calls or resource reads.

Channel-native file transfer is separate from privilege evaluation. User uploads go straight into the shared workspace,
and sub-agent requests to send files back to the user through the channel do not require approval as long as the file
path stays under `/workspace/share`.

The user can then choose to approve or deny the request through channel-native controls, and the host runtime
deterministically performs the requested operation without the LLM of the main agent involved. It then notifies the
sub-agent of the result so it can proceed with its execution.

Sandy's own host-mediated worker tools are not rewritten to MCP in v1. External MCP access and Sandy's native
copy/file-send flows coexist for now.

Host directory access behavior:

- Every worker starts with a stable mount at `/workspace/host`.
- To access a host directory, workers call the built-in `sandy.request_host_directory_access` MCP tool with the absolute host path and desired access level (`read_only` or `read_write`).
- Sandy asks the user for approval. Host-directory requests offer `Allow in task`, `Always allow`, and `Deny`. There is no `Approve once` option.
- If approved, Sandy reveals the directory inside `/workspace/host/grants/<grant-id>/` and returns that worker-visible path to the worker.
- A `read_write` approval satisfies later `read_only` requests for the same canonical path, but not vice versa.
- Persisted approvals are stored in `approvals.host_directories` in the config file and survive restarts.
- The host directory mount uses the `rclone/docker-volume-rclone` Docker volume plugin, which Sandy installs and manages automatically.

## Testing

Testing is crucial for ensuring the safety and reliability of Sandy. Every component must be testable, and
non-deterministic components such as the LLM and TTS providers should be mocked in tests to ensure consistent results.
