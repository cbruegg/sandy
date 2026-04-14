import { join } from "node:path";
import { resolveHomeDirectory } from "./home-directory.js";

export function resolveSandyCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const localAppData = env["LOCALAPPDATA"]?.trim();
  if (platform === "win32" && localAppData) {
    return join(localAppData, "Sandy");
  }

  const homeDirectory = env["HOME"]?.trim() || resolveHomeDirectory();
  return join(homeDirectory, ".local", "share", "sandy");
}

export function resolveCodexCacheRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(resolveSandyCacheRoot(env, platform), "codex");
}

export function resolveWorkerImageCacheStatePath(cacheRoot = resolveSandyCacheRoot()): string {
  return join(cacheRoot, "worker-image", "state.json");
}
