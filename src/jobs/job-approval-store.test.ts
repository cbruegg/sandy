import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobApprovalStore } from "./job-approval-store.js";
import { jobApprovalsFile } from "../state-paths.js";

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

test("JobApprovalStore reads legacy approval files as task policy", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "sandy-job-approval-store-"));
  const filePath = jobApprovalsFile(configDirectory);
  mkdirSync(join(configDirectory, "state", "jobs"), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({
    approvals: [{
      jobId: "job-a",
      mcpTools: [{ serverId: "todoist", toolName: "list_projects" }],
      mcpResources: [{ serverId: "todoist", uri: "todoist://projects" }],
      httpTokens: [{ tokenId: "news-api", host: "api.example.com" }],
      hostDirectories: [{ path: "/tmp/reports", level: "read_only" }],
    }],
  }, null, 2)}\n`, "utf8");

  const store = new JobApprovalStore(configDirectory);

  assert.deepEqual(await store.getTaskPolicy("job-a"), {
    autoApproveMcpServers: ["todoist"],
    autoApproveHttpTokens: ["news-api"],
  });
});
