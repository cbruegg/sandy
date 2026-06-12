import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { jobWorkspace, jobsFile } from "../state-paths.js";
import { jobsFileSchema, validateJobDefinition } from "./job-validation.js";
import type { JobDefinition, JobRuntimeState, JobsFile } from "./job-validation.js";

export class JobStore {
  private readonly filePath: string;

  constructor(private readonly configDirectory: string) {
    this.filePath = jobsFile(configDirectory);
  }

  async listDefinitions(): Promise<JobDefinition[]> {
    return (await this.load()).definitions;
  }

  async getDefinition(jobId: string): Promise<JobDefinition | null> {
    return (await this.load()).definitions.find((definition) => definition.id === jobId) ?? null;
  }

  async upsertDefinition(definition: JobDefinition): Promise<void> {
    const validDefinition = validateJobDefinition(definition);
    const data = await this.load();
    const index = data.definitions.findIndex((candidate) => candidate.id === validDefinition.id);
    if (index === -1) data.definitions.push(validDefinition);
    else data.definitions[index] = validDefinition;
    const existingState = data.runtimeState.find((state) => state.jobId === validDefinition.id);
    if (!existingState) {
      data.runtimeState.push({ jobId: validDefinition.id, lastRunAt: null });
    } else if (validDefinition.schedule.kind === "one_shot") {
      // When a one-shot job definition is replaced, reset its lastRunAt so the
      // scheduler picks up the new run time instead of skipping it.
      existingState.lastRunAt = null;
    }
    await this.save(data);
  }

  async deleteDefinition(jobId: string): Promise<void> {
    const data = await this.load();
    data.definitions = data.definitions.filter((definition) => definition.id !== jobId);
    data.runtimeState = data.runtimeState.filter((state) => state.jobId !== jobId);
    await this.save(data);
  }

  async setEnabled(jobId: string, enabled: boolean): Promise<void> {
    const data = await this.load();
    const definition = data.definitions.find((candidate) => candidate.id === jobId);
    if (!definition) throw new Error(`Job ${jobId} does not exist.`);
    definition.enabled = enabled;
    await this.save(data);
  }

  async getRuntimeState(jobId: string): Promise<JobRuntimeState> {
    const data = await this.load();
    let state = data.runtimeState.find((candidate) => candidate.jobId === jobId);
    if (!state) {
      state = { jobId, lastRunAt: null };
      data.runtimeState.push(state);
      await this.save(data);
    }
    return state;
  }

  async recordLaunch(jobId: string, runAt: string): Promise<void> {
    const data = await this.load();
    let state = data.runtimeState.find((candidate) => candidate.jobId === jobId);
    if (!state) {
      state = { jobId, lastRunAt: runAt };
      data.runtimeState.push(state);
    } else {
      state.lastRunAt = runAt;
    }
    await this.save(data);
  }

  workspacePath(jobId: string): string {
    return jobWorkspace(this.configDirectory, jobId);
  }

  private async load(): Promise<JobsFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return jobsFileSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { definitions: [], runtimeState: [] };
      }
      throw error;
    }
  }

  private async save(data: JobsFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}
