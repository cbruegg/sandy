import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HostfsBroker } from "../hostfs/hostfs-broker.js";
import type { HostDirectoryAccessLevel } from "../hostfs/path-policy.js";
import type { JobMutationResult, JobService } from "../jobs/job-service.js";
import type { JobDefinition } from "../jobs/job-validation.js";
import type { SandboxTaskBundle } from "../sandbox/sandbox-runner.js";
import { sharedWorkspaceMountPath } from "../shared-workspace.js";
import type { SkillService } from "../skills.js";
import type { SkillArchiveCoordinator } from "../orchestrator/skill-archive-coordinator.js";
import { WorkerToolsHandler } from "./worker-tools-handler.js";

function createWorkerToolsHandler(input?: {
  hostfsBroker?: HostfsBroker;
  jobService?: JobService;
  skillArchiveCoordinator?: SkillArchiveCoordinator;
  getTaskSharePath?: (taskId: string) => string;
  getTaskBundle?: (taskId: string) => SandboxTaskBundle;
}): WorkerToolsHandler {
  const jobService: JobService = input?.jobService ?? {
    listJobs: async () => [],
    getJob: async () => null,
    applyMutation: async (): Promise<JobMutationResult> => ({ message: "", deletedJob: null }),
  };

  return new WorkerToolsHandler({
    jobService,
    skillArchiveCoordinator: input?.skillArchiveCoordinator ?? { offerArchiveForJobSkill: async () => {} } as unknown as SkillArchiveCoordinator,
    skillService: {} as SkillService,
    hostfsBroker: input?.hostfsBroker ?? {
      registerBundle: () => {},
      revokeBundle: () => {},
      getBundleNamespace: () => null,
      requestDirectoryAccess: async () => ({ ok: false, error: "unexpected test call" }),
    } as unknown as HostfsBroker,
    getTaskSharePath: input?.getTaskSharePath ?? ((taskId) => `/share/${taskId}`),
    getTaskBundle: input?.getTaskBundle ?? (() => ({ bundleId: "bundle-1", hostfsVolumeName: "hostfs-volume-1" })),
    runUserVisibleOperation: async () => {},
    markTaskFinished: async () => {},
  });
}

test("applyJobMutation offers to archive a deleted job skill", async () => {
  const deletedJob: JobDefinition = {
    id: "job-1",
    name: "Daily cleanup",
    enabled: true,
    schedule: { kind: "one_shot", runAt: "2026-04-01T00:00:00.000Z" },
    skillId: "cleanup-skill",
  };
  const archiveOffers: Array<{ chatId: string; skillId: string; excludeJobId?: string }> = [];
  const handler = createWorkerToolsHandler({
    jobService: {
      listJobs: async () => [],
      getJob: async () => null,
      applyMutation: async () => ({ message: "Deleted job job-1.", deletedJob }),
    },
    skillArchiveCoordinator: {
      offerArchiveForJobSkill: async (chatId: string, skillId: string, excludeJobId?: string) => {
        archiveOffers.push({ chatId, skillId, excludeJobId });
      },
    } as unknown as SkillArchiveCoordinator,
  });

  const message = await handler.applyJobMutation({ operation: "delete", jobId: "job-1" }, { chatId: "chat-1" });

  assert.equal(message, "Deleted job job-1.");
  assert.deepEqual(archiveOffers, [{ chatId: "chat-1", skillId: "cleanup-skill", excludeJobId: "job-1" }]);
});

