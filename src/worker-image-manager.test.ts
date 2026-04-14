import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveSandyCacheRoot, resolveWorkerImageCacheStatePath } from "./cache-paths.js";
import {
  buildWorkerImageSpecHash,
  buildWorkerLaunchImageTag,
  type WorkerImageCacheMetadata,
  WorkerImageManager,
} from "./worker-image-manager.js";

type FakeTimer = {
  cleared: boolean;
  delayMs: number;
  fn: () => void;
};

function createTimerHarness() {
  const timers: FakeTimer[] = [];

  return {
    timers,
    setTimeoutImpl: ((fn: () => void, delay?: number) => {
      const timer: FakeTimer = {
        cleared: false,
        delayMs: typeof delay === "number" ? delay : 0,
        fn,
      };
      timers.push(timer);
      return timer as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    clearTimeoutImpl: ((timer: NodeJS.Timeout) => {
      (timer as unknown as FakeTimer).cleared = true;
    }) as typeof clearTimeout,
  };
}

test("resolveSandyCacheRoot and worker image state path stay under Sandy's cache tree", () => {
  const cacheRoot = resolveSandyCacheRoot({
    HOME: "/home/tester",
  }, "linux");

  assert.equal(cacheRoot, "/home/tester/.local/share/sandy");
  assert.equal(
    resolveWorkerImageCacheStatePath(cacheRoot),
    "/home/tester/.local/share/sandy/worker-image/state.json",
  );
});

test("WorkerImageManager returns the base image directly when no preinstall commands are configured", async () => {
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const manager = new WorkerImageManager({
    baseImage: "sandy-subagent:latest",
    preinstall: {
      commands: [],
      refresh: "weekly",
    },
    runCommand: async (command, args, env) => {
      calls.push({ command, args, env });
      return { stdout: "", stderr: "" };
    },
  });

  try {
    assert.equal(await manager.start(), "sandy-subagent:latest");
    assert.equal(manager.getLaunchImage(), "sandy-subagent:latest");
    assert.deepEqual(calls, []);
  } finally {
    await manager.stop();
  }
});

test("WorkerImageManager builds and persists a derived overlay image on first startup", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sandy-worker-image-cache-"));
  const baseImage = "ghcr.io/example/sandy-subagent:sha-abc";
  const baseImageBuildRef = "ghcr.io/example/sandy-subagent@sha256:published-base-1";
  const commands = ["zypper --non-interactive install jq", "brew install gh"];
  const specHash = buildWorkerImageSpecHash(commands);
  const expectedLaunchImage = buildWorkerLaunchImageTag("sha256:base-1", specHash);
  const dockerfiles: string[] = [];
  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];

  const manager = new WorkerImageManager({
    baseImage,
    cacheRoot,
    preinstall: {
      commands,
      refresh: "weekly",
    },
    now: () => 1_700_000_000_000,
    runCommand: async (command, args, env) => {
      calls.push({ command, args, env });
      if (command !== "docker") {
        throw new Error(`Unexpected command ${command}`);
      }
      if (args[0] === "pull") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "image" && args[1] === "inspect" && args.at(-1) === baseImage) {
        return { stdout: `${JSON.stringify([baseImageBuildRef])}\nsha256:base-1\n`, stderr: "" };
      }
      if (args[0] === "build") {
        const contextPath = args.at(-1);
        assert.ok(contextPath);
        dockerfiles.push(await readFile(join(contextPath, "Dockerfile"), "utf8"));
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected docker invocation: ${args.join(" ")}`);
    },
  });

  try {
    assert.equal(await manager.start(), expectedLaunchImage);
    assert.equal(manager.getLaunchImage(), expectedLaunchImage);

    const metadata = JSON.parse(await readFile(resolveWorkerImageCacheStatePath(cacheRoot), "utf8")) as WorkerImageCacheMetadata;
    assert.deepEqual(metadata, {
      launchImage: expectedLaunchImage,
      baseImageRef: baseImage,
      baseImageId: "sha256:base-1",
      specHash,
      lastSuccessfulRefreshAt: 1_700_000_000_000,
    });
    assert.equal(dockerfiles[0], [
      `FROM ${baseImageBuildRef}`,
      "RUN zypper --non-interactive install jq",
      "RUN brew install gh",
      "",
    ].join("\n"));
    assert.ok(calls.some((call) =>
      call.args[0] === "build"
      && call.args.includes(expectedLaunchImage)
      && call.env === undefined,
    ));
  } finally {
    await manager.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("WorkerImageManager reuses a fresh cached overlay and keeps the persisted weekly schedule across restart", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sandy-worker-image-cache-"));
  const timers = createTimerHarness();
  const now = 2_000_000_000_000;
  const baseImage = "ghcr.io/example/sandy-subagent:sha-abc";
  const commands = ["zypper --non-interactive install jq"];
  const specHash = buildWorkerImageSpecHash(commands);
  const launchImage = buildWorkerLaunchImageTag("sha256:base-1", specHash);
  await mkdir(dirname(resolveWorkerImageCacheStatePath(cacheRoot)), { recursive: true });

  await writeFile(resolveWorkerImageCacheStatePath(cacheRoot), `${JSON.stringify({
    launchImage,
    baseImageRef: baseImage,
    baseImageId: "sha256:base-1",
    specHash,
    lastSuccessfulRefreshAt: now - (6 * 24 * 60 * 60 * 1000),
  } satisfies WorkerImageCacheMetadata)}\n`);

  const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const manager = new WorkerImageManager({
    baseImage,
    cacheRoot,
    preinstall: {
      commands,
      refresh: "weekly",
    },
    now: () => now,
    runCommand: async (command, args, env) => {
      calls.push({ command, args, env });
      if (command !== "docker") {
        throw new Error(`Unexpected command ${command}`);
      }
      if (args[0] === "pull") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        const targetImage = args.at(-1);
        if (targetImage === baseImage || targetImage === launchImage) {
          return { stdout: `${JSON.stringify([`${baseImage}@sha256:base-1`])}\nsha256:base-1\n`, stderr: "" };
        }
      }
      throw new Error(`Unexpected docker invocation: ${args.join(" ")}`);
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  try {
    assert.equal(await manager.start(), launchImage);
    assert.equal(manager.getLaunchImage(), launchImage);
    assert.equal(calls.filter((call) => call.args[0] === "build").length, 0);
    assert.equal(timers.timers.length, 1);
    assert.equal(timers.timers[0]?.delayMs, 24 * 60 * 60 * 1000);
  } finally {
    await manager.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("WorkerImageManager rebuilds immediately when the cached overlay is overdue", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sandy-worker-image-cache-"));
  const now = 2_000_000_000_000;
  const baseImage = "ghcr.io/example/sandy-subagent:sha-abc";
  const commands = ["zypper --non-interactive install jq"];
  const specHash = buildWorkerImageSpecHash(commands);
  const launchImage = buildWorkerLaunchImageTag("sha256:base-1", specHash);
  await mkdir(dirname(resolveWorkerImageCacheStatePath(cacheRoot)), { recursive: true });

  await writeFile(resolveWorkerImageCacheStatePath(cacheRoot), `${JSON.stringify({
    launchImage,
    baseImageRef: baseImage,
    baseImageId: "sha256:base-1",
    specHash,
    lastSuccessfulRefreshAt: now - (8 * 24 * 60 * 60 * 1000),
  } satisfies WorkerImageCacheMetadata)}\n`);

  let buildCount = 0;
  const manager = new WorkerImageManager({
    baseImage,
    cacheRoot,
    preinstall: {
      commands,
      refresh: "weekly",
    },
    now: () => now,
    runCommand: async (_command, args) => {
      if (args[0] === "pull") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: `${JSON.stringify([`${baseImage}@sha256:base-1`])}\nsha256:base-1\n`, stderr: "" };
      }
      if (args[0] === "build") {
        buildCount += 1;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected docker invocation: ${args.join(" ")}`);
    },
  });

  try {
    assert.equal(await manager.start(), launchImage);
    assert.equal(buildCount, 1);
    const metadata = JSON.parse(await readFile(resolveWorkerImageCacheStatePath(cacheRoot), "utf8")) as WorkerImageCacheMetadata;
    assert.equal(metadata.lastSuccessfulRefreshAt, now);
  } finally {
    await manager.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("WorkerImageManager fails startup when no overlay exists and the first build fails", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sandy-worker-image-cache-"));
  const manager = new WorkerImageManager({
    baseImage: "ghcr.io/example/sandy-subagent:sha-abc",
    cacheRoot,
    preinstall: {
      commands: ["zypper --non-interactive install jq"],
      refresh: "weekly",
    },
    runCommand: async (_command, args) => {
      if (args[0] === "pull") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: `${JSON.stringify(["ghcr.io/example/sandy-subagent@sha256:base-1"])}\nsha256:base-1\n`, stderr: "" };
      }
      if (args[0] === "build") {
        throw new Error("docker build failed");
      }
      throw new Error(`Unexpected docker invocation: ${args.join(" ")}`);
    },
  });

  try {
    await assert.rejects(manager.start(), /docker build failed/);
  } finally {
    await manager.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("WorkerImageManager falls back to an existing local base image when docker pull fails", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sandy-worker-image-cache-"));
  const baseImage = "sandy-subagent:latest";
  const baseImageBuildRef = "sandy-subagent@sha256:local-base";
  const commands = ["zypper --non-interactive install jq"];
  const specHash = buildWorkerImageSpecHash(commands);
  const launchImage = buildWorkerLaunchImageTag("sha256:local-base", specHash);

  const dockerfiles: string[] = [];
  const manager = new WorkerImageManager({
    baseImage,
    cacheRoot,
    preinstall: {
      commands,
      refresh: "weekly",
    },
    now: () => 2_000_000_000_000,
    runCommand: async (_command, args) => {
      if (args[0] === "pull") {
        throw new Error("pull access denied");
      }
      if (args[0] === "image" && args[1] === "inspect") {
        const targetImage = args.at(-1);
        if (targetImage === baseImage) {
          return { stdout: `${JSON.stringify([baseImageBuildRef])}\nsha256:local-base\n`, stderr: "" };
        }
      }
      if (args[0] === "build") {
        const contextPath = args.at(-1);
        assert.ok(contextPath);
        dockerfiles.push(await readFile(join(contextPath, "Dockerfile"), "utf8"));
        return { stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected docker invocation: ${args.join(" ")}`);
    },
  });

  try {
    assert.equal(await manager.start(), launchImage);
    assert.equal(manager.getLaunchImage(), launchImage);
    assert.equal(dockerfiles[0], [
      `FROM ${baseImageBuildRef}`,
      "RUN zypper --non-interactive install jq",
      "",
    ].join("\n"));
  } finally {
    await manager.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test("WorkerImageManager keeps using the last good overlay when a scheduled rebuild fails", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "sandy-worker-image-cache-"));
  const timers = createTimerHarness();
  const now = 2_000_000_000_000;
  const baseImage = "ghcr.io/example/sandy-subagent:sha-abc";
  const commands = ["zypper --non-interactive install jq"];
  const specHash = buildWorkerImageSpecHash(commands);
  const launchImage = buildWorkerLaunchImageTag("sha256:base-1", specHash);
  await mkdir(dirname(resolveWorkerImageCacheStatePath(cacheRoot)), { recursive: true });

  await writeFile(resolveWorkerImageCacheStatePath(cacheRoot), `${JSON.stringify({
    launchImage,
    baseImageRef: baseImage,
    baseImageId: "sha256:base-1",
    specHash,
    lastSuccessfulRefreshAt: now - (8 * 24 * 60 * 60 * 1000),
  } satisfies WorkerImageCacheMetadata)}\n`);

  const manager = new WorkerImageManager({
    baseImage,
    cacheRoot,
    preinstall: {
      commands,
      refresh: "weekly",
    },
    now: () => now,
    runCommand: async (_command, args) => {
      if (args[0] === "pull") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        return { stdout: "sha256:base-1\n", stderr: "" };
      }
      if (args[0] === "build") {
        throw new Error("docker build failed");
      }
      throw new Error(`Unexpected docker invocation: ${args.join(" ")}`);
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });

  try {
    assert.equal(await manager.start(), launchImage);
    assert.equal(manager.getLaunchImage(), launchImage);
    assert.equal(timers.timers[0]?.delayMs, 60 * 60 * 1000);
  } finally {
    await manager.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});
