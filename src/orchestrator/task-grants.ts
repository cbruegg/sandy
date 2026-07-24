import type { JobApprovalStoreApi } from "../jobs/job-approval-store.js";
import type { HostDirectoryAccessLevel } from "../hostfs/path-policy.js";
import type { ActiveTaskState } from "../types.js";

export function isTaskToolGrantAllowed(
  task: ActiveTaskState,
  serverId: string,
  toolName: string,
): boolean {
  return task.approvedMcpTools.some((entry) => entry.serverId === serverId && entry.toolName === toolName);
}

export function grantTaskToolAccess(
  task: ActiveTaskState,
  serverId: string,
  toolName: string,
): void {
  if (isTaskToolGrantAllowed(task, serverId, toolName)) {
    return;
  }
  task.approvedMcpTools.push({ serverId, toolName });
}

export function isTaskResourceReadGrantAllowed(
  task: ActiveTaskState,
  serverId: string,
  uri: string,
): boolean {
  return task.approvedMcpResourceReads.some((entry) => entry.serverId === serverId && entry.uri === uri);
}

export function grantTaskResourceReadAccess(
  task: ActiveTaskState,
  serverId: string,
  uri: string,
): void {
  if (isTaskResourceReadGrantAllowed(task, serverId, uri)) {
    return;
  }
  task.approvedMcpResourceReads.push({ serverId, uri });
}

export function grantTaskHostDirectoryAccess(
  task: ActiveTaskState,
  path: string,
  level: HostDirectoryAccessLevel,
): void {
  const existing = task.approvedHostDirectories.find((grant) => grant.path === path);
  if (existing) {
    if (existing.level === "read_write" || level === "read_only") {
      return;
    }
    existing.level = level;
    return;
  }
  task.approvedHostDirectories.push({ path, level });
}

export function isTaskHostDirectoryAccessAllowed(
  task: ActiveTaskState,
  path: string,
  level: HostDirectoryAccessLevel,
): boolean {
  return task.approvedHostDirectories.some(
    (grant) => grant.path === path && (grant.level === "read_write" || level === "read_only"),
  );
}

export function grantHttpTokenOnce(
  task: ActiveTaskState,
  tokenId: string,
  host: string,
): void {
  task.approvedHttpTokenOnceGrants.push({ tokenId, host, consumed: false });
}

export function grantHttpTokenSessionAccess(
  task: ActiveTaskState,
  tokenId: string,
  host: string,
): void {
  if (task.approvedHttpTokenSessionGrants.some((entry) => entry.tokenId === tokenId && entry.host === host)) {
    return;
  }
  task.approvedHttpTokenSessionGrants.push({ tokenId, host });
}

export function isMcpAutoApprovalAllowed(task: ActiveTaskState, serverId: string): boolean {
  return task.taskPolicy.autoApproveMcpServers.includes(serverId);
}

export function isHttpTokenAutoApprovalAllowed(task: ActiveTaskState, tokenId: string): boolean {
  return task.taskPolicy.autoApproveHttpTokens.includes(tokenId);
}

export async function grantMcpAutoApprovalForTask(
  jobApprovalStore: JobApprovalStoreApi,
  task: ActiveTaskState,
  serverId: string,
): Promise<void> {
  await updateTaskPolicy(jobApprovalStore, task, () => {
    if (isMcpAutoApprovalAllowed(task, serverId)) {
      return false;
    }
    task.taskPolicy.autoApproveMcpServers.push(serverId);
    return true;
  });
}

export async function grantMcpToolApprovalForJob(
  jobApprovalStore: JobApprovalStoreApi,
  task: ActiveTaskState,
  serverId: string,
  toolName: string,
): Promise<void> {
  grantTaskToolAccess(task, serverId, toolName);
  if (task.origin.kind === "launchedByJob") {
    await jobApprovalStore.allowMcpTool(task.origin.jobId, serverId, toolName);
  }
}

export async function grantMcpResourceReadApprovalForJob(
  jobApprovalStore: JobApprovalStoreApi,
  task: ActiveTaskState,
  serverId: string,
  uri: string,
): Promise<void> {
  grantTaskResourceReadAccess(task, serverId, uri);
  if (task.origin.kind === "launchedByJob") {
    await jobApprovalStore.allowMcpResourceRead(task.origin.jobId, serverId, uri);
  }
}

export async function grantHttpTokenAutoApprovalForTask(
  jobApprovalStore: JobApprovalStoreApi,
  task: ActiveTaskState,
  tokenId: string,
): Promise<void> {
  await updateTaskPolicy(jobApprovalStore, task, () => {
    if (isHttpTokenAutoApprovalAllowed(task, tokenId)) {
      return false;
    }
    task.taskPolicy.autoApproveHttpTokens.push(tokenId);
    return true;
  });
}

async function updateTaskPolicy(
  jobApprovalStore: JobApprovalStoreApi,
  task: ActiveTaskState,
  applyMutation: () => boolean,
): Promise<void> {
  const changed = applyMutation();
  if (!changed || task.origin.kind !== "launchedByJob") {
    return;
  }
  await jobApprovalStore.saveTaskPolicy(task.origin.jobId, task.taskPolicy);
}
