import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { builtInSkillsRuntimeDirectory } from "./state-paths.js";

export type BuiltInSkillDefinition = {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
};

function renderBuiltInSkillFile(skill: BuiltInSkillDefinition): string {
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\n${skill.body}`;
}

const builtInSkills = [
  {
    skillId: "notify-me-when",
    name: "Notify me when X",
    description: "Use this when the user wants Sandy to monitor a condition and notify them when it becomes true.",
    body: [
      "Use this skill when the user asks Sandy to notify them when some condition becomes true, such as a price threshold, a website update, an API state change, or another recurring check.",
      "",
      "Your job is to turn the user's request into a dedicated monitoring skill plus a recurring Sandy job that runs that monitoring skill.",
      "",
      "Rules:",
      "1. If the user did not provide a recurring schedule, do not invent one and do not use a default. Ask the user to provide a schedule before creating anything. If the user provides a vague schedule like 'daily', you may select suitable details.",
      "2. Once you have a schedule, create a new Sandy skill dedicated to the condition being monitored.",
      "3. Then create a recurring Sandy job that uses that dedicated skill.",
      "4. Set definition.jobOwnsSkill to true when creating the job, because the dedicated skill exists only for that job.",
      "5. The job must be recurring, not one-shot.",
      "",
      "When creating the dedicated monitoring skill, instruct it to do the following on every run:",
      "- Evaluate the requested condition immediately.",
      "- If the condition is not met, clear the persistent job workspace directory before terminating.",
      "- If the condition is not met, terminate immediately after clearing the workspace directory without requesting user interaction.",
      "- If the condition is met, request user interaction and notify the user.",
      "- When the condition is met, delete the current job before terminating.",
      "- In case it wrote files into the persistent job workspace directory, clear it before termination. Then terminate.",
      "",
      "Important implementation details for the generated monitoring skill:",
      "- The scheduled job brief will tell the worker the persistent workspace directory path on the host when one exists.",
      "- For recurring jobs, if the skill needs to clear that host workspace directory, it should call sandy.request_host_directory_access for the workspace path from the job brief. Sandy pre-approves that workspace path for the job.",
      "- After access is granted, delete the contents of the workspace directory but keep the directory itself.",
      "- If the condition is not met, do not ask the user any questions and do not request interaction; just clean up and finish silently.",
      "- If the condition is met, call sandy.request_interaction with a concise notification message, wait until Sandy says the task became interactive, then notify the user.",
      "- After notifying the user, call sandy.delete_job for the current job so the monitoring stops after success.",
      "- After job deletion is handled, call sandy.terminate_task to finalize the scheduled task.",
      "",
      "When creating the job and generated skill:",
      "- Choose clear, stable names and IDs derived from the monitored condition.",
      "- Include the exact condition being checked in the generated skill instructions.",
      "- Include the exact schedule in the job definition.",
      "- Keep the generated skill focused only on checking the condition, cleaning the workspace, notifying on success, and deleting the job on success.",
    ].join("\n"),
  },
] as const satisfies readonly BuiltInSkillDefinition[];

const builtInSkillIds = new Set<string>(builtInSkills.map((skill) => skill.skillId));

export function isBuiltInSkillId(skillId: string): boolean {
  return builtInSkillIds.has(skillId);
}

export function getBuiltInSkillDefinitions(): readonly BuiltInSkillDefinition[] {
  return builtInSkills;
}

export function materializeBuiltInSkillsDirectory(configDirectory: string): string {
  const runtimeDirectory = builtInSkillsRuntimeDirectory(configDirectory);
  mkdirSync(runtimeDirectory, { recursive: true });

  for (const skill of builtInSkills) {
    const skillDirectory = join(runtimeDirectory, skill.skillId);
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(join(skillDirectory, "SKILL.md"), renderBuiltInSkillFile(skill), "utf8");
  }

  return runtimeDirectory;
}
