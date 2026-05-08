import {isAbsolute, normalize, resolve} from "node:path";
import {stat} from "node:fs/promises";
import {resolveHomeDirectory} from "../home-directory.js";

export type HostDirectoryAccessLevel = "read_only" | "read_write";

type CanonicalPathResult =
  | { ok: true; canonicalPath: string }
  | { ok: false; error: string };

export async function canonicalizeHostPath(inputPath: string): Promise<CanonicalPathResult> {
  const expanded = expandHomePath(inputPath);
  if (!isAbsolute(expanded)) {
    return {ok: false, error: `Path must be absolute, got: ${inputPath}`};
  }

  const normalized = normalize(expanded);

  try {
    const stats = await stat(normalized);
    if (!stats.isDirectory()) {
      return {ok: false, error: `Path is not a directory: ${normalized}`};
    }
    // Use realpath to resolve symlinks in the path itself
    const canonical = await realpathSafe(normalized);
    return {ok: true, canonicalPath: canonical};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {ok: false, error: `Cannot access path: ${message}`};
  }
}

function expandHomePath(inputPath: string): string {
  if (inputPath === "~") {
    return resolveHomeDirectory();
  }
  if (inputPath.startsWith("~/")) {
    return resolve(resolveHomeDirectory(), inputPath.slice(2));
  }
  return inputPath;
}

async function realpathSafe(inputPath: string): Promise<string> {
  try {
    const {realpath} = await import("node:fs/promises");
    return await realpath(inputPath);
  } catch {
    // If realpath fails, fall back to the normalized path
    return normalize(inputPath);
  }
}

export function isAccessLevelSatisfiedOrBetter(required: HostDirectoryAccessLevel, granted: HostDirectoryAccessLevel): boolean {
  if (required === "read_only") {
    return granted === "read_only" || granted === "read_write";
  }
  return granted === "read_write";
}
