import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { JobApprovalStore } from "./job-approval-store.js";
import { jobApprovalsFile } from "../state-paths.js";

test("JobApprovalStore persists task policy per job only", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "sandy-job-approval-store-"));
  const store = new JobApprovalStore(configDirectory);

  await store.saveAutoApprovalEligibility("job-a", {
    eligibleMcpServers: ["todoist", "todoist"],
    eligibleHttpTokens: ["news-api"],
  });

  assert.deepEqual(await store.getAutoApprovalEligibility("job-a"), {
    eligibleMcpServers: ["todoist"],
    eligibleHttpTokens: ["news-api"],
  });
  assert.deepEqual(await store.getAutoApprovalEligibility("job-b"), {
    eligibleMcpServers: [],
    eligibleHttpTokens: [],
  });
});

test("JobApprovalStore persists MCP tool and resource approvals per operation", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "sandy-job-approval-store-"));
  const store = new JobApprovalStore(configDirectory);

  await store.allowMcpTool("job-a", "todoist", "list_projects");
  await store.allowMcpResourceRead("job-a", "todoist", "todoist://projects");

  assert.deepEqual(await store.getMcpApprovals("job-a"), {
    approvedMcpTools: [{ serverId: "todoist", toolName: "list_projects" }],
    approvedMcpResourceReads: [{ serverId: "todoist", uri: "todoist://projects" }],
  });
  assert.deepEqual(await store.getMcpApprovals("job-b"), {
    approvedMcpTools: [],
    approvedMcpResourceReads: [],
  });
});

test("JobApprovalStore migrates legacy taskPolicy state", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "sandy-job-approval-store-"));
  mkdirSync(dirname(jobApprovalsFile(configDirectory)), { recursive: true });
  await writeFile(jobApprovalsFile(configDirectory), JSON.stringify({
    approvals: [{
      jobId: "job-a",
      taskPolicy: { autoApproveMcpServers: ["todoist"], autoApproveHttpTokens: ["news-api"] },
    }],
  }), "utf8");
  const store = new JobApprovalStore(configDirectory);

  assert.deepEqual(await store.getAutoApprovalEligibility("job-a"), {
    eligibleMcpServers: ["todoist"],
    eligibleHttpTokens: ["news-api"],
  });
  const saved = readFileSync(jobApprovalsFile(configDirectory), "utf8");
  assert.match(saved, /"autoApprovalEligibility"/);
  assert.doesNotMatch(saved, /"taskPolicy"/);
});