test("applyFileCopy copies a host file into the task share", async () => {
  const tmpRoot = resolve(import.meta.dirname, "../../tmp");
  await mkdir(tmpRoot, { recursive: true });
  const root = await mkdtemp(join(tmpRoot, "sandy-worker-tools-handler-"));
  const taskSharePath = join(root, "share");
  const sourcePath = join(root, "host-input.txt");
  await mkdir(taskSharePath, { recursive: true });
  await writeFile(sourcePath, "hello from host");
  const handler = createWorkerToolsHandler({
    getTaskSharePath: () => taskSharePath,
  });

  try {
    const result = await handler.applyFileCopy({
      type: "copy_into_share",
      sourcePath,
      targetPath: `${sharedWorkspaceMountPath}/copied/input.txt`,
      reason: "Need fixture input.",
    }, {
      taskId: "task-1",
    });

    assert.deepEqual(result, {
      outcome: "approved",
      message: `Copied ${sourcePath} into the shared workspace at ${sharedWorkspaceMountPath}/copied/input.txt.`,
    });
    assert.equal(await readFile(join(taskSharePath, "copied", "input.txt"), "utf8"), "hello from host");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyFileCopy copies a shared file out to the host", async () => {
  const tmpRoot = resolve(import.meta.dirname, "../../tmp");
  await mkdir(tmpRoot, { recursive: true });
  const root = await mkdtemp(join(tmpRoot, "sandy-worker-tools-handler-"));
  const taskSharePath = join(root, "share");
  const targetPath = join(root, "exports", "result.txt");
  await mkdir(join(taskSharePath, "nested"), { recursive: true });
  await writeFile(join(taskSharePath, "nested", "result.txt"), "hello from share");
  const handler = createWorkerToolsHandler({
    getTaskSharePath: () => taskSharePath,
  });

  try {
    const result = await handler.applyFileCopy({
      type: "copy_out_of_share",
      reason: "Export result.",
      sourcePath: `${sharedWorkspaceMountPath}/nested/result.txt`,
      targetPath,
    }, {
      taskId: "task-2",
    });

    assert.deepEqual(result, {
      outcome: "approved",
      message: `Copied ${sharedWorkspaceMountPath}/nested/result.txt out of the shared workspace to ${targetPath}.`,
    });
    assert.equal(await readFile(targetPath, "utf8"), "hello from share");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyFileCopy rejects share path traversal", async () => {
  const tmpRoot = resolve(import.meta.dirname, "../../tmp");
  await mkdir(tmpRoot, { recursive: true });
  const root = await mkdtemp(join(tmpRoot, "sandy-worker-tools-handler-"));
  const taskSharePath = join(root, "share");
  const sourcePath = join(root, "host-input.txt");
  await mkdir(taskSharePath, { recursive: true });
  await writeFile(sourcePath, "hello from host");
  const handler = createWorkerToolsHandler({
    getTaskSharePath: () => taskSharePath,
  });

  try {
    const result = await handler.applyFileCopy({
      type: "copy_into_share",
      reason: "Try to escape the share.",
      sourcePath,
      targetPath: "/workspace/other/input.txt",
    }, {
      taskId: "task-4",
    });

    assert.deepEqual(result, {
      outcome: "failed",
      message: `copy_into_share targetPath must stay within ${sharedWorkspaceMountPath}.`,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyFileCopy expands ~/ for host paths", async () => {
  const tmpRoot = resolve(import.meta.dirname, "../../tmp");
  await mkdir(tmpRoot, { recursive: true });
  const root = await mkdtemp(join(tmpRoot, "sandy-worker-tools-handler-"));
  const fakeHome = await mkdtemp(join(root, "home-"));
  const taskSharePath = join(root, "share");
  const exportDir = await mkdtemp(join(fakeHome, "sandy-privilege-export-"));
  const targetPath = join(exportDir, "result.txt");
  const originalHome = process.env["HOME"];
  await mkdir(taskSharePath, { recursive: true });
  await writeFile(join(taskSharePath, "result.txt"), "hello from share");
  const handler = createWorkerToolsHandler({
    getTaskSharePath: () => taskSharePath,
  });

  try {
    process.env["HOME"] = fakeHome;

    const result = await handler.applyFileCopy({
      type: "copy_out_of_share",
      reason: "Export result.",
      sourcePath: `${sharedWorkspaceMountPath}/result.txt`,
      targetPath: `~/${targetPath.slice(fakeHome.length + 1)}`,
    }, {
      taskId: "task-5",
    });

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
    await rm(root, { recursive: true, force: true });
  }
});

test("mountHostDirectory delegates through the hostfs broker when the bundle has a hostfs mount", async () => {
  const calls: Array<{ bundleId: string; taskId: string; path: string; level: string }> = [];
  const handler = createWorkerToolsHandler({
    hostfsBroker: {
      registerBundle: () => {},
      revokeBundle: () => {},
      getBundleNamespace: () => null,
      requestDirectoryAccess: async (
        bundleId: string,
        taskId: string,
        path: string,
        level: HostDirectoryAccessLevel,
      ) => {
        calls.push({ bundleId, taskId, path, level });
        return {
          ok: true,
          grantId: "grant-1",
          grantPath: "/workspace/host/grants/grant-1",
        };
      },
    } as unknown as HostfsBroker,
    getTaskBundle: () => ({
      bundleId: "bundle-1",
      hostfsVolumeName: "hostfs-volume-1",
    }),
  });

  const result = await handler.mountHostDirectory({
    taskId: "task-1",
    path: "/tmp",
    level: "read_only",
  });

  assert.deepEqual(calls, [{
    bundleId: "bundle-1",
    taskId: "task-1",
    path: "/tmp",
    level: "read_only",
  }]);
  assert.deepEqual(result, {
    ok: true,
    grantPath: "/workspace/host/grants/grant-1",
  });
});

test("mountHostDirectory fails before calling the broker when the bundle has no hostfs mount", async () => {
  let called = false;
  const handler = createWorkerToolsHandler({
    hostfsBroker: {
      registerBundle: () => {},
      revokeBundle: () => {},
      getBundleNamespace: () => null,
      requestDirectoryAccess: async () => {
        called = true;
        return { ok: false, error: "unexpected test call" };
      },
    } as unknown as HostfsBroker,
    getTaskBundle: () => ({
      bundleId: "bundle-1",
      hostfsVolumeName: null,
    }),
  });

  const result = await handler.mountHostDirectory({
    taskId: "task-1",
    path: "/tmp",
    level: "read_only",
  });

  assert.equal(called, false);
  assert.deepEqual(result, {
    ok: false,
    error: "This task bundle does not have a hostfs mount.",
  });
});

test("mountHostDirectory returns broker errors unchanged", async () => {
  const handler = createWorkerToolsHandler({
    hostfsBroker: {
      registerBundle: () => {},
      revokeBundle: () => {},
      getBundleNamespace: () => null,
      requestDirectoryAccess: async () => ({
        ok: false,
        error: "Bundle namespace not found: bundle-1",
      }),
    } as unknown as HostfsBroker,
  });

  const result = await handler.mountHostDirectory({
    taskId: "task-1",
    path: "/tmp",
    level: "read_only",
  });

  assert.deepEqual(result, {
    ok: false,
    error: "Bundle namespace not found: bundle-1",
  });
});
