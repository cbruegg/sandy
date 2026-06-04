import { spawnSync } from "node:child_process";
import type { Input, UserInput } from "@openai/codex-sdk";
import type { ChannelFormatting, PrivilegeResolutionResult } from "../types.js";
import { hostMountPath } from "../paths.js";
import { sharedWorkspaceMountPath } from "../shared-workspace.js";
import { formatDateTimePrefix } from "../datetime-prefix.js";
import { sandyMcpServerId } from "./worker-tools.js";

type HttpTokenPromptInput = {
  tokenId: string;
  description: string;
};

export type ImageAttachment = {
  sharePath: string;
  fileName: string;
};

export function buildInitialTaskInput(
  taskBrief: string,
  taskLanguage: string,
  channelFormatting: ChannelFormatting | null,
  httpTokens: HttpTokenPromptInput[] = [],
  httpProxyWrapper: string | null = null,
  images: ImageAttachment[] = [],
): Input {
  const textInput = buildInitialTaskInputWithCapabilities(
    taskBrief,
    taskLanguage,
    channelFormatting,
    detectRuntimeCapabilities(),
    httpTokens,
    httpProxyWrapper,
  );

  const inputs: UserInput[] = [];

  if (textInput.trim()) {
    inputs.push({ type: "text", text: textInput.trim() });
  }

  for (const image of images) {
    inputs.push({ type: "local_image", path: image.sharePath });
  }

  return inputs;
}

export function buildInitialTaskInputWithCapabilities(
  taskBrief: string,
  taskLanguage: string,
  channelFormatting: ChannelFormatting | null,
  runtimeCapabilities: string[],
  httpTokens: HttpTokenPromptInput[] = [],
  httpProxyWrapper: string | null = null,
): string {
  const lines = [
    formatDateTimePrefix(),
    "You are running inside a Sandy sub-agent container.",
    `Your shared workspace is mounted at ${sharedWorkspaceMountPath}.`,
    `Use ${sharedWorkspaceMountPath} for files that should remain available to the host after your task finishes.`,
    `User-attached files are copied into ${sharedWorkspaceMountPath} before you are told about them.`,
    "Inside this container you may use the filesystem, internet, and installed tools freely.",
    `If you need the host to copy files into or out of ${sharedWorkspaceMountPath}, do not ask the user directly.`,
    `Use ${taskLanguage} for user-visible replies unless the host provides a later instruction that overrides it.`,
    "Keep user-visible progress updates minimal and concise. Only report meaningful milestones, not every shell command completion.",
    "If you need to show text to the user and also call a Sandy MCP tool, send the user-visible text first and then call the tool separately.",
    `The MCP server "${sandyMcpServerId}" exposes additional host-integration tools. Use MCP tool discovery to list its tools ahead of working on a task.`,
    `A host filesystem mount is available at ${hostMountPath}. To access host directories, do not ask the user in plain text.`,
    `Call ${sandyMcpServerId}.request_host_directory_access with the absolute host path and desired access level.`,
    "The tool response will provide the exact worker-visible path you should use. Only use the returned grant path.",
    "Whenever you use tool_search to discover MCP tools, set limit to 30 or higher. If that returned 30 tools, increase the limit until you obtained the full list."
  ];

  if (runtimeCapabilities.length > 0) {
    lines.push(...runtimeCapabilities);
  }

  if (httpTokens.length > 0) {
    lines.push(
      "Configured HTTP tokens available to this task:",
      ...httpTokens.map((token) => `- ${token.tokenId}: ${token.description}`),
      `If you need one of these tokens, do not ask the user in plain text. Call ${sandyMcpServerId}.request_http_token first.`,
      "After approval, use the approved token only for the approved host and only in proxied requests that include the placeholder header.",
    );
    if (httpProxyWrapper) {
      lines.push(
        `When a command should use HTTP token injection, always run it through ${httpProxyWrapper} so HTTP_PROXY/HTTPS_PROXY are set only for that process.`,
        `If a request includes SANDY_TOKEN_<tokenId> in a header, assume you must use ${httpProxyWrapper} unless the host explicitly tells you otherwise.`,
        `You should not make a direct curl or other direct HTTP request with a placeholder token header outside ${httpProxyWrapper}, because the placeholder will not be injected.`,
        `The wrapper is not limited to curl. You can use ${httpProxyWrapper} with any executable that respects proxy environment variables.`,
        "The wrapper also sets the lowercase proxy env vars and NO_PROXY/no_proxy for the MCP proxy host.",
        `Example pattern: ${httpProxyWrapper} curl -H 'Authorization: Bearer SANDY_TOKEN_<tokenId>' https://example.test/...`,
      );
    }
  }

  if (channelFormatting) {
    lines.push(
      `User-visible output must follow this channel formatting contract: ${channelFormatting.instructions}`,
    );
  }

  lines.push("", taskBrief);
  return lines.join("\n");
}

export function buildPrivilegeResolutionInput(result: PrivilegeResolutionResult): string {
  return [
    `Host privilege request ${result.requestId} finished with outcome "${result.outcome}".`,
    result.message,
    "Continue the task from here.",
  ].join("\n");
}

export function buildTaskSummaryInput(): string {
  return [
    "Your task work is complete.",
    "Write a short host-facing handoff summary of this task.",
    "Do not address the user directly.",
    "Do not emit any Sandy tool calls.",
    "Use this exact structure:",
    "Summary: <what you accomplished and the current state>",
    "Artifacts: <files created or updated in /workspace/share, or \"none\">",
    "Open questions: <remaining blockers, follow-ups, or \"none\">",
    "Potential memories: <stable facts, user preferences, or longer-lived context worth remembering, or \"none\">",
  ].join("\n");
}

function detectRuntimeCapabilities(): string[] {
  const capabilities: string[] = [];
  const bunVersion = spawnSync("bun", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (bunVersion.status === 0) {
    capabilities.push(
      "Detected JavaScript runtime and package manager: Bun.",
      "Use bun run, bun test, bun install, and bunx for JavaScript or TypeScript tasks in this container.",
    );
  }

  const zypperVersion = spawnSync("zypper", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (zypperVersion.status === 0) {
    capabilities.push(
      "Detected package manager: zypper.",
      "You can install or update openSUSE Tumbleweed packages in this container with zypper when needed.",
    );
  }

  const brewVersion = spawnSync("brew", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (brewVersion.status === 0) {
    capabilities.push(
      "Detected package manager: Homebrew.",
      "Use brew for fast-moving CLI and developer tools; the container's brew command runs under the dedicated linuxbrew user automatically.",
    );
  }

  return capabilities;
}
