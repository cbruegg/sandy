import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ControlActionEvent } from "./control-surface.js";
import { parseTelegramCallbackData, serializeTelegramCallbackData } from "./telegram-callback-data.js";

test("Telegram callback data round-trips semantic control events", () => {
  const cases: Array<{ actionId: string; event: ControlActionEvent; serialized: string }> = [
    {
      actionId: "approve",
      event: { kind: "approval_response", target: "privilege_request", decision: "approve", requestId: "req-1" },
      serialized: "approve:req-1",
    },
    {
      actionId: "approve_once",
      event: { kind: "approval_response", target: "privilege_request", decision: "approve_once", requestId: "req-2" },
      serialized: "approve_once:req-2",
    },
  {
    actionId: "approve_worker_session",
      event: { kind: "approval_response", target: "privilege_request", decision: "approve_worker_session", requestId: "req-3" },
      serialized: "approve_worker_session:req-3",
  },
  {
    actionId: "approve_for_job",
    event: { kind: "approval_response", target: "privilege_request", decision: "approve_for_job", requestId: "req-job" },
    serialized: "approve_for_job:req-job",
  },
    {
      actionId: "approve_always",
      event: { kind: "approval_response", target: "privilege_request", decision: "approve_always", requestId: "req-4" },
      serialized: "approve_always:req-4",
    },
    {
      actionId: "deny",
      event: { kind: "approval_response", target: "privilege_request", decision: "deny", requestId: "req-5" },
      serialized: "deny:req-5",
    },
    {
      actionId: "share_approve",
      event: { kind: "approval_response", target: "share_deletion", decision: "approve", requestId: "req-6" },
      serialized: "share_approve:req-6",
    },
    {
      actionId: "share_deny",
      event: { kind: "approval_response", target: "share_deletion", decision: "deny", requestId: "req-7" },
      serialized: "share_deny:req-7",
    },
    {
      actionId: "report",
      event: { kind: "danger_report" },
      serialized: "report",
    },
    {
      actionId: "cancel",
      event: { kind: "cancel_request" },
      serialized: "cancel",
    },
    {
      actionId: "mark_finished",
      event: { kind: "mark_finished_request" },
      serialized: "mark_finished",
    },
  ];

  for (const entry of cases) {
    assert.equal(serializeTelegramCallbackData(entry.actionId, entry.event), entry.serialized);
    assert.deepEqual(parseTelegramCallbackData(entry.serialized), entry.event);
  }
});

test("Telegram callback data rejects unknown values", () => {
  assert.equal(parseTelegramCallbackData("something_else"), null);
});
