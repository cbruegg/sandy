import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildPrivilegeControls,
  buildReportControls,
  buildShareDeletionControls,
  buildTaskControls,
  formatPrivilegeRequestLogType,
} from "./control-surface.js";
import { buttonLabels } from "../messages-to-user.js";

test("buildTaskControls returns cancel and mark-finished actions", () => {
  const controls = buildTaskControls();
  assert.equal(controls.rows.length, 1);
  assert.equal(controls.rows[0]?.length, 2);
  assert.deepEqual(controls.rows[0]?.[0], {
    actionId: "cancel",
    label: buttonLabels.abortTask,
    event: { kind: "cancel_request" },
  });
  assert.deepEqual(controls.rows[0]?.[1], {
    actionId: "mark_finished",
    label: buttonLabels.markAsFinished,
    event: { kind: "mark_finished_request" },
  });
});

test("buildReportControls returns a report action", () => {
  const controls = buildReportControls();
  assert.equal(controls.rows.length, 1);
  assert.equal(controls.rows[0]?.length, 1);
  assert.deepEqual(controls.rows[0]?.[0], {
    actionId: "report",
    label: buttonLabels.reportDangerousOutput,
    event: { kind: "danger_report" },
  });
});

test("buildShareDeletionControls returns approve and deny actions", () => {
  const controls = buildShareDeletionControls("req-1");
  assert.equal(controls.rows.length, 1);
  assert.equal(controls.rows[0]?.length, 2);
  assert.deepEqual(controls.rows[0]?.[0], {
    actionId: "share_approve",
    label: buttonLabels.approve,
    event: { kind: "approval_response", decision: "approve", requestId: "req-1" },
  });
  assert.deepEqual(controls.rows[0]?.[1], {
    actionId: "share_deny",
    label: buttonLabels.deny,
    event: { kind: "approval_response", decision: "deny", requestId: "req-1" },
  });
});

test("buildPrivilegeControls for file_copy returns approve, deny, report, cancel", () => {
  const controls = buildPrivilegeControls({
    kind: "file_copy",
    requestId: "req-1",
    payload: { type: "copy_into_share", sourcePath: "/tmp", targetPath: "/share", reason: "test" },
  });
  assert.equal(controls.rows.length, 2);
  assert.equal(controls.rows[0]?.length, 2);
  assert.equal(controls.rows[0]?.[0]?.actionId, "approve");
  assert.equal(controls.rows[0]?.[0]?.event.kind, "approval_response");
  assert.deepEqual((controls.rows[0]?.[0]?.event as { kind: "approval_response"; decision: string }).decision, "approve");
  assert.equal(controls.rows[0]?.[1]?.actionId, "deny");
  assert.equal(controls.rows[1]?.length, 2);
  assert.equal(controls.rows[1]?.[0]?.actionId, "report");
  assert.equal(controls.rows[1]?.[1]?.actionId, "cancel");
});

test("buildPrivilegeControls for mcp_tool_call with auto-confirmation returns approve, deny, report, cancel", () => {
  const controls = buildPrivilegeControls({
    kind: "mcp_tool_call",
    requestId: "req-1",
    serverId: "test",
    toolName: "run",
    arguments: {},
    confirmsAutoApprovalForTask: true,
  });
  assert.equal(controls.rows.length, 2);
  assert.equal(controls.rows[0]?.length, 2);
  assert.equal(controls.rows[0]?.[0]?.actionId, "approve");
  assert.equal(controls.rows[0]?.[0]?.event.kind, "approval_response");
  assert.deepEqual((controls.rows[0]?.[0]?.event as { kind: "approval_response"; decision: string }).decision, "approve");
  assert.equal(controls.rows[0]?.[1]?.actionId, "deny");
  assert.equal(controls.rows[1]?.[0]?.actionId, "report");
  assert.equal(controls.rows[1]?.[1]?.actionId, "cancel");
});

test("buildPrivilegeControls for mcp_tool_call without auto-confirmation returns all scope options", () => {
  const controls = buildPrivilegeControls({
    kind: "mcp_tool_call",
    requestId: "req-1",
    serverId: "test",
    toolName: "run",
    arguments: {},
  });
  assert.equal(controls.rows.length, 3);
  assert.equal(controls.rows[0]?.length, 2);
  assert.equal(controls.rows[0]?.[0]?.actionId, "approve_once");
  assert.equal(controls.rows[0]?.[0]?.event.kind, "approval_response");
  assert.deepEqual((controls.rows[0]?.[0]?.event as { kind: "approval_response"; decision: string }).decision, "approve_once");
  assert.equal(controls.rows[0]?.[1]?.actionId, "approve_worker_session");
  assert.equal(controls.rows[1]?.length, 2);
  assert.equal(controls.rows[1]?.[0]?.actionId, "approve_always");
  assert.equal(controls.rows[1]?.[1]?.actionId, "deny");
  assert.equal(controls.rows[2]?.length, 2);
  assert.equal(controls.rows[2]?.[0]?.actionId, "report");
  assert.equal(controls.rows[2]?.[1]?.actionId, "cancel");
});

