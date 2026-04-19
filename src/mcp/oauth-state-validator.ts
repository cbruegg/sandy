import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig } from "../config.js";
import { mcpAdminMessages } from "../messages.js";
import { buildHostOauthStateDirectory } from "./oauth-paths.js";

type PersistedOAuthState = {
  tokens?: unknown;
};

export async function validateOAuthStateFilesForStartup(
  configDirectory: string,
  mcpServers: Record<string, McpServerConfig>,
): Promise<void> {
  const oauthStateDirectory = buildHostOauthStateDirectory(configDirectory);

  for (const [serverId] of Object.entries(mcpServers)) {
    const stateFilePath = join(oauthStateDirectory, `${serverId}.json`);
    let raw: string;
    try {
      raw = await readFile(stateFilePath, "utf8");
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      throw error;
    }

    const parsed = JSON.parse(raw) as PersistedOAuthState;
    if (parsed.tokens !== undefined) {
      continue;
    }

    throw new Error(mcpAdminMessages.oauthTokensMissingForStartup(serverId, stateFilePath));
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
