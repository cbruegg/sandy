import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobApprovalStore } from "./job-approval-store.js";

test("JobApprovalStore persists task policy per job only", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "sandy-job-approval-store-"));
  const store = new JobApprovalStore(configDirectory);

  await store.saveTaskPolicy("job-a", {
    autoApproveMcpServers: ["todoist", "todoist"],
    autoApproveHttpTokens: ["news-api"],
  });

  assert.deepEqual(await store.getTaskPolicy("job-a"), {
    autoApproveMcpServers: ["todoist"],
    autoApproveHttpTokens: ["news-api"],
  });
  assert.deepEqual(await store.getTaskPolicy("job-b"), {
    autoApproveMcpServers: [],
    autoApproveHttpTokens: [],
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
