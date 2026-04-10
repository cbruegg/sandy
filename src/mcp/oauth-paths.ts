import { join } from "node:path";

const sandyOauthDirectoryName = "oauth";
export const sidecarOauthMountPath = "/sandy/oauth";

export function buildHostOauthStateDirectory(configDirectory: string): string {
  return join(configDirectory, sandyOauthDirectoryName);
}
