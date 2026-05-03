import { homedir } from "node:os";

export function resolveHomeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configuredHome = env["HOME"]?.trim();
  if (configuredHome) {
    return configuredHome;
  }
  return homedir();
}
