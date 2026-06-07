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
