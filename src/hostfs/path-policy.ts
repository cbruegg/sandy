import {realpath, stat} from "node:fs/promises";
import {normalize} from "node:path";
import {resolveAbsoluteHostPath} from "../host-paths.js";

export type HostDirectoryAccessLevel = "read_only" | "read_write";

type CanonicalPathResult =
  | { ok: true; canonicalPath: string }
  | { ok: false; error: string };

export async function canonicalizeHostPath(inputPath: string): Promise<CanonicalPathResult> {
  let normalized: string;
  try {
    normalized = normalize(resolveAbsoluteHostPath(inputPath, "Path"));
  } catch {
    return {ok: false, error: `Path must be absolute, got: ${inputPath}`};
  }

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

async function realpathSafe(inputPath: string): Promise<string> {
  try {
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
