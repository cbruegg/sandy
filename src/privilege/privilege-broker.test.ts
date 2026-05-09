import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrivilegeBrokerImpl } from "./privilege-broker.js";
import { sharedWorkspaceMountPath } from "../shared-workspace.js";

test("PrivilegeBrokerImpl copies a host file into the task share", async () => {
  const broker = new PrivilegeBrokerImpl();
  const root = await mkdtemp(join(tmpdir(), "sandy-privilege-broker-"));
  const taskSharePath = join(root, "share");
  const sourcePath = join(root, "host-input.txt");
  await mkdir(taskSharePath, { recursive: true });
  await writeFile(sourcePath, "hello from host");

  const result = await broker.apply(
    {
      type: "copy_into_share",
      reason: "Need fixture input.",
      sourcePath,
      targetPath: `${sharedWorkspaceMountPath}/copied/input.txt`,
    },
    {
      taskId: "task-1",
      taskSharePath,
    },
  );

  assert.deepEqual(result, {
    outcome: "approved",
    message: `Copied ${sourcePath} into the shared workspace at ${sharedWorkspaceMountPath}/copied/input.txt.`,
  });
  assert.equal(
    await readFile(join(taskSharePath, "copied", "input.txt"), "utf8"),
    "hello from host",
  );
});

test("PrivilegeBrokerImpl copies a shared file out to the host", async () => {
  const broker = new PrivilegeBrokerImpl();
  const root = await mkdtemp(join(tmpdir(), "sandy-privilege-broker-"));
  const taskSharePath = join(root, "share");
  const targetPath = join(root, "exports", "result.txt");
  await mkdir(join(taskSharePath, "nested"), { recursive: true });
  await writeFile(join(taskSharePath, "nested", "result.txt"), "hello from share");

  const result = await broker.apply(
    {
      type: "copy_out_of_share",
      reason: "Export result.",
      sourcePath: `${sharedWorkspaceMountPath}/nested/result.txt`,
      targetPath,
    },
    {
      taskId: "task-2",
      taskSharePath,
    },
  );

  assert.deepEqual(result, {
    outcome: "approved",
    message: `Copied ${sharedWorkspaceMountPath}/nested/result.txt out of the shared workspace to ${targetPath}.`,
  });
  assert.equal(await readFile(targetPath, "utf8"), "hello from share");
});

test("PrivilegeBrokerImpl rejects share path traversal", async () => {
  const broker = new PrivilegeBrokerImpl();
  const root = await mkdtemp(join(tmpdir(), "sandy-privilege-broker-"));
  const taskSharePath = join(root, "share");
  const sourcePath = join(root, "host-input.txt");
  await mkdir(taskSharePath, { recursive: true });
  await writeFile(sourcePath, "hello from host");

  const result = await broker.apply(
    {
      type: "copy_into_share",
      reason: "Try to escape the share.",
      sourcePath,
      targetPath: "/workspace/other/input.txt",
    },
    {
      taskId: "task-4",
      taskSharePath,
    },
  );

  assert.deepEqual(result, {
    outcome: "failed",
    message: `copy_into_share targetPath must stay within ${sharedWorkspaceMountPath}.`,
  });
});

test("PrivilegeBrokerImpl expands ~/ for host paths", async () => {
  const broker = new PrivilegeBrokerImpl();
  const root = await mkdtemp(join(tmpdir(), "sandy-privilege-broker-"));
  const fakeHome = await mkdtemp(join(root, "home-"));
  const taskSharePath = join(root, "share");
  const exportDir = await mkdtemp(join(fakeHome, "sandy-privilege-export-"));
  const targetPath = join(exportDir, "result.txt");
  const originalHome = process.env["HOME"];
  await mkdir(taskSharePath, { recursive: true });
  await writeFile(join(taskSharePath, "result.txt"), "hello from share");

  try {
    process.env["HOME"] = fakeHome;

    const result = await broker.apply(
      {
        type: "copy_out_of_share",
        reason: "Export result.",
        sourcePath: `${sharedWorkspaceMountPath}/result.txt`,
        targetPath: `~/${targetPath.slice(fakeHome.length + 1)}`,
      },
      {
        taskId: "task-5",
        taskSharePath,
      },
    );

    assert.deepEqual(result, {
      outcome: "approved",
      message: `Copied ${sharedWorkspaceMountPath}/result.txt out of the shared workspace to ${targetPath}.`,
    });
    assert.equal(await readFile(targetPath, "utf8"), "hello from share");
  } finally {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    await rm(exportDir, { recursive: true, force: true });
  }
});
