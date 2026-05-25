import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillService } from "./skills-service.js";

async function createTempConfigDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sandy-skills-service-"));
}

async function createSkillOnDisk(
  configDirectory: string,
  skillId: string,
  content: string,
): Promise<void> {
  const skillDir = join(configDirectory, "skills", skillId);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), content, "utf8");
}

test("getSkillsDirectory returns the skills subdirectory of the config directory", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    const service = new SkillService(configDirectory);
    assert.equal(service.getSkillsDirectory(), join(configDirectory, "skills"));
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("getSkills discovers skills from the config directory", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    await createSkillOnDisk(configDirectory, "todoist", `---
name: Adding task to Todoist
description: When the user asks you to add a task to their Todoist, use this skill.
---

Use the Todoist MCP.
`);

    const service = new SkillService(configDirectory);
    assert.deepEqual(service.getSkills(), [
      {
        name: "Adding task to Todoist",
        description: "When the user asks you to add a task to their Todoist, use this skill.",
      },
    ]);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("getSkills returns an empty array when no skills exist", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    const service = new SkillService(configDirectory);
    assert.deepEqual(service.getSkills(), []);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("createSkill writes a valid SKILL.md file", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    const service = new SkillService(configDirectory);
    await service.createSkill({
      skillId: "todoist",
      name: "Adding task to Todoist",
      description: "When the user asks you to add a task to their Todoist, use this skill.",
      body: "Use the Todoist MCP.",
    });

    const skillFilePath = join(configDirectory, "skills", "todoist", "SKILL.md");
    assert.equal(existsSync(skillFilePath), true);

    const content = await readFile(skillFilePath, "utf8");
    assert.match(content, /name: Adding task to Todoist/);
    assert.match(content, /description: When the user asks you to add a task to their Todoist, use this skill\./);
    assert.match(content, /Use the Todoist MCP\./);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("createSkill rejects duplicate skillIds", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    const service = new SkillService(configDirectory);
    await service.createSkill({
      skillId: "todoist",
      name: "Adding task to Todoist",
      description: "Use this skill for Todoist.",
      body: "Body",
    });

    await assert.rejects(
      service.createSkill({
        skillId: "todoist",
        name: "Another name",
        description: "Another description.",
        body: "Another body.",
      }),
      /already exists/,
    );
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("createSkill rejects invalid skillIds", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    const service = new SkillService(configDirectory);

    await assert.rejects(
      service.createSkill({ skillId: "", name: "Name", description: "Description.", body: "Body" }),
      /skillId is required/,
    );
    await assert.rejects(
      service.createSkill({ skillId: "../escape", name: "Name", description: "Description.", body: "Body" }),
      /Invalid skillId/,
    );
    await assert.rejects(
      service.createSkill({ skillId: ".", name: "Name", description: "Description.", body: "Body" }),
      /Invalid skillId/,
    );
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("createSkill rejects empty name or description", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    const service = new SkillService(configDirectory);

    await assert.rejects(
      service.createSkill({ skillId: "x", name: "", description: "Description.", body: "Body" }),
      /name is required/,
    );
    await assert.rejects(
      service.createSkill({ skillId: "x", name: "Name", description: "", body: "Body" }),
      /description is required/,
    );
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("createSkill rejects name or description containing newlines", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    const service = new SkillService(configDirectory);

    await assert.rejects(
      service.createSkill({ skillId: "x", name: "Multi\nline", description: "Description.", body: "Body" }),
      /must not contain newlines/,
    );
    await assert.rejects(
      service.createSkill({ skillId: "x", name: "Name", description: "Multi\nline", body: "Body" }),
      /must not contain newlines/,
    );
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("updateSkill replaces all fields when provided", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    const service = new SkillService(configDirectory);
    await service.createSkill({
      skillId: "todoist",
      name: "Old name",
      description: "Old description.",
      body: "Old body.",
    });

    await service.updateSkill({
      skillId: "todoist",
      name: "New name",
      description: "New description.",
      body: "New body.",
    });

    const content = await readFile(join(configDirectory, "skills", "todoist", "SKILL.md"), "utf8");
    assert.match(content, /name: New name/);
    assert.match(content, /description: New description\./);
    assert.match(content, /New body\./);
    assert.doesNotMatch(content, /Old name/);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("updateSkill preserves unspecified fields", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    const service = new SkillService(configDirectory);
    await service.createSkill({
      skillId: "todoist",
      name: "Original name",
      description: "Original description.",
      body: "Original body.",
    });

    await service.updateSkill({
      skillId: "todoist",
      description: "Updated description.",
    });

    const content = await readFile(join(configDirectory, "skills", "todoist", "SKILL.md"), "utf8");
    assert.match(content, /name: Original name/);
    assert.match(content, /description: Updated description\./);
    assert.match(content, /Original body\./);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("updateSkill rejects missing skills", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    const service = new SkillService(configDirectory);

    await assert.rejects(
      service.updateSkill({ skillId: "missing", name: "Name", description: "Description.", body: "Body" }),
      /does not exist/,
    );
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("updateSkill rejects invalid skillIds", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    const service = new SkillService(configDirectory);

    await assert.rejects(
      service.updateSkill({ skillId: "", name: "Name", description: "Description.", body: "Body" }),
      /skillId is required/,
    );
    await assert.rejects(
      service.updateSkill({ skillId: "a/b", name: "Name", description: "Description.", body: "Body" }),
      /Invalid skillId/,
    );
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("deleteSkill removes the skill directory", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    const service = new SkillService(configDirectory);
    await service.createSkill({
      skillId: "todoist",
      name: "Adding task to Todoist",
      description: "Use this skill for Todoist.",
      body: "Body",
    });

    await service.deleteSkill({ skillId: "todoist" });

    assert.equal(existsSync(join(configDirectory, "skills", "todoist")), false);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("deleteSkill rejects missing skills", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    const service = new SkillService(configDirectory);

    await assert.rejects(
      service.deleteSkill({ skillId: "missing" }),
      /does not exist/,
    );
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("deleteSkill rejects invalid skillIds", async () => {
  const configDirectory = await createTempConfigDirectory();
  try {
    const service = new SkillService(configDirectory);

    await assert.rejects(
      service.deleteSkill({ skillId: "" }),
      /skillId is required/,
    );
    await assert.rejects(
      service.deleteSkill({ skillId: ".." }),
      /Invalid skillId/,
    );
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});
