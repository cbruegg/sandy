import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills } from "./skills.js";

test("discoverSkills returns no skills when the config directory has no skills folder", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "sandy-skills-"));

  try {
    assert.deepEqual(discoverSkills(configDirectory), {
      skillsDirectory: null,
      skills: [],
    });
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("discoverSkills parses skill metadata from SKILL frontmatter", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "sandy-skills-"));
  const skillDirectory = join(configDirectory, "skills", "todoist");

  try {
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), `---
name: Adding task to Todoist
description: When the user asks you to add a task to their Todoist, use this skill.
---

Use the Todoist MCP.
`);

    assert.deepEqual(discoverSkills(configDirectory), {
      skillsDirectory: join(configDirectory, "skills"),
      skills: [{
        name: "Adding task to Todoist",
        description: "When the user asks you to add a task to their Todoist, use this skill.",
      }],
    });
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("discoverSkills ignores child directories without SKILL.md", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "sandy-skills-"));
  const alphaSkillDirectory = join(configDirectory, "skills", "alpha");
  const ignoredDirectory = join(configDirectory, "skills", "ignored");

  try {
    await mkdir(alphaSkillDirectory, { recursive: true });
    await mkdir(ignoredDirectory, { recursive: true });
    await writeFile(join(alphaSkillDirectory, "SKILL.md"), `---
name: Alpha skill
description: This skill should be discovered.
---
`);

    assert.deepEqual(discoverSkills(configDirectory).skills, [
      {
        name: "Alpha skill",
        description: "This skill should be discovered.",
      },
    ]);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("discoverSkills rejects malformed skill frontmatter", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "sandy-skills-"));
  const skillDirectory = join(configDirectory, "skills", "broken");

  try {
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), "name: Broken skill\n");

    assert.throws(
      () => discoverSkills(configDirectory),
      /must start with a frontmatter block/,
    );
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("discoverSkills rejects skills with missing required metadata", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "sandy-skills-"));
  const skillDirectory = join(configDirectory, "skills", "broken");

  try {
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), `---
name: Broken skill
---
`);

    assert.throws(
      () => discoverSkills(configDirectory),
      /missing required frontmatter field "description"/,
    );
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("discoverSkills rejects skills with a missing name", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "sandy-skills-"));
  const skillDirectory = join(configDirectory, "skills", "broken");

  try {
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), `---
description: Broken skill
---
`);

    assert.throws(
      () => discoverSkills(configDirectory),
      /missing required frontmatter field "name"/,
    );
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});
