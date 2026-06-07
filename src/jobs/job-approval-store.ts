import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { jobApprovalsFile } from "../state-paths.js";

const hostDirectoryLevelSchema = z.enum(["read_only", "read_write"]);

const mcpToolApprovalSchema = z.object({
  serverId: z.string().min(1),
  toolName: z.string().min(1),
}).strict();

const mcpResourceApprovalSchema = z.object({
  serverId: z.string().min(1),
  uri: z.string().min(1),
}).strict();

const httpTokenApprovalSchema = z.object({
  tokenId: z.string().min(1),
  host: z.string().min(1),
}).strict();

const hostDirectoryApprovalSchema = z.object({
  path: z.string().min(1),
  level: hostDirectoryLevelSchema,
}).strict();

const jobApprovalStateSchema = z.object({
  jobId: z.string().min(1),
  mcpTools: z.array(mcpToolApprovalSchema),
  mcpResources: z.array(mcpResourceApprovalSchema),
  httpTokens: z.array(httpTokenApprovalSchema),
  hostDirectories: z.array(hostDirectoryApprovalSchema),
}).strict();

const jobApprovalsFileSchema = z.object({
  approvals: z.array(jobApprovalStateSchema),
}).strict();

type HostDirectoryApproval = z.infer<typeof hostDirectoryApprovalSchema>;

type JobApprovalState = z.infer<typeof jobApprovalStateSchema>;

type JobApprovalsFile = z.infer<typeof jobApprovalsFileSchema>;

export class JobApprovalStore {
  private readonly filePath: string;

  constructor(configDirectory: string) {
    this.filePath = jobApprovalsFile(configDirectory);
  }

  async isToolAlwaysAllowed(jobId: string, serverId: string, toolName: string): Promise<boolean> {
    const state = await this.getJobState(jobId);
    return state.mcpTools.some((entry) => entry.serverId === serverId && entry.toolName === toolName);
  }

  async allowTool(jobId: string, serverId: string, toolName: string): Promise<void> {
    await this.updateJobState(jobId, (state) => {
      if (!state.mcpTools.some((entry) => entry.serverId === serverId && entry.toolName === toolName)) {
        state.mcpTools.push({ serverId, toolName });
      }
    });
  }

  async isResourceReadAlwaysAllowed(jobId: string, serverId: string, uri: string): Promise<boolean> {
    const state = await this.getJobState(jobId);
    return state.mcpResources.some((entry) => entry.serverId === serverId && entry.uri === uri);
  }

  async allowResourceRead(jobId: string, serverId: string, uri: string): Promise<void> {
    await this.updateJobState(jobId, (state) => {
      if (!state.mcpResources.some((entry) => entry.serverId === serverId && entry.uri === uri)) {
        state.mcpResources.push({ serverId, uri });
      }
    });
  }

  async isHttpTokenAlwaysAllowed(jobId: string, tokenId: string, host: string): Promise<boolean> {
    const state = await this.getJobState(jobId);
    return state.httpTokens.some((entry) => entry.tokenId === tokenId && entry.host === host);
  }

  async allowHttpToken(jobId: string, tokenId: string, host: string): Promise<void> {
    await this.updateJobState(jobId, (state) => {
      if (!state.httpTokens.some((entry) => entry.tokenId === tokenId && entry.host === host)) {
        state.httpTokens.push({ tokenId, host });
      }
    });
  }

  async isHostDirectoryAlwaysAllowed(jobId: string, path: string, level: "read_only" | "read_write"): Promise<boolean> {
    const state = await this.getJobState(jobId);
    return isHostDirectoryAllowed(state.hostDirectories, path, level);
  }

  async allowHostDirectory(jobId: string, path: string, level: "read_only" | "read_write"): Promise<void> {
    await this.updateJobState(jobId, (state) => {
      const existing = state.hostDirectories.find((entry) => entry.path === path);
      if (!existing) {
        state.hostDirectories.push({ path, level });
        return;
      }
      if (existing.level === "read_write" || level === "read_only") {
        return;
      }
      existing.level = level;
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
    await this.save(data);
  }

  private async load(): Promise<JobApprovalsFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return jobApprovalsFileSchema.parse(JSON.parse(raw));
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
    mcpTools: [],
    mcpResources: [],
    httpTokens: [],
    hostDirectories: [],
  };
}

function isHostDirectoryAllowed(entries: HostDirectoryApproval[], path: string, level: "read_only" | "read_write"): boolean {
  return entries.some((entry) => entry.path === path && (entry.level === "read_write" || level === "read_only"));
}
