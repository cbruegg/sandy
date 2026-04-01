# Sandy

Sandy aims to be a safer alternative to the OpenClaw agent, executing actions in a sandboxed environment
with granular control over the agent's capabilities.

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
      Instead, the sub-agent sends them directly to the user through a WebSocket connection to the main agent, which then
      forwards them to the user.
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
Allowed interfaces are internet access, a shared volume for file exchange and a WebSocket connection to the main agent.

Inside their sandbox, agents are free to install any dependencies or tools they need to execute the command.

Sub-agents may request access to additional resources from the user, such as:
- Certain files to be copied into the shared volume.
- Read-only mount access to a specific directory on the host machine.
- Read-write mount access to a specific directory on the host machine.
- MCP servers that the main agent can connect to; note that the main agent tells the sub-agent which MCP servers it can
  connect to on launch of the sub-agent already.
- Tools to send authenticated HTTPS requests through OneCLI,
  [similar to NanoClaw](https://docs.nanoclaw.dev/concepts/security#6-credential-handling).

Privilege evaluation requests are forwarded to the user verbatim, without the main agent getting to see them.
As such, these requests from the sub-agent must use a special message type on the WebSocket that is then *not*
forwarded to the main agent, but instead directly to the user.

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