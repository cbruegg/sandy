import { join } from "node:path";

export function archivedSkillsDirectory(configDirectory: string): string {
  return join(configDirectory, "archive", "skills");
}

export function skillsDirectory(configDirectory: string): string {
  return join(configDirectory, "skills");
}
