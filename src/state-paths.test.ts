import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { channelStateFile, jobWorkspace, jobWorkspaceRoot, jobsFile, jobsRoot, matrixStateRoot, sandyStateRoot } from "./state-paths.js";

test("state path helpers centralize persisted locations", () => {
  const configDirectory = "/config/sandy";
  assert.equal(sandyStateRoot(configDirectory), join(configDirectory, "state"));
  assert.equal(matrixStateRoot(configDirectory), join(configDirectory, "state", "matrix"));
  assert.equal(jobsRoot(configDirectory), join(configDirectory, "state", "jobs"));
  assert.equal(jobsFile(configDirectory), join(configDirectory, "state", "jobs", "jobs.json"));
  assert.equal(jobWorkspaceRoot(configDirectory), join(configDirectory, "state", "jobs", "workspaces"));
  assert.equal(jobWorkspace(configDirectory, "daily-cleanup"), join(configDirectory, "state", "jobs", "workspaces", "daily-cleanup"));
  assert.equal(channelStateFile(configDirectory), join(configDirectory, "state", "channel.json"));
});

test("job workspace rejects unsafe job ids", () => {
  assert.throws(() => jobWorkspace("/config/sandy", "../bad"), /Job ID/);
});
