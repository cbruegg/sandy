import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { jobApprovalsFile } from "../state-paths.js";
import type { TaskAutoApprovalEligibility } from "../types/main-agent.js";

const autoApprovalEligibilitySchema = z.object({
  eligibleMcpServers: z.array(z.string().min(1)),
  eligibleHttpTokens: z.array(z.string().min(1)),
}).strict();

const mcpToolApprovalSchema = z.object({ serverId: z.string().min(1), toolName: z.string().min(1) }).strict();
const mcpResourceReadApprovalSchema = z.object({ serverId: z.string().min(1), uri: z.string().min(1) }).strict();

const jobApprovalStateSchema = z.object({
  jobId: z.string().min(1),
  autoApprovalEligibility: autoApprovalEligibilitySchema,
  approvedMcpTools: z.array(mcpToolApprovalSchema).default([]),
  approvedMcpResourceReads: z.array(mcpResourceReadApprovalSchema).default([]),
}).strict();

const jobApprovalsFileSchema = z.object({
  approvals: z.array(jobApprovalStateSchema),
}).strict();

type JobApprovalState = z.infer<typeof jobApprovalStateSchema>;
type JobApprovalsFile = z.infer<typeof jobApprovalsFileSchema>;
export type JobMcpApprovals = Pick<JobApprovalState, "approvedMcpTools" | "approvedMcpResourceReads">;

export interface JobApprovalStoreApi {
  getAutoApprovalEligibility(jobId: string): Promise<TaskAutoApprovalEligibility>;
  saveAutoApprovalEligibility(jobId: string, autoApprovalEligibility: TaskAutoApprovalEligibility): Promise<void>;
  getMcpApprovals(jobId: string): Promise<JobMcpApprovals>;
  allowMcpTool(jobId: string, serverId: string, toolName: string): Promise<void>;
  allowMcpResourceRead(jobId: string, serverId: string, uri: string): Promise<void>;
}

export class JobApprovalStore implements JobApprovalStoreApi {
  private readonly filePath: string;

  constructor(configDirectory: string) {
    this.filePath = jobApprovalsFile(configDirectory);
  }

  async getAutoApprovalEligibility(jobId: string): Promise<TaskAutoApprovalEligibility> {
    const state = await this.getJobState(jobId);
    return cloneAutoApprovalEligibility(state.autoApprovalEligibility);
  }

  async saveAutoApprovalEligibility(jobId: string, autoApprovalEligibility: TaskAutoApprovalEligibility): Promise<void> {
    const normalizedTaskPolicy = normalizeAutoApprovalEligibility(autoApprovalEligibility);
    await this.updateJobState(jobId, (state) => {
      state.autoApprovalEligibility = normalizedTaskPolicy;
    });
  }

  async getMcpApprovals(jobId: string): Promise<JobMcpApprovals> {
    const state = await this.getJobState(jobId);
    return {
      approvedMcpTools: state.approvedMcpTools.map((entry) => ({ ...entry })),
      approvedMcpResourceReads: state.approvedMcpResourceReads.map((entry) => ({ ...entry })),
    };
  }

  async allowMcpTool(jobId: string, serverId: string, toolName: string): Promise<void> {
    await this.updateJobState(jobId, (state) => {
      if (!state.approvedMcpTools.some((entry) => entry.serverId === serverId && entry.toolName === toolName)) {
        state.approvedMcpTools.push({ serverId, toolName });
      }
    });
  }

  async allowMcpResourceRead(jobId: string, serverId: string, uri: string): Promise<void> {
    await this.updateJobState(jobId, (state) => {
      if (!state.approvedMcpResourceReads.some((entry) => entry.serverId === serverId && entry.uri === uri)) {
        state.approvedMcpResourceReads.push({ serverId, uri });
      }
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
    state.autoApprovalEligibility = normalizeAutoApprovalEligibility(state.autoApprovalEligibility);
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
    autoApprovalEligibility: emptyAutoApprovalEligibility(),
    approvedMcpTools: [],
    approvedMcpResourceReads: [],
  };
}

function normalizeAutoApprovalEligibility(autoApprovalEligibility: TaskAutoApprovalEligibility): TaskAutoApprovalEligibility {
  return {
    eligibleMcpServers: uniqueSortedStrings(autoApprovalEligibility.eligibleMcpServers),
    eligibleHttpTokens: uniqueSortedStrings(autoApprovalEligibility.eligibleHttpTokens),
  };
}

function cloneAutoApprovalEligibility(autoApprovalEligibility: TaskAutoApprovalEligibility): TaskAutoApprovalEligibility {
  return {
    eligibleMcpServers: [...autoApprovalEligibility.eligibleMcpServers],
    eligibleHttpTokens: [...autoApprovalEligibility.eligibleHttpTokens],
  };
}

function emptyAutoApprovalEligibility(): TaskAutoApprovalEligibility {
  return {
    eligibleMcpServers: [],
    eligibleHttpTokens: [],
  };
}

function uniqueSortedStrings(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}
