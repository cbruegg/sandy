import { join } from "node:path";
import { sharedWorkspaceMountPath } from "./shared-workspace.js";

export const workerUserSkillsPath = "/root/.agents/skills";
export const workerBuiltInSkillsPath = join(sharedWorkspaceMountPath, ".agents", "skills");
