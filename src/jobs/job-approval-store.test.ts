import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobApprovalStore } from "./job-approval-store.js";

test("JobApprovalStore persists approvals per job only", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "sandy-job-approval-store-"));
  const store = new JobApprovalStore(configDirectory);

  await store.allowTool("job-a", "todoist", "list_projects");
  await store.allowResourceRead("job-a", "todoist", "todoist://projects");
  await store.allowHttpToken("job-a", "news-api", "api.example.com");
  await store.allowHostDirectory("job-a", "/tmp/reports", "read_only");

  assert.equal(await store.isToolAlwaysAllowed("job-a", "todoist", "list_projects"), true);
  assert.equal(await store.isToolAlwaysAllowed("job-b", "todoist", "list_projects"), false);
  assert.equal(await store.isResourceReadAlwaysAllowed("job-a", "todoist", "todoist://projects"), true);
  assert.equal(await store.isHttpTokenAlwaysAllowed("job-a", "news-api", "api.example.com"), true);
  assert.equal(await store.isHostDirectoryAlwaysAllowed("job-a", "/tmp/reports", "read_only"), true);
  assert.equal(await store.isHostDirectoryAlwaysAllowed("job-a", "/tmp/reports", "read_write"), false);
});

test("JobApprovalStore upgrades host directory approvals", async () => {
  const configDirectory = mkdtempSync(join(tmpdir(), "sandy-job-approval-store-"));
  const store = new JobApprovalStore(configDirectory);

  await store.allowHostDirectory("job-a", "/tmp/reports", "read_only");
  await store.allowHostDirectory("job-a", "/tmp/reports", "read_write");

  assert.equal(await store.isHostDirectoryAlwaysAllowed("job-a", "/tmp/reports", "read_only"), true);
  assert.equal(await store.isHostDirectoryAlwaysAllowed("job-a", "/tmp/reports", "read_write"), true);
});
