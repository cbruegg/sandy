import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "./logger.js";
import { resolveSandyCacheRoot, resolveWorkerImageCacheStatePath } from "./cache-paths.js";

const OVERLAY_FORMAT_VERSION = 4;
const WEEKLY_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_REFRESH_RETRY_MS = 60 * 60 * 1000;

type WorkerPreinstallRefreshMode = "weekly" | "manual";

type WorkerPreinstallConfig = {
  commands: string[];
  refresh: WorkerPreinstallRefreshMode;
};

export type WorkerImageCacheMetadata = {
  launchImage: string;
  baseImageRef: string;
  baseImageId: string;
  specHash: string;
  lastSuccessfulRefreshAt: number;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

type InspectedBaseImage = {
  buildRef: string;
  imageId: string;
};

type RunCommand = (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<CommandResult>;

type WorkerImageManagerOptions = {
  baseImage: string;
  preinstall: WorkerPreinstallConfig;
  cacheRoot?: string;
  now?: () => number;
  runCommand?: RunCommand;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

function normalizeWorkerPreinstallCommands(commands: string[]): string[] {
  return commands.map((command) => command.trim());
}

export function buildWorkerImageSpecHash(commands: string[]): string {
  return sha256Hex(JSON.stringify({
    commands,
    formatVersion: OVERLAY_FORMAT_VERSION,
  }));
}

export function buildWorkerLaunchImageTag(baseImageId: string, specHash: string): string {
  const tagHash = sha256Hex(JSON.stringify({
    baseImageId,
    specHash,
  })).slice(0, 24);
  return `sandy-worker-overlay:${tagHash}`;
}

export class WorkerImageManager {
  private readonly cacheStatePath: string;
  private readonly now: () => number;
  private readonly runCommand: RunCommand;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;
  private readonly normalizedCommands: string[];
  private readonly specHash: string;
  private currentImage: string;
  private currentMetadata: WorkerImageCacheMetadata | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshPromise: Promise<string> | null = null;
  private lastFailedRefreshAt: number | null = null;
  private stopped = false;

  constructor(private readonly options: WorkerImageManagerOptions) {
    this.cacheStatePath = resolveWorkerImageCacheStatePath(options.cacheRoot ?? resolveSandyCacheRoot());
    this.now = options.now ?? Date.now;
    this.runCommand = options.runCommand ?? runCommandWithSpawn;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
    this.normalizedCommands = normalizeWorkerPreinstallCommands(options.preinstall.commands);
    this.specHash = buildWorkerImageSpecHash(this.normalizedCommands);
    this.currentImage = options.baseImage;
  }

  async start(): Promise<string> {
    if (!this.hasOverlayConfig()) {
      this.currentImage = this.options.baseImage;
      return this.currentImage;
    }

    try {
      const launchImage = await this.reconcile("startup");
      this.scheduleNextRefresh();
      return launchImage;
    } catch (error) {
      this.scheduleNextRefresh(FAILED_REFRESH_RETRY_MS);
      throw error;
    }
  }

  getLaunchImage(): string {
    return this.currentImage;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRefreshTimer();
    await this.refreshPromise?.catch(() => {});
  }

  private hasOverlayConfig(): boolean {
    return this.normalizedCommands.length > 0;
  }

  private clearRefreshTimer(): void {
    if (!this.refreshTimer) {
      return;
    }
    this.clearTimeoutImpl(this.refreshTimer);
    this.refreshTimer = null;
  }

  private scheduleNextRefresh(delayOverrideMs?: number): void {
    this.clearRefreshTimer();

    if (this.stopped || !this.hasOverlayConfig() || this.options.preinstall.refresh !== "weekly" || !this.currentMetadata) {
      return;
    }

    const nextDueAt = this.currentMetadata.lastSuccessfulRefreshAt + WEEKLY_REFRESH_INTERVAL_MS;
    const now = this.now();
    const failedRefreshDelayMs = this.lastFailedRefreshAt === null
      ? 0
      : Math.max(0, FAILED_REFRESH_RETRY_MS - (now - this.lastFailedRefreshAt));
    const delayMs = delayOverrideMs ?? Math.max(
      Math.max(0, nextDueAt - now),
      failedRefreshDelayMs,
    );
    this.refreshTimer = this.setTimeoutImpl(() => {
      this.refreshTimer = null;
      void this.reconcile("scheduled")
        .then(() => {
          this.scheduleNextRefresh();
        })
        .catch((error) => {
          logger.warn("worker_image.refresh_retry_scheduled", {
            baseImage: this.options.baseImage,
            message: error instanceof Error ? error.message : "Unknown worker image refresh failure.",
            retryDelayMs: FAILED_REFRESH_RETRY_MS,
          });
          this.scheduleNextRefresh(FAILED_REFRESH_RETRY_MS);
        });
    }, delayMs);
  }

  private async reconcile(trigger: "startup" | "scheduled"): Promise<string> {
    if (!this.hasOverlayConfig()) {
      this.currentImage = this.options.baseImage;
      return this.currentImage;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.reconcileInternal(trigger)
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  private async reconcileInternal(trigger: "startup" | "scheduled"): Promise<string> {
    const cachedMetadata = await this.readMetadata();
    if (cachedMetadata && await this.imageExists(cachedMetadata.launchImage)) {
      this.currentMetadata = cachedMetadata;
      this.currentImage = cachedMetadata.launchImage;
    }

    logger.info("worker_image.reconcile_started", {
      trigger,
      baseImage: this.options.baseImage,
      hasCachedOverlay: this.currentMetadata !== null,
      refreshMode: this.options.preinstall.refresh,
    });

    try {
      await this.ensureBaseImageAvailable();
      const baseImage = await this.inspectBaseImage(this.options.baseImage);
      const baseImageId = baseImage.imageId;

      if (this.currentMetadata
        && this.currentMetadata.baseImageRef === this.options.baseImage
        && this.currentMetadata.baseImageId === baseImageId
        && this.currentMetadata.specHash === this.specHash
        && !this.isRefreshDue(this.currentMetadata.lastSuccessfulRefreshAt)) {
        logger.info("worker_image.cache_hit", {
          baseImage: this.options.baseImage,
          launchImage: this.currentMetadata.launchImage,
        });
        this.lastFailedRefreshAt = null;
        return this.currentMetadata.launchImage;
      }

      const launchImage = buildWorkerLaunchImageTag(baseImageId, this.specHash);
      const canReuseBuiltImage = this.currentMetadata !== null
        && this.currentMetadata.launchImage === launchImage
        && this.currentMetadata.baseImageRef === this.options.baseImage
        && this.currentMetadata.baseImageId === baseImageId
        && this.currentMetadata.specHash === this.specHash
        && await this.imageExists(launchImage)
        && !this.isRefreshDue(this.currentMetadata.lastSuccessfulRefreshAt);

      if (canReuseBuiltImage) {
        this.currentImage = launchImage;
        logger.info("worker_image.cache_hit", {
          baseImage: this.options.baseImage,
          launchImage,
        });
        return launchImage;
      }

      await this.buildOverlayImage(launchImage, baseImage);
      const metadata: WorkerImageCacheMetadata = {
        launchImage,
        baseImageRef: this.options.baseImage,
        baseImageId,
        specHash: this.specHash,
        lastSuccessfulRefreshAt: this.now(),
      };
      await this.writeMetadata(metadata);
      this.currentMetadata = metadata;
      this.currentImage = launchImage;
      this.lastFailedRefreshAt = null;
      logger.info("worker_image.build_ready", {
        baseImage: this.options.baseImage,
        launchImage,
      });
      return launchImage;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown worker image reconciliation failure.";
      logger.warn("worker_image.reconcile_failed", {
        trigger,
        baseImage: this.options.baseImage,
        message: detail,
        usingCachedOverlay: this.currentMetadata !== null,
      });
      this.lastFailedRefreshAt = this.now();
      if (this.currentMetadata && await this.imageExists(this.currentMetadata.launchImage)) {
        this.currentImage = this.currentMetadata.launchImage;
        return this.currentImage;
      }
      throw error;
    }
  }

  private isRefreshDue(lastSuccessfulRefreshAt: number): boolean {
    if (this.options.preinstall.refresh !== "weekly") {
      return false;
    }
    return this.now() >= lastSuccessfulRefreshAt + WEEKLY_REFRESH_INTERVAL_MS;
  }

  private async readMetadata(): Promise<WorkerImageCacheMetadata | null> {
    let raw: string;
    try {
      raw = await readFile(this.cacheStatePath, "utf8");
    } catch {
      return null;
    }

    try {
      return parseWorkerImageCacheMetadata(JSON.parse(raw));
    } catch (error) {
      logger.warn("worker_image.cache_state_invalid", {
        cacheStatePath: this.cacheStatePath,
        message: error instanceof Error ? error.message : "Unknown worker image cache parse failure.",
      });
      return null;
    }
  }

  private async writeMetadata(metadata: WorkerImageCacheMetadata): Promise<void> {
    await mkdir(dirname(this.cacheStatePath), { recursive: true });
    const tempPath = join(
      dirname(this.cacheStatePath),
      `.tmp-${process.pid}-${Date.now()}-worker-image-state.json`,
    );
    await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await rename(tempPath, this.cacheStatePath);
  }

  private async inspectBaseImage(imageRef: string): Promise<InspectedBaseImage> {
    const result = await this.runDocker([
      "image",
      "inspect",
      "--format={{json .RepoDigests}}\n{{.Id}}",
      imageRef,
    ]);
    const [rawRepoDigests = "", rawImageId = ""] = result.stdout.split("\n", 2);
    const imageId = rawImageId.trim();
    if (!imageId) {
      throw new Error(`Docker image inspect returned no ID for ${imageRef}.`);
    }

    const repoDigests = parseRepoDigests(rawRepoDigests);
    return {
      buildRef: repoDigests[0] ?? imageRef,
      imageId,
    };
  }

  private async imageExists(imageRef: string): Promise<boolean> {
    try {
      await this.runDocker(["image", "inspect", "--format={{.Id}}", imageRef]);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureBaseImageAvailable(): Promise<void> {
    try {
      await this.runDocker(["pull", this.options.baseImage]);
      return;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown docker pull failure.";
      if (await this.imageExists(this.options.baseImage)) {
        logger.info("worker_image.using_local_base_image", {
          baseImage: this.options.baseImage,
          message: detail,
        });
        return;
      }
      throw error;
    }
  }

  private async buildOverlayImage(launchImage: string, baseImage: InspectedBaseImage): Promise<void> {
    const stagingDirectory = await mkdtemp(join(tmpdir(), "sandy-worker-image-"));
    const dockerfilePath = join(stagingDirectory, "Dockerfile");
    const dockerfile = [
      `FROM ${baseImage.buildRef}`,
      ...this.normalizedCommands.map((command) => `RUN ${command}`),
      "",
    ].join("\n");

    logger.info("worker_image.build_started", {
      baseImage: this.options.baseImage,
      baseImageBuildRef: baseImage.buildRef,
      baseImageId: baseImage.imageId,
      launchImage,
      commandCount: this.normalizedCommands.length,
    });

    try {
      await writeFile(dockerfilePath, dockerfile, "utf8");
      await this.runDocker([
        "build",
        "--tag",
        launchImage,
        stagingDirectory,
      ]);
    } finally {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async runDocker(args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> {
    return this.runCommand("docker", args, env);
  }
}

function parseWorkerImageCacheMetadata(value: unknown): WorkerImageCacheMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("Worker image cache state is not an object.");
  }

  const record = value as Record<string, unknown>;
  const launchImage = typeof record["launchImage"] === "string" ? record["launchImage"].trim() : "";
  const baseImageRef = typeof record["baseImageRef"] === "string" ? record["baseImageRef"].trim() : "";
  const baseImageId = typeof record["baseImageId"] === "string" ? record["baseImageId"].trim() : "";
  const specHash = typeof record["specHash"] === "string" ? record["specHash"].trim() : "";
  const lastSuccessfulRefreshAt = record["lastSuccessfulRefreshAt"];

  if (!launchImage || !baseImageRef || !baseImageId || !specHash || typeof lastSuccessfulRefreshAt !== "number") {
    throw new Error("Worker image cache state is missing required fields.");
  }

  return {
    launchImage,
    baseImageRef,
    baseImageId,
    specHash,
    lastSuccessfulRefreshAt,
  };
}

function parseRepoDigests(rawRepoDigests: string): string[] {
  try {
    const parsed = JSON.parse(rawRepoDigests) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  } catch {
    return [];
  }
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function runCommandWithSpawn(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `${command} exited with code ${code}.`;
      reject(new Error(detail));
    });
  });
}
