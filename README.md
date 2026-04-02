# Sandy

Sandy aims to be a safer alternative to the OpenClaw agent, executing actions in a sandboxed environment
with granular control over the agent's capabilities.

This README describes Sandy's intended target architecture and product direction. For the current v1 implementation
status, completed work, and known gaps relative to that target, see `PLAN_v1.md`.

## Usage

### Prerequisites

- Node.js 22 or newer.
- Docker installed and available as `docker`.
- A Telegram bot token.
- Either:
  - a local Codex ChatGPT login on the host machine, or
  - an OpenAI API key.

### Configuration

Required environment variables:

- `TELEGRAM_BOT_TOKEN`: Telegram bot token for the channel adapter.

Optional environment variables:

- `OPENAI_API_KEY`: API key passed to the host controller and sub-agent worker. If omitted, Sandy uses local Codex ChatGPT auth when available.
- `SANDY_CODEX_AUTH_FILE`: Override path to the host Codex `auth.json` file that should be mounted into sub-agent containers. Default: `~/.codex/auth.json` when present.
- `SANDY_LOG_LEVEL`: Minimum host log level. Supported values: `debug`, `info`, `warn`, `error`. Default: `info`.
- `SANDY_WORKER_IMAGE`: Docker image used for sub-agents. Default: `sandy-subagent:latest`.
- `SANDY_SHARE_ROOT`: Host directory under which per-sub-agent shared volumes are created. Default: `/tmp/sandy-shares`.

Example:

```bash
export TELEGRAM_BOT_TOKEN=...
export SANDY_LOG_LEVEL=info
export SANDY_WORKER_IMAGE=sandy-subagent:latest
export SANDY_SHARE_ROOT=/tmp/sandy-shares
```

Auth behavior:

- If the host already has Codex logged in with ChatGPT and `~/.codex/auth.json` exists, Sandy mounts that file into the sub-agent container automatically.
- If `OPENAI_API_KEY` is set and no Codex auth file is available, Sandy passes the API key to the main agent and sub-agent worker.
- If both are present, Sandy prefers the Codex ChatGPT auth file and does not pass `OPENAI_API_KEY`.

### Build and run

Install dependencies:

```bash
npm install
```

Build the worker image:

```bash
docker build -t sandy-subagent:latest .
```

Build the TypeScript sources:

```bash
npm run build
```

Start Sandy:

```bash
npm start
```

The host emits structured JSON logs to stdout/stderr for significant events such as startup, Telegram message handling,
main-agent decisions, task lifecycle transitions, privilege requests, and sandbox/container failures.

Run tests:

```bash
npm test
```

## Architecture

At its core, Sandy wraps an existing agent tool, which for now will be the OpenAI Codex agent using the Codex SDK.
Over time, it might make sense to use the [Pi agent](https://github.com/badlogic/pi-mono/tree/main/packages/agent),
providing a more flexible API that is not tied to a specific LLM provider.

Sandy receives messages from the user through a channel abstraction.
Initially, the only implementation of the channel will be a Telegram bot.

Allowed message types are text messages, file uploads (with images receiving dedicated handling) and voice messages.
Voice messages are transcribed to text using STT, and the resulting text is then processed as a normal text message.
Initially, the STT provider will be OpenAI's Whisper API, but it should be possible to add support for other providers
as well.

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
    - If the user's message after a response is not a report, the main agent adds the sub-agent's response to its own
      context and determines the next action to take as usual.
  - Sub-agents determine their own completion and notify Sandy when they are done, at which point Sandy sends a final
    message to the user with the results.
- Route the message to the appropriate sub-agent if it is related to an ongoing command execution.
- Cancel a sub-agent if the user requests it, and notify the user of the cancellation.
- Respond to the user with a message, without launching a sub-agent.

## Safety

Sub-agents do not receive the full message history from the main agent. The main agent only tells them what they need to
know to execute the command, and nothing more. This way, if a sub-agent is compromised, it does not have access to the
full context of the conversation.

Sub-agents are launched in isolated containers, initially using Docker.
Allowed interfaces are internet access, a per-sub-agent shared volume for file exchange and the container control
channel to the host runtime.

Inside the sub-agent container, Codex itself runs without an additional nested sandbox. Docker is the isolation
boundary for v1, which avoids bubblewrap/user-namespace failures inside the container.

Inside their sandbox, agents are free to install any dependencies or tools they need to execute the command.

Sub-agents may request access to additional resources from the user, such as:
- Certain files to be copied in and out of the shared volume.
- Read-only mount access to a specific directory on the host machine.
- Read-write mount access to a specific directory on the host machine.
- MCP servers that the main agent can connect to; note that the main agent tells the sub-agent which MCP servers it can
  connect to on launch of the sub-agent already.
- Tools to send authenticated HTTPS requests through OneCLI,
  [similar to NanoClaw](https://docs.nanoclaw.dev/concepts/security#6-credential-handling).

Privilege evaluation requests are forwarded to the user verbatim, without the main agent getting to see them.
As such, these requests from the sub-agent must use a special message type on the container control channel that is then
*not* forwarded to the main agent, but instead directly to the user.

The user can then choose to approve or deny the request, and if they approve it using predefined phrases or emoji
reactions, the main agent deterministically grants the requested access to the sub-agent, without the LLM of the main
agent involved. It then notifies it of the approval so it can proceed with its execution.

## Testing

Testing is crucial for ensuring the safety and reliability of Sandy. Every component must be testable, and
non-deterministic components such as the LLM and TTS providers should be mocked in tests to ensure consistent results.

## Future work

- Add support for more channels, such as Discord, Slack, etc.
- Add support for more LLM providers, such as Anthropic, etc.
- Add support for more TTS providers, such as Google Cloud Speech-to-Text, AWS
- Add support for scheduled tasks, allowing sub-agents to schedule tasks for later execution, 
  and notify the user when they are executed.
- Add support for skills.
- Add support for memory.
- Add tools for audio and video transcription
- Add support for sandboxed headless browser use
