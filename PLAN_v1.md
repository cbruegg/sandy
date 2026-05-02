# Sandy V1 Status

## Scope
Sandy v1 remains a text-first, single-process orchestration runtime with at most one active sub-agent per chat. The main agent is a narrow controller that either replies directly or launches a Docker-hosted Codex sub-agent task.

README.md covers the intended product architecture, setup, configuration, and operator-visible behavior. AGENTS.md covers repository structure and development workflow. This document tracks the current v1 gaps plus a few implementation notes that are useful when changing the runtime.

## Remaining V1 Work
- Pass Telegram images to Codex as image input instead of rejecting them as unsupported input.
- Pass Matrix images to Codex as image input instead of flattening them into generic file attachments.

## Dropped From V1 Plan
- Dynamic host mounts are no longer planned work for v1. The worker protocol may still mention mount-shaped requests in code, but Sandy does not plan to implement host mounts in this plan.

## Technical Overview

### Main-agent context boundary
- Main-agent threads persist per chat, but each decision turn receives only newly visible transcript entries plus active-task metadata.
- Sub-agent output is quarantined from the main agent until the user continues the conversation without reporting the output as dangerous.
- Privilege requests are resolved deterministically by the host and are not delegated through the main agent.

### Shared workspace model
- Each task gets its own shared workspace.
- User-uploaded files are staged into that workspace before task launch and during active tasks.
- Sub-agents can send files from the shared workspace back through the active channel without additional privilege escalation.
- Empty task workspaces are deleted automatically; non-empty workspaces require explicit user confirmation before deletion.

### Current media behavior
- Voice input is supported through optional STT and then enters the normal text path.
- Telegram images are still rejected as unsupported image input.
- Matrix images currently arrive as generic file attachments rather than channel-native image input.

## Testing Follow-up
- After image-input support is added, cover Telegram and Matrix image normalization plus end-to-end task input construction so Codex receives those attachments as image input rather than plain files.
