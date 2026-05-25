import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverSkills, type SkillMetadata } from "./skills.js";

export type CreateSkillInput = {
  skillId: string;
  name: string;
  description: string;
  body: string;
};

export type UpdateSkillInput = CreateSkillInput;

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

export class SkillService {
  private readonly skillsDirectory: string;

  constructor(configDirectory: string) {
    this.skillsDirectory = join(configDirectory, "skills");
  }

  getSkillsDirectory(): string {
    return this.skillsDirectory;
  }

  getSkills(): SkillMetadata[] {
    return discoverSkills(this.skillsDirectory).skills;
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
    const content = renderSkillFile(input.name, input.description, input.body);
    await writeFile(join(skillDir, "SKILL.md"), content, "utf8");
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
