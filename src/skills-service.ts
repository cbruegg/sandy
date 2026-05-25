import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverSkills, type SkillMetadata } from "./skills.js";

export type CreateSkillInput = {
  skillId: string;
  name: string;
  description: string;
  body: string;
};

export type UpdateSkillInput = {
  skillId: string;
  name?: string;
  description?: string;
  body?: string;
};

export type DeleteSkillInput = {
  skillId: string;
};

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

type ParsedSkillFile = {
  name: string;
  description: string;
  body: string;
};

async function parseExistingSkillFile(skillFilePath: string): Promise<ParsedSkillFile> {
  const raw = await readFile(skillFilePath, "utf8");
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
    const value = line.slice(separatorIndex + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
        fields.set(key, value.slice(1, -1).trim());
        continue;
      }
    }
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

  const endOfFrontmatter = match.index! + match[0].length;
  const body = normalizedRaw.slice(endOfFrontmatter).trimStart();

  return { name, description, body };
}

export class SkillService {
  private readonly configDirectory: string;
  private readonly skillsDirectory: string;

  constructor(configDirectory: string) {
    this.configDirectory = configDirectory;
    this.skillsDirectory = join(configDirectory, "skills");
  }

  getSkillsDirectory(): string {
    return this.skillsDirectory;
  }

  getSkills(): SkillMetadata[] {
    return discoverSkills(this.configDirectory).skills;
  }

  async createSkill(input: CreateSkillInput): Promise<void> {
    assertValidSkillId(input.skillId);
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
    const skillDir = join(this.skillsDirectory, input.skillId);
    if (!existsSync(skillDir)) {
      throw new Error(`Skill "${input.skillId}" does not exist.`);
    }
    await rm(skillDir, { recursive: true, force: true });
  }
}