test("buildPrivilegeControls for host_directory_access returns session, always, deny, report, cancel", () => {
  const controls = buildPrivilegeControls({
    kind: "host_directory_access",
    requestId: "req-1",
    path: "/tmp",
    level: "read_only",
  });
  assert.equal(controls.rows.length, 3);
  assert.equal(controls.rows[0]?.length, 2);
  assert.equal(controls.rows[0]?.[0]?.actionId, "approve_worker_session");
  assert.equal(controls.rows[0]?.[1]?.actionId, "approve_always");
  assert.equal(controls.rows[1]?.length, 1);
  assert.equal(controls.rows[1]?.[0]?.actionId, "deny");
  assert.equal(controls.rows[2]?.length, 2);
  assert.equal(controls.rows[2]?.[0]?.actionId, "report");
  assert.equal(controls.rows[2]?.[1]?.actionId, "cancel");
});

test("buildPrivilegeControls for skill_mutation returns approve once, deny, report, cancel with no scoped approval", () => {
  const controls = buildPrivilegeControls({
    kind: "skill_mutation",
    requestId: "req-1",
    operation: "create",
    skillId: "my-skill",
    name: "My Skill",
    description: "Description.",
    body: "Body content.",
  });
  assert.equal(controls.rows.length, 2);
  assert.equal(controls.rows[0]?.length, 2);
  assert.equal(controls.rows[0]?.[0]?.actionId, "approve");
  assert.deepEqual((controls.rows[0]?.[0]?.event as { kind: "approval_response"; decision: string }).decision, "approve");
  assert.equal(controls.rows[0]?.[1]?.actionId, "deny");
  assert.equal(controls.rows[1]?.length, 2);
  assert.equal(controls.rows[1]?.[0]?.actionId, "report");
  assert.equal(controls.rows[1]?.[1]?.actionId, "cancel");

  // Verify no scoped approval buttons are present
  const allActionIds = controls.rows.flat().map((action) => action.actionId);
  assert.ok(!allActionIds.includes("approve_always"));
  assert.ok(!allActionIds.includes("approve_worker_session"));
  assert.ok(!allActionIds.includes("approve_once"));
});

test("buildPrivilegeControls for job_mutation returns approve and deny with no persistent approval", () => {
  const controls = buildPrivilegeControls({
    kind: "job_mutation",
    requestId: "req-2",
    mutation: {
      operation: "update",
      jobId: "daily-cleanup",
      definition: {
        id: "daily-cleanup",
        name: "Daily cleanup",
        enabled: true,
        schedule: { kind: "cron", expression: "0 9 * * *" },
        skillId: "cleanup-skill",
      },
    },
  });

  const allActionIds = controls.rows.flat().map((action) => action.actionId);
  assert.ok(allActionIds.includes("approve"));
  assert.ok(allActionIds.includes("deny"));
  assert.ok(!allActionIds.includes("approve_always"));
  assert.ok(!allActionIds.includes("approve_worker_session"));
  assert.ok(!allActionIds.includes("approve_once"));
});

test("formatPrivilegeRequestLogType formats each request kind", () => {
  assert.equal(
    formatPrivilegeRequestLogType({ kind: "file_copy", requestId: "r1", payload: { type: "copy_into_share", sourcePath: "/tmp", targetPath: "/share", reason: "test" } }),
    "copy_into_share",
  );
  assert.equal(
    formatPrivilegeRequestLogType({ kind: "mcp_tool_call", requestId: "r1", serverId: "fs", toolName: "read", arguments: {} }),
    "fs.read",
  );
  assert.equal(
    formatPrivilegeRequestLogType({ kind: "mcp_resource_read", requestId: "r1", serverId: "fs", uri: "file:///tmp" }),
    "resource:fs:file:///tmp",
  );
  assert.equal(
    formatPrivilegeRequestLogType({ kind: "http_token_use", requestId: "r1", tokenId: "api", host: "example.com", reason: "test" }),
    "http:api@example.com",
  );
  assert.equal(
    formatPrivilegeRequestLogType({ kind: "host_directory_access", requestId: "r1", path: "/tmp", level: "read_write" }),
    "host_directory_access:/tmp:read_write",
  );
  assert.equal(
    formatPrivilegeRequestLogType({ kind: "skill_mutation", requestId: "r1", operation: "create", skillId: "my-skill" }),
    "skill_mutation:create:my-skill",
  );
  assert.equal(
    formatPrivilegeRequestLogType({ kind: "job_mutation", requestId: "r1", mutation: { operation: "run_now", jobId: "daily-cleanup" } }),
    "job_mutation:run_now:daily-cleanup",
  );
});
