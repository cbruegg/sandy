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
): { shell_environment_policy: { set: { PATH: string } } } | undefined {
  const shellPath = env["PATH"]?.trim();
  if (!shellPath) {
    return undefined;
  }

  return {
    shell_environment_policy: {
      set: {
        PATH: shellPath,
      },
    },
  };
}

export function buildWorkerCodexEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function asTomlTable(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

async function readWorkerCodexConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    const existingRaw = await readFile(configPath, "utf8");
    return toml.parse(existingRaw) as Record<string, unknown>;
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

  const mergedConfig = {
    ...existingConfig,
    shell_environment_policy: {
      ...shellEnvironmentPolicy,
      set: {
        ...shellEnvironmentSet,
        PATH: patch.shell_environment_policy.set.PATH,
      },
    },
  };

  await mkdir(codexHomePath, { recursive: true });
  await writeFile(configPath, toml.stringify(mergedConfig), "utf8");
}
