import { spawnSync } from "node:child_process";
import type { ChannelFormatting, PrivilegeResolutionResult } from "../types.js";
import { sharedWorkspaceMountPath } from "../shared-workspace.js";
import { buildWorkerProtocolInstructions } from "./worker-protocol.js";

export function buildInitialTaskInput(taskBrief: string, taskLanguage: string, channelFormatting: ChannelFormatting | null): string {
  return buildInitialTaskInputWithCapabilities(taskBrief, taskLanguage, channelFormatting, detectRuntimeCapabilities());
}

export function buildInitialTaskInputWithCapabilities(
  taskBrief: string,
  taskLanguage: string,
  channelFormatting: ChannelFormatting | null,
  runtimeCapabilities: string[],
): string {
  const lines = [
    "You are running inside a Sandy sub-agent container.",
    `Your shared workspace is mounted at ${sharedWorkspaceMountPath}.`,
    `Use ${sharedWorkspaceMountPath} for files that should remain available to the host after your task finishes.`,
    `User-attached files are copied into ${sharedWorkspaceMountPath} before you are told about them.`,
    "Inside this container you may use the filesystem, internet, and installed tools freely.",
    `If you need the host to copy files into or out of ${sharedWorkspaceMountPath}, do not ask the user directly.`,
    `Use ${taskLanguage} for user-visible replies unless the host provides a later instruction that overrides it.`,
    ...buildWorkerProtocolInstructions(),
  ];

  if (runtimeCapabilities.length > 0) {
    lines.push(...runtimeCapabilities);
  }

  if (channelFormatting) {
    lines.push(
      `User-visible output must follow this channel formatting contract: ${channelFormatting.instructions}`,
      `Allowed formatting tags: ${channelFormatting.allowedTags.map((tag) => `<${tag}>`).join(", ")}`,
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
