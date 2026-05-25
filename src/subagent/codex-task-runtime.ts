import { sharedWorkspaceMountPath } from "../shared-workspace.js";

// Docker is the actual isolation boundary for sub-agents; avoid nested
// bwrap sandboxing in-container.
const workerCodexSandboxMode = "danger-full-access" as const;
const appServerApprovalPolicy = "never" as const;
const appServerPersonality = "none" as const;

export function buildAppServerThreadStartParams(model?: string) {
  return {
    ...(model ? { model } : {}),
    cwd: sharedWorkspaceMountPath,
    approvalPolicy: appServerApprovalPolicy,
    sandbox: workerCodexSandboxMode,
    personality: appServerPersonality,
  };
}
