import { sharedWorkspaceMountPath } from "../shared-workspace.js";

const workerCodexSandboxMode = "danger-full-access" as const;
const workerCodexNetworkAccessEnabled = true;
const appServerApprovalPolicy = "never" as const;
const appServerPersonality = "none" as const;

export function buildCodexExecThreadOptions(model?: string) {
  return {
    ...(model ? { model } : {}),
    workingDirectory: sharedWorkspaceMountPath,
    skipGitRepoCheck: true,
    // Docker is the actual isolation boundary for sub-agents; avoid nested
    // bwrap sandboxing in-container.
    sandboxMode: workerCodexSandboxMode,
    networkAccessEnabled: workerCodexNetworkAccessEnabled,
  };
}

export function buildAppServerThreadStartParams(model?: string) {
  return {
    ...(model ? { model } : {}),
    cwd: sharedWorkspaceMountPath,
    approvalPolicy: appServerApprovalPolicy,
    sandbox: workerCodexSandboxMode,
    personality: appServerPersonality,
  };
}
