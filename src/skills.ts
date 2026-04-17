import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";

export type SkillMetadata = {
  name: string;
  description: string;
};

type DiscoveredSkills = {
  skillsDirectory: string | null;
  skills: SkillMetadata[];
};

export function discoverSkills(configDirectory: string): DiscoveredSkills {
  const skillsDirectory = join(configDirectory, "skills");
  if (!existsSync(skillsDirectory)) {
    return {
      skillsDirectory: null,
      skills: [],
    };
  }

  let entries: Dirent[];
  try {
    entries = readdirSync(skillsDirectory, {
      withFileTypes: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown skills directory read failure.";
    throw new Error(`Failed to read Sandy skills directory at ${skillsDirectory}: ${detail}`, { cause: error });
  }

  const skills = entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const skillFilePath = join(skillsDirectory, entry.name, "SKILL.md");
      if (!existsSync(skillFilePath)) {
        return [];
      }

      return [parseSkillMetadata(readSkillFile(skillFilePath), skillFilePath)];
    });

  return {
    skillsDirectory,
    skills,
  };
}

function readSkillFile(skillFilePath: string): string {
  try {
    return readFileSync(skillFilePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown skill file read failure.";
    throw new Error(`Failed to read Sandy skill file at ${skillFilePath}: ${detail}`, { cause: error });
  }
}

function parseSkillMetadata(raw: string, skillFilePath: string): SkillMetadata {
  const normalizedRaw = raw.replace(/^\uFEFF/, "");
  const match = normalizedRaw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error(`Sandy skill file ${skillFilePath} must start with a frontmatter block delimited by "---".`);
  }

  const frontmatter = match[1] ?? "";
  const fields = new Map<string, string>();
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      throw new Error(`Sandy skill file ${skillFilePath} contains invalid frontmatter line: ${rawLine}`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = normalizeFrontmatterScalar(line.slice(separatorIndex + 1).trim());
    fields.set(key, value);
  }

  const name = fields.get("name")?.trim() ?? "";
  const description = fields.get("description")?.trim() ?? "";
  if (!name) {
    throw new Error(`Sandy skill file ${skillFilePath} is missing required frontmatter field "name".`);
  }
  if (!description) {
    throw new Error(`Sandy skill file ${skillFilePath} is missing required frontmatter field "description".`);
  }

  return {
    name,
    description,
  };
}

function normalizeFrontmatterScalar(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}
