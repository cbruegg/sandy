import { homedir } from "node:os";

export function resolveHomeDirectory(): string {
  const configuredHome = process.env.HOME?.trim();
  if (configuredHome) {
    return configuredHome;
  }
  return homedir();
}
