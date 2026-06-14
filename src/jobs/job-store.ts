import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { jobWorkspace, jobsFile } from "../state-paths.js";
import { jobsFileSchema, validateJobDefinition, hasOneShotRunForSchedule } from "./job-validation.js";
import type { JobDefinition, JobRuntimeState, JobsFile } from "./job-validation.js";

export class JobStore {
  private readonly filePath: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

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
    await this.updateJobsFile((data) => {
      const index = data.definitions.findIndex((candidate) => candidate.id === validDefinition.id);
      if (index === -1) data.definitions.push(validDefinition);
      else data.definitions[index] = validDefinition;
      const existingState = data.runtimeState.find((state) => state.jobId === validDefinition.id);
      if (!existingState) {
        data.runtimeState.push({ jobId: validDefinition.id, lastRunAt: null });
      }
    });
  }

  async deleteDefinition(jobId: string): Promise<void> {
    const deletedDefinitions = await this.updateJobsFile((data) => {
      const deletedDefinitions = data.definitions.filter((definition) => definition.id === jobId);
      data.definitions = data.definitions.filter((definition) => definition.id !== jobId);
      data.runtimeState = data.runtimeState.filter((state) => state.jobId !== jobId);
      return deletedDefinitions;
    });
    await this.archiveOwnedSkills(deletedDefinitions);
  }

  async setEnabled(jobId: string, enabled: boolean): Promise<void> {
    await this.updateJobsFile((data) => {
      const definition = data.definitions.find((candidate) => candidate.id === jobId);
      if (!definition) throw new Error(`Job ${jobId} does not exist.`);
      definition.enabled = enabled;
    });
  }

  async getRuntimeState(jobId: string): Promise<JobRuntimeState> {
    const data = await this.load();
    const existing = data.runtimeState.find((candidate) => candidate.jobId === jobId);
    if (existing) return existing;

    return this.updateJobsFile((data) => {
      let state = data.runtimeState.find((candidate) => candidate.jobId === jobId);
      if (!state) {
        state = { jobId, lastRunAt: null };
        data.runtimeState.push(state);
      }
      return state;
    });
  }

  async recordLaunch(jobId: string, runAt: string): Promise<void> {
    await this.updateJobsFile((data) => {
      let state = data.runtimeState.find((candidate) => candidate.jobId === jobId);
      if (!state) {
        state = { jobId, lastRunAt: runAt };
        data.runtimeState.push(state);
      } else {
        state.lastRunAt = runAt;
      }
    });
  }

  /**
   * Atomically claims a one-shot launch for `scheduledRunAt` by setting
   * `lastRunAt` to `launchedAt`. The claim is denied when the stored
   * `lastRunAt` is already at or after `scheduledRunAt`, which prevents
   * duplicate launches for the same scheduled run while still allowing a
   * rescheduled future run to execute.
   *
   * Returns `true` when the launch was claimed; `false` when the scheduled
   * run was already consumed.
   */
  async tryClaimOneShotLaunch(jobId: string, scheduledRunAt: string, launchedAt: string): Promise<boolean> {
    return this.updateJobsFile((data) => {
      const state = data.runtimeState.find((candidate) => candidate.jobId === jobId);
      if (state && hasOneShotRunForSchedule(state, scheduledRunAt)) {
        return false;
      }
      if (!state) {
        data.runtimeState.push({ jobId, lastRunAt: launchedAt });
      } else {
        state.lastRunAt = launchedAt;
      }
      return true;
    });
  }

  /**
   * Deletes one-shot jobs whose scheduled run has been consumed
   * (lastRunAt >= runAt) and whose lastRunAt is before `cutoffTimestamp`
   * (epoch ms). Returns the number of deleted jobs.
   */
  async deleteOldOneShots(cutoffTimestamp: number): Promise<number> {
    const deletedDefinitions = await this.updateJobsFile((data) => {
      const toRemove = new Set<string>();
      for (const state of data.runtimeState) {
        if (!state.lastRunAt) continue;
        if (Date.parse(state.lastRunAt) >= cutoffTimestamp) continue;
        const def = data.definitions.find((d) => d.id === state.jobId);
        if (!def) continue;
        if (def.schedule.kind !== "one_shot") continue;
        if (!hasOneShotRunForSchedule(state, def.schedule.runAt)) continue;
        toRemove.add(state.jobId);
      }
      if (toRemove.size === 0) return [];
      const deletedDefinitions = data.definitions.filter((d) => toRemove.has(d.id));
      data.definitions = data.definitions.filter((d) => !toRemove.has(d.id));
      data.runtimeState = data.runtimeState.filter((s) => !toRemove.has(s.jobId));
      return deletedDefinitions;
    });
    await this.archiveOwnedSkills(deletedDefinitions);
    return deletedDefinitions.length;
  }

  workspacePath(jobId: string): string {
    return jobWorkspace(this.configDirectory, jobId);
  }

  private async updateJobsFile<T>(fn: (data: JobsFile) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const data = await this.load();
      const result = fn(data);
      await this.save(data);
      return result;
    };
    const task = this.writeQueue.then(run, run);
    this.writeQueue = task.catch(() => {});
    return task;
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

  private async archiveOwnedSkills(deletedDefinitions: JobDefinition[]): Promise<void> {
    for (const definition of deletedDefinitions) {
      if (!definition.jobOwnsSkill) continue;
      await this.archiveSkill(definition.skillId);
    }
  }

  private async archiveSkill(skillId: string): Promise<void> {
    if (!skillId || /[\\/]/.test(skillId) || skillId === "." || skillId === "..") {
      throw new Error(`Invalid skillId "${skillId}".`);
    }

    const sourceDirectory = join(this.configDirectory, "skills", skillId);
    const archiveDirectory = join(this.configDirectory, "archived-skills");
    await mkdir(archiveDirectory, { recursive: true });
    try {
      await rename(sourceDirectory, join(archiveDirectory, `${skillId}-${randomUUID()}`));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}
