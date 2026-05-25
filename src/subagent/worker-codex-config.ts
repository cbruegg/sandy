import * as toml from "@iarna/toml";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// The worker image composes PATH in Dockerfile. Patch that exact runtime PATH
// into Codex config here so Codex command execution sees the same toolchain
// while preserving any seeded MCP config copied into /root/.codex.
export const workerCodexHomePath = "/root/.codex";
const workerHomePath = dirname(workerCodexHomePath);
export const workerSkillsPath = join(workerHomePath, ".agents", "skills");

export function buildWorkerCodexConfigPatch(
  env: NodeJS.ProcessEnv = process.env,
): { model?: string; shell_environment_policy?: { set: { PATH: string } } } | undefined {
  const shellPath = env["PATH"]?.trim();
  const model = env["SANDY_CODEX_MODEL"]?.trim();
  if (!shellPath && !model) {
    return undefined;
  }

  return {
    ...(model ? { model } : {}),
    ...(shellPath
      ? {
          shell_environment_policy: {
            set: {
              PATH: shellPath,
            },
          },
        }
      : {}),
  };
}

function asTomlTable(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

async function readWorkerCodexConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    const existingRaw = await readFile(configPath, "utf8");
    return toml.parse(existingRaw);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function applyWorkerCodexConfigPatch(
  env: NodeJS.ProcessEnv = process.env,
  codexHomePath: string = workerCodexHomePath,
): Promise<void> {
  const patch = buildWorkerCodexConfigPatch(env);
  if (!patch) {
    return;
  }

  const configPath = join(codexHomePath, "config.toml");
  const existingConfig = await readWorkerCodexConfig(configPath);
  const shellEnvironmentPolicy = asTomlTable(existingConfig["shell_environment_policy"]);
  const shellEnvironmentSet = asTomlTable(shellEnvironmentPolicy["set"]);
  const mergedShellEnvironmentSet = {
    ...shellEnvironmentSet,
    ...(patch.shell_environment_policy
      ? { PATH: patch.shell_environment_policy.set.PATH }
      : {}),
  };
  const hasShellEnvironmentPolicy = Object.keys(mergedShellEnvironmentSet).length > 0
    || Object.keys(shellEnvironmentPolicy).some((key) => key !== "set");

  const mergedConfig = {
    ...existingConfig,
    ...(patch.model ? { model: patch.model } : {}),
    ...(hasShellEnvironmentPolicy
      ? {
          shell_environment_policy: {
            ...shellEnvironmentPolicy,
            set: mergedShellEnvironmentSet,
          },
        }
      : {}),
  };

  await mkdir(codexHomePath, { recursive: true });
  await writeFile(configPath, toml.stringify(mergedConfig), "utf8");
}
