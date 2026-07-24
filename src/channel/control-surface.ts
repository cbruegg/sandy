import type { ApprovalResponseTarget, NormalizedChatEvent, PrivilegeRequest } from "../types.js";
import { buttonLabels } from "../messages-to-user.js";

export type ControlActionEvent =
  | { kind: "cancel_request" }
  | { kind: "mark_finished_request" }
  | { kind: "danger_report" }
  | { kind: "approval_response"; target: ApprovalTarget; decision: ApprovalDecision; requestId: string | undefined };

type ApprovalDecision = Extract<
  NormalizedChatEvent,
  { kind: "approval_response" }
>["decision"];

type ApprovalTarget = ApprovalResponseTarget;

type ControlAction = {
  actionId: string;
  label: string;
  event: ControlActionEvent;
};

export type ControlSurface = {
  rows: ControlAction[][];
};

export function buildTaskControls(): ControlSurface {
  return {
    rows: [
      [
        { actionId: "cancel", label: buttonLabels.abortTask, event: { kind: "cancel_request" } },
        { actionId: "mark_finished", label: buttonLabels.markAsFinished, event: { kind: "mark_finished_request" } },
      ],
    ],
  };
}

export function buildReportControls(): ControlSurface {
  return {
    rows: [
      [
        { actionId: "report", label: buttonLabels.reportDangerousOutput, event: { kind: "danger_report" } },
      ],
    ],
  };
}

export function buildTaskSummaryConfirmationControls(requestId: string): ControlSurface {
  return {
    rows: [
      [
        { actionId: "summary_confirm", label: buttonLabels.confirmSummary, event: { kind: "approval_response", target: "task_summary_confirmation", decision: "approve", requestId } },
        { actionId: "report", label: buttonLabels.reportDangerousOutput, event: { kind: "danger_report" } },
      ],
    ],
  };
}

export function buildShareDeletionControls(requestId: string): ControlSurface {
  return {
    rows: [
      [
        { actionId: "share_approve", label: buttonLabels.approve, event: { kind: "approval_response", target: "share_deletion", decision: "approve", requestId } },
        { actionId: "share_deny", label: buttonLabels.deny, event: { kind: "approval_response", target: "share_deletion", decision: "deny", requestId } },
      ],
    ],
  };
}

