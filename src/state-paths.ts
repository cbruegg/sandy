import { join } from "node:path";

export function sandyStateRoot(configDirectory: string): string {
  return join(configDirectory, "state");
}

export function matrixStateRoot(configDirectory: string): string {
  return join(sandyStateRoot(configDirectory), "matrix");
}

export function jobsRoot(configDirectory: string): string {
  return join(sandyStateRoot(configDirectory), "jobs");
}

export function jobsFile(configDirectory: string): string {
  return join(jobsRoot(configDirectory), "jobs.json");
}

export function jobWorkspaceRoot(configDirectory: string): string {
  return join(jobsRoot(configDirectory), "workspaces");
}

export function jobWorkspace(configDirectory: string, jobId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(jobId)) {
    throw new Error("Job ID must contain only letters, numbers, underscores, and hyphens, and must not be empty.");
  }
  return join(jobWorkspaceRoot(configDirectory), jobId);
}

export function channelStateFile(configDirectory: string): string {
  return join(sandyStateRoot(configDirectory), "channel.json");
}
