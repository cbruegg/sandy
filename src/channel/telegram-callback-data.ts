import type { ControlActionEvent } from "./control-surface.js";

export function parseTelegramCallbackData(data: string): ControlActionEvent | null {
  if (data.startsWith("approve:")) {
    return {
      kind: "approval_response",
      target: "privilege_request",
      decision: "approve",
      requestId: data.slice("approve:".length) || undefined,
    };
  }

  if (data.startsWith("approve_once:")) {
    return {
      kind: "approval_response",
      target: "privilege_request",
      decision: "approve_once",
      requestId: data.slice("approve_once:".length) || undefined,
    };
  }

  if (data.startsWith("approve_worker_session:")) {
    return {
      kind: "approval_response",
      target: "privilege_request",
      decision: "approve_worker_session",
      requestId: data.slice("approve_worker_session:".length) || undefined,
    };
  }

  if (data.startsWith("approve_always:")) {
    return {
      kind: "approval_response",
      target: "privilege_request",
      decision: "approve_always",
      requestId: data.slice("approve_always:".length) || undefined,
    };
  }

  if (data.startsWith("deny:")) {
    return {
      kind: "approval_response",
      target: "privilege_request",
      decision: "deny",
      requestId: data.slice("deny:".length) || undefined,
    };
  }

  if (data.startsWith("share_approve:")) {
    return {
      kind: "approval_response",
      target: "share_deletion",
      decision: "approve",
      requestId: data.slice("share_approve:".length) || undefined,
    };
  }

  if (data.startsWith("share_deny:")) {
    return {
      kind: "approval_response",
      target: "share_deletion",
      decision: "deny",
      requestId: data.slice("share_deny:".length) || undefined,
    };
  }

  if (data.startsWith("summary_confirm:")) {
    return {
      kind: "approval_response",
      target: "task_summary_confirmation",
      decision: "approve",
      requestId: data.slice("summary_confirm:".length) || undefined,
    };
  }

  if (data === "report") {
    return { kind: "danger_report" };
  }

  if (data === "cancel") {
    return { kind: "cancel_request" };
  }

  if (data === "mark_finished") {
    return { kind: "mark_finished_request" };
  }

  return null;
}

export function serializeTelegramCallbackData(actionId: string, event: ControlActionEvent): string {
  if (event.kind === "approval_response" && event.requestId) {
    return `${actionId}:${event.requestId}`;
  }
  return actionId;
}
