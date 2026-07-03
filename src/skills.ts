import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { archivedSkillsDirectory, skillsDirectory } from "./config-paths.js";
import { getBuiltInSkillDefinitions, isBuiltInSkillId, materializeBuiltInSkillsDirectory } from "./built-in-skills.js";
import { builtInSkillsRuntimeDirectory } from "./state-paths.js";

export type SkillMetadata = {
  name: string;
  description: string;
};

export type SkillDetails = SkillMetadata & {
  body: string;
};

type CreateSkillInput = {
  skillId: string;
  name: string;
  description: string;
  body: string;
};

type UpdateSkillInput = {
  skillId: string;
  name?: string;
  description?: string;
  body?: string;
};

type DeleteSkillInput = {
  skillId: string;
};

type ParsedSkillFile = {
  name: string;
  description: string;
  body: string;
};

function readSkillFile(skillFilePath: string): string {
  try {
    return readFileSync(skillFilePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown skill file read failure.";
    throw new Error(`Failed to read Sandy skill file at ${skillFilePath}: ${detail}`, { cause: error });
  }
}

function parseSkillMetadata(raw: string, skillFilePath: string): SkillMetadata {
  const { name, description } = parseSkillFrontmatter(raw, skillFilePath);

  return {
    name,
    description,
  };
}

function parseSkillFrontmatter(raw: string, skillFilePath: string): SkillMetadata {
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

  return { name, description };
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

function assertValidSkillId(skillId: string): void {
  if (!skillId) {
    throw new Error("skillId is required.");
  }
  if (/[\\/]/.test(skillId) || skillId === "." || skillId === "..") {
    throw new Error(`Invalid skillId "${skillId}".`);
  }
}

function assertNonEmptyString(value: string, field: string): void {
  if (!value || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
}

function renderSkillFile(name: string, description: string, body: string): string {
  assertNonEmptyString(name, "name");
  assertNonEmptyString(description, "description");
  if (name.includes("\n") || description.includes("\n")) {
    throw new Error("Skill name and description must not contain newlines.");
  }
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

async function parseExistingSkillFile(skillFilePath: string): Promise<ParsedSkillFile> {
  const raw = await readFile(skillFilePath, "utf8");
  const normalizedRaw = raw.replace(/^\uFEFF/, "");
  const match = normalizedRaw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    throw new Error(`Sandy skill file ${skillFilePath} must start with a frontmatter block delimited by "---".`);
  }

  const { name, description } = parseSkillFrontmatter(normalizedRaw, skillFilePath);
  const endOfFrontmatter = (match.index ?? 0) + match[0].length;
  const body = normalizedRaw.slice(endOfFrontmatter).trimStart();

  return { name, description, body };
}

export class SkillService {
  private readonly skillsDirectory: string;
  private readonly archivedSkillsDir: string;
  private readonly configDirectory: string;

  constructor(configDirectory: string) {
    this.configDirectory = configDirectory;
    this.skillsDirectory = skillsDirectory(configDirectory);
    this.archivedSkillsDir = archivedSkillsDirectory(configDirectory);
  }

  getSkillsDirectory(): string {
    return this.skillsDirectory;
  }

  getBuiltInSkillsDirectory(): string {
    return builtInSkillsRuntimeDirectory(this.configDirectory);
  }

  materializeBuiltInSkillsDirectory(): string {
    return materializeBuiltInSkillsDirectory(this.configDirectory);
  }

  getSkills(): SkillMetadata[] {
    const builtInMetadata = getBuiltInSkillDefinitions().map((skill) => ({
      name: skill.name,
      description: skill.description,
    }));

    if (!existsSync(this.skillsDirectory)) {
      return builtInMetadata;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(this.skillsDirectory, {
        withFileTypes: true,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown skills directory read failure.";
      throw new Error(`Failed to read Sandy skills directory at ${this.skillsDirectory}: ${detail}`, { cause: error });
    }

    const userMetadata = entries
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        if (isBuiltInSkillId(entry.name)) {
          return [];
        }

        const skillFilePath = join(this.skillsDirectory, entry.name, "SKILL.md");
        if (!existsSync(skillFilePath)) {
          return [];
        }

        return [parseSkillMetadata(readSkillFile(skillFilePath), skillFilePath)];
      });

    return [...builtInMetadata, ...userMetadata];
  }

  getSkill(skillId: string): SkillDetails | null {
    assertValidSkillId(skillId);

    const builtInSkill = getBuiltInSkillDefinitions().find((skill) => skill.skillId === skillId);
    if (builtInSkill) {
      return {
        name: builtInSkill.name,
        description: builtInSkill.description,
        body: builtInSkill.body,
      };
    }

    const skillFilePath = join(this.skillsDirectory, skillId, "SKILL.md");
    if (!existsSync(skillFilePath)) {
      return null;
    }

    const raw = readSkillFile(skillFilePath);
    const { name, description } = parseSkillFrontmatter(raw, skillFilePath);
    const normalizedRaw = raw.replace(/^\uFEFF/, "");
    const match = normalizedRaw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    return {
      name,
      description,
      body: match ? normalizedRaw.slice((match.index ?? 0) + match[0].length).trimStart() : "",
    };
  }

  async createSkill(input: CreateSkillInput): Promise<void> {
    assertValidSkillId(input.skillId);
    this.assertMutableSkillId(input.skillId);
    const skillDir = join(this.skillsDirectory, input.skillId);
    if (existsSync(skillDir)) {
      throw new Error(`Skill "${input.skillId}" already exists.`);
    }
    const content = renderSkillFile(input.name, input.description, input.body);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), content, "utf8");
  }

  async updateSkill(input: UpdateSkillInput): Promise<void> {
    assertValidSkillId(input.skillId);
    this.assertMutableSkillId(input.skillId);
    const skillDir = join(this.skillsDirectory, input.skillId);
    if (!existsSync(skillDir)) {
      throw new Error(`Skill "${input.skillId}" does not exist.`);
    }
    const skillFilePath = join(skillDir, "SKILL.md");
    const existing = await parseExistingSkillFile(skillFilePath);
    const content = renderSkillFile(
      input.name ?? existing.name,
      input.description ?? existing.description,
      input.body ?? existing.body,
    );
    await writeFile(skillFilePath, content, "utf8");
  }

  async deleteSkill(input: DeleteSkillInput): Promise<void> {
    assertValidSkillId(input.skillId);
    this.assertMutableSkillId(input.skillId);
    const skillDir = join(this.skillsDirectory, input.skillId);
    if (!existsSync(skillDir)) {
      throw new Error(`Skill "${input.skillId}" does not exist.`);
    }
    await rm(skillDir, { recursive: true, force: true });
  }

  async archiveSkill(skillId: string): Promise<void> {
    assertValidSkillId(skillId);
    this.assertMutableSkillId(skillId);

    const sourceDirectory = join(this.skillsDirectory, skillId);
    await mkdir(this.archivedSkillsDir, { recursive: true });
    try {
      await rename(sourceDirectory, join(this.archivedSkillsDir, `${skillId}-${randomUUID()}`));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  private assertMutableSkillId(skillId: string): void {
    if (isBuiltInSkillId(skillId)) {
      throw new Error(`Skill "${skillId}" is built in and cannot be modified.`);
    }
  }
}
