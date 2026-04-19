import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MATRIX_AUTH_STATE_VERSION = 1;

type MatrixAuthState = {
  version: number;
  homeserverUrl: string;
  botUserId: string;
  deviceId: string;
  accessToken: string;
};

function buildMatrixAuthStatePath(configDirectory: string): string {
  return join(configDirectory, "state", "matrix", "auth.json");
}

export async function loadMatrixAuthState(
  configDirectory: string,
): Promise<MatrixAuthState | null> {
  const statePath = buildMatrixAuthStatePath(configDirectory);
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidMatrixAuthState(parsed)) {
      return null;
    }
    return parsed;
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

export async function saveMatrixAuthState(
  configDirectory: string,
  state: Omit<MatrixAuthState, "version">,
): Promise<void> {
  const statePath = buildMatrixAuthStatePath(configDirectory);
  await mkdir(dirname(statePath), { recursive: true });
  const fullState: MatrixAuthState = {
    version: MATRIX_AUTH_STATE_VERSION,
    ...state,
  };
  await writeFile(statePath, JSON.stringify(fullState, null, 2), "utf8");
}

export async function deleteMatrixAuthState(configDirectory: string): Promise<void> {
  const statePath = buildMatrixAuthStatePath(configDirectory);
  await rm(statePath, { force: true });
}

export function validateMatrixAuthStateForConfig(
  state: MatrixAuthState | null,
  config: {
    homeserverUrl: string;
    botUserId: string;
  },
): { valid: boolean; reason?: string } {
  if (state === null) {
    return { valid: false, reason: "Matrix auth state file is missing." };
  }

  if (state.homeserverUrl !== config.homeserverUrl) {
    return {
      valid: false,
      reason: `Stored homeserver URL "${state.homeserverUrl}" does not match configured "${config.homeserverUrl}".`,
    };
  }

  if (state.botUserId !== config.botUserId) {
    return {
      valid: false,
      reason: `Stored bot user ID "${state.botUserId}" does not match configured "${config.botUserId}".`,
    };
  }

  return { valid: true };
}

function isValidMatrixAuthState(value: unknown): value is MatrixAuthState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    obj["version"] === MATRIX_AUTH_STATE_VERSION &&
    typeof obj["homeserverUrl"] === "string" &&
    typeof obj["botUserId"] === "string" &&
    typeof obj["deviceId"] === "string" &&
    typeof obj["accessToken"] === "string"
  );
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
