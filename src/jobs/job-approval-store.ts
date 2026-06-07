import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { jobApprovalsFile } from "../state-paths.js";
import type { MainAgentTaskPolicy } from "../types/main-agent.js";

const taskPolicySchema = z.object({
  autoApproveMcpServers: z.array(z.string().min(1)),
  autoApproveHttpTokens: z.array(z.string().min(1)),
}).strict();

const jobApprovalStateSchema = z.object({
  jobId: z.string().min(1),
  taskPolicy: taskPolicySchema,
}).strict();

const jobApprovalsFileSchema = z.object({
  approvals: z.array(jobApprovalStateSchema),
}).strict();

type JobApprovalState = z.infer<typeof jobApprovalStateSchema>;
type JobApprovalsFile = z.infer<typeof jobApprovalsFileSchema>;

export interface JobApprovalStoreApi {
  getTaskPolicy(jobId: string): Promise<MainAgentTaskPolicy>;
  saveTaskPolicy(jobId: string, taskPolicy: MainAgentTaskPolicy): Promise<void>;
}

export class JobApprovalStore implements JobApprovalStoreApi {
  private readonly filePath: string;

  constructor(configDirectory: string) {
    this.filePath = jobApprovalsFile(configDirectory);
  }

  async getTaskPolicy(jobId: string): Promise<MainAgentTaskPolicy> {
    const state = await this.getJobState(jobId);
    return cloneTaskPolicy(state.taskPolicy);
  }

  async saveTaskPolicy(jobId: string, taskPolicy: MainAgentTaskPolicy): Promise<void> {
    const normalizedTaskPolicy = normalizeTaskPolicy(taskPolicy);
    await this.updateJobState(jobId, (state) => {
      state.taskPolicy = normalizedTaskPolicy;
    });
  }

  private async getJobState(jobId: string): Promise<JobApprovalState> {
    const data = await this.load();
    return data.approvals.find((entry) => entry.jobId === jobId) ?? emptyJobApprovalState(jobId);
  }

  private async updateJobState(jobId: string, update: (state: JobApprovalState) => void): Promise<void> {
    const data = await this.load();
    let state = data.approvals.find((entry) => entry.jobId === jobId);
    if (!state) {
      state = emptyJobApprovalState(jobId);
      data.approvals.push(state);
    }
    update(state);
    state.taskPolicy = normalizeTaskPolicy(state.taskPolicy);
    await this.save(data);
  }

  private async load(): Promise<JobApprovalsFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return jobApprovalsFileSchema.parse(parsed);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return { approvals: [] };
      }
      throw error;
    }
  }

  private async save(data: JobApprovalsFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

function emptyJobApprovalState(jobId: string): JobApprovalState {
  return {
    jobId,
    taskPolicy: emptyTaskPolicy(),
  };
}

function normalizeTaskPolicy(taskPolicy: MainAgentTaskPolicy): MainAgentTaskPolicy {
  return {
    autoApproveMcpServers: uniqueSortedStrings(taskPolicy.autoApproveMcpServers),
    autoApproveHttpTokens: uniqueSortedStrings(taskPolicy.autoApproveHttpTokens),
  };
}

function cloneTaskPolicy(taskPolicy: MainAgentTaskPolicy): MainAgentTaskPolicy {
  return {
    autoApproveMcpServers: [...taskPolicy.autoApproveMcpServers],
    autoApproveHttpTokens: [...taskPolicy.autoApproveHttpTokens],
  };
}

function emptyTaskPolicy(): MainAgentTaskPolicy {
  return {
    autoApproveMcpServers: [],
    autoApproveHttpTokens: [],
  };
}

function uniqueSortedStrings(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}