export function buildPrivilegeControls(request: PrivilegeRequest): ControlSurface {
  const rows: ControlAction[][] = [];

  if (
    (request.kind === "mcp_tool_call" || request.kind === "mcp_resource_read" || request.kind === "http_token_use")
    && request.confirmsAutoApprovalForTask
  ) {
    rows.push([
      { actionId: "approve", label: buttonLabels.approve, event: { kind: "approval_response", target: "privilege_request", decision: "approve", requestId: request.requestId } },
      { actionId: "deny", label: buttonLabels.deny, event: { kind: "approval_response", target: "privilege_request", decision: "deny", requestId: request.requestId } },
    ]);
    rows.push([
      { actionId: "report", label: buttonLabels.reportDangerousOutput, event: { kind: "danger_report" } },
      { actionId: "cancel", label: buttonLabels.abortTask, event: { kind: "cancel_request" } },
    ]);
    return { rows };
  }

  if (request.kind === "mcp_tool_call" || request.kind === "mcp_resource_read" || request.kind === "http_token_use") {
    const canApproveForJob = (request.kind === "mcp_tool_call" || request.kind === "mcp_resource_read")
      && request.canApproveForJob;
    rows.push([
      { actionId: "approve_once", label: buttonLabels.approve, event: { kind: "approval_response", target: "privilege_request", decision: "approve_once", requestId: request.requestId } },
      { actionId: "approve_worker_session", label: buttonLabels.approveWorkerSession, event: { kind: "approval_response", target: "privilege_request", decision: "approve_worker_session", requestId: request.requestId } },
    ]);
    rows.push([
      ...(canApproveForJob
        ? [{ actionId: "approve_for_job", label: buttonLabels.approveForJob, event: { kind: "approval_response" as const, target: "privilege_request" as const, decision: "approve_for_job" as const, requestId: request.requestId } }]
        : []),
      { actionId: "approve_always", label: buttonLabels.approveAlways, event: { kind: "approval_response", target: "privilege_request", decision: "approve_always", requestId: request.requestId } },
      { actionId: "deny", label: buttonLabels.deny, event: { kind: "approval_response", target: "privilege_request", decision: "deny", requestId: request.requestId } },
    ]);
    rows.push([
      { actionId: "report", label: buttonLabels.reportDangerousOutput, event: { kind: "danger_report" } },
      { actionId: "cancel", label: buttonLabels.abortTask, event: { kind: "cancel_request" } },
    ]);
    return { rows };
  }

  if (request.kind === "host_directory_access") {
    rows.push([
      { actionId: "approve_worker_session", label: buttonLabels.approveWorkerSession, event: { kind: "approval_response", target: "privilege_request", decision: "approve_worker_session", requestId: request.requestId } },
      { actionId: "approve_always", label: buttonLabels.approveAlwaysHostDirectory, event: { kind: "approval_response", target: "privilege_request", decision: "approve_always", requestId: request.requestId } },
    ]);
    rows.push([
      { actionId: "deny", label: buttonLabels.deny, event: { kind: "approval_response", target: "privilege_request", decision: "deny", requestId: request.requestId } },
    ]);
    rows.push([
      { actionId: "report", label: buttonLabels.reportDangerousOutput, event: { kind: "danger_report" } },
      { actionId: "cancel", label: buttonLabels.abortTask, event: { kind: "cancel_request" } },
    ]);
    return { rows };
  }

  if (request.kind === "skill_mutation" || request.kind === "job_mutation") {
    rows.push([
      { actionId: "approve", label: buttonLabels.approve, event: { kind: "approval_response", target: "privilege_request", decision: "approve", requestId: request.requestId } },
      { actionId: "deny", label: buttonLabels.deny, event: { kind: "approval_response", target: "privilege_request", decision: "deny", requestId: request.requestId } },
    ]);
    rows.push([
      { actionId: "report", label: buttonLabels.reportDangerousOutput, event: { kind: "danger_report" } },
      { actionId: "cancel", label: buttonLabels.abortTask, event: { kind: "cancel_request" } },
    ]);
    return { rows };
  }

  rows.push([
    { actionId: "approve", label: buttonLabels.approve, event: { kind: "approval_response", target: "privilege_request", decision: "approve", requestId: request.requestId } },
    { actionId: "deny", label: buttonLabels.deny, event: { kind: "approval_response", target: "privilege_request", decision: "deny", requestId: request.requestId } },
  ]);
  rows.push([
    { actionId: "report", label: buttonLabels.reportDangerousOutput, event: { kind: "danger_report" } },
    { actionId: "cancel", label: buttonLabels.abortTask, event: { kind: "cancel_request" } },
  ]);
  return { rows };
}

/**
 * Returns a compact, stable identifier for privilege-request logs.
 * User-facing descriptions live in messages.privilegeRequestPrompt().
 */
export function formatPrivilegeRequestLogType(request: PrivilegeRequest): string {
  switch (request.kind) {
    case "file_copy":
      return request.payload.type;
    case "mcp_tool_call":
      return `${request.serverId}.${request.toolName}`;
    case "mcp_resource_read":
      return `resource:${request.serverId}:${request.uri}`;
    case "http_token_use":
      return `http:${request.tokenId}@${request.host}`;
    case "host_directory_access":
      return `host_directory_access:${request.path}:${request.level}`;
    case "skill_mutation":
      return `skill_mutation:${request.operation}:${request.skillId}`;
    case "job_mutation":
      return `job_mutation:${request.mutation.operation}:${request.mutation.jobId}`;
  }
}
