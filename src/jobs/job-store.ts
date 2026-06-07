import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { jobWorkspace, jobsFile } from "../state-paths.js";
import { jobDefinitionSchema, validateJobDefinition } from "./job-validation.js";
import type { JobDefinition, JobRuntimeState, JobsFile } from "./job-types.js";

const jobRuntimeStateSchema: z.ZodType<JobRuntimeState> = z.object({
  jobId: z.string().min(1),
  lastRunAt: z.string().nullable(),
  lastTaskId: z.string().nullable(),
}).strict();

const jobsFileSchema: z.ZodType<JobsFile> = z.object({
  definitions: z.array(jobDefinitionSchema),
  runtimeState: z.array(jobRuntimeStateSchema),
}).strict();

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
    if (!data.runtimeState.some((state) => state.jobId === validDefinition.id)) {
      data.runtimeState.push({ jobId: validDefinition.id, lastRunAt: null, lastTaskId: null });
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
      state = { jobId, lastRunAt: null, lastTaskId: null };
      data.runtimeState.push(state);
      await this.save(data);
    }
    return state;
  }

  async recordLaunch(jobId: string, taskId: string, runAt: string): Promise<void> {
    const data = await this.load();
    let state = data.runtimeState.find((candidate) => candidate.jobId === jobId);
    if (!state) {
      state = { jobId, lastRunAt: runAt, lastTaskId: taskId };
      data.runtimeState.push(state);
    } else {
      state.lastRunAt = runAt;
      state.lastTaskId = taskId;
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
