import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { buildGitHubHeaders, isGitHubUrl } from "../github-http.js";
import { logger } from "../logger.js";
import { messages } from "../messages.js";
import type { SandyUpdateSource } from "../build-metadata.js";
import type { SandyUpdateMode } from "../config.js";

const UPDATE_CHECK_INTERVAL_MS = 60_000;
const GITHUB_API_VERSION = "2026-03-10";
const DEFAULT_RESTART_PREPARATION_TIMEOUT_MS = 15_000;

type SupportedPlatform = "linux" | "darwin" | "win32";
type SupportedArch = "x64" | "arm64";

type GitHubReleaseAsset = {
  name: string;
  browserDownloadUrl: string;
  sha256: string;
  size: number;
};

type GitHubRelease = {
  gitRevision: string;
  publishedAt: string;
  assets: GitHubReleaseAsset[];
};

type ResolvedExecutableAssets = {
  bundleAssetName: string;
  binaryFileName: string;
  updaterFileName: string;
};

type AvailableUpdate = {
  gitRevision: string;
  bundleAsset: {
    name: string;
    url: string;
    sha256: string;
    size: number;
  };
};

type StagedUpdate = {
  gitRevision: string;
  stageDirectory: string;
  binaryPath: string;
  updaterPath: string;
};

type SelfUpdateCoordinatorOptions = {
  mode: SandyUpdateMode;
  currentExecutablePath: string;
  currentArgs: string[];
  currentWorkingDirectory: string;
  updateSource: SandyUpdateSource | null;
  canInstallUpdate: () => boolean;
  notifyChats: (message: string) => Promise<void>;
  prepareForRestart: () => Promise<void>;
  restartPreparationTimeoutMs?: number;
  exitProcess?: (code: number) => never | void;
};

export class SelfUpdateCoordinator {
  private readonly exitProcess: (code: number) => never | void;
  private readonly targetAssets: ResolvedExecutableAssets | null;
  private readonly restartPreparationTimeoutMs: number;
  private intervalHandle: Timer | null = null;
  private releaseApiEtag: string | null = null;
  private checkInFlight = false;
  private stagedUpdate: StagedUpdate | null = null;
  private restartStarted = false;

  constructor(private readonly options: SelfUpdateCoordinatorOptions) {
    this.exitProcess = options.exitProcess ?? ((code) => process.exit(code));
    this.restartPreparationTimeoutMs = options.restartPreparationTimeoutMs ?? DEFAULT_RESTART_PREPARATION_TIMEOUT_MS;
    this.targetAssets = resolveExecutableAssets(process.platform, process.arch);
  }

  start(): void {
    if (this.options.mode === "disabled") {
      logger.info("update.disabled_in_config");
      return;
    }

    if (!this.options.updateSource) {
      logger.info("update.unavailable", {
        reason: "binary_build_metadata_missing",
      });
      return;
    }

    if (!this.targetAssets) {
      logger.warn("update.unavailable", {
        reason: "unsupported_platform",
        platform: process.platform,
        arch: process.arch,
      });
      return;
    }

    if (this.options.mode === "exit" && process.platform === "win32") {
      logger.warn("update.unavailable", {
        reason: "exit_mode_unsupported_platform",
        detail: "Exit mode replaces the on-disk executable before the running process exits, which is not supported for Windows executables.",
        platform: process.platform,
        arch: process.arch,
      });
      return;
    }

    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, UPDATE_CHECK_INTERVAL_MS);
    this.intervalHandle.unref?.();

    void this.tick();
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async tick(): Promise<void> {
    if (this.checkInFlight || this.restartStarted) {
      return;
    }

    this.checkInFlight = true;
    try {
      if (this.stagedUpdate) {
        if (this.options.canInstallUpdate()) {
          await this.installStagedUpdate(this.stagedUpdate);
        } else {
          logger.debug("update.staged_awaits_clearance", {
            gitRevision: this.stagedUpdate.gitRevision,
            stageDirectory: this.stagedUpdate.stageDirectory,
          });
        }
        return;
      }

      const update = await this.fetchAvailableUpdate();
      if (!update) {
        return;
      }

      this.stagedUpdate = await this.stageUpdate(update);
      logger.info("update.staged", {
        gitRevision: update.gitRevision,
        stageDirectory: this.stagedUpdate.stageDirectory,
      });

      if (this.options.canInstallUpdate()) {
        await this.installStagedUpdate(this.stagedUpdate);
      } else {
        logger.info("update.deferred", {
          gitRevision: update.gitRevision,
          reason: "sessions_active_or_pending_approvals",
        });
      }
    } catch (error) {
      logger.warn("update.check_failed", {
        message: error instanceof Error ? error.message : "Unknown update check failure.",
      });
    } finally {
      this.checkInFlight = false;
    }
  }

  private async fetchAvailableUpdate(): Promise<AvailableUpdate | null> {
    const updateSource = this.options.updateSource;
    const targetAssets = this.targetAssets;
    if (!updateSource || !targetAssets) {
      return null;
    }

    const releaseApiUrl = buildReleaseApiUrl(updateSource.githubRepository, updateSource.releaseTag);
    const response = await fetch(releaseApiUrl, {
      headers: buildGitHubHeaders({
        accept: "application/vnd.github+json",
        "x-github-api-version": GITHUB_API_VERSION,
        ...(this.releaseApiEtag ? {
          "if-none-match": this.releaseApiEtag,
        } : {}),
      }),
    });

    if (response.status === 304) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Update manifest request failed with status ${response.status}.`);
    }

    this.releaseApiEtag = response.headers.get("etag");
    const release = parseGitHubRelease(await response.json());
    if (release.gitRevision === updateSource.gitRevision) {
      return null;
    }

    const bundleAsset = release.assets.find((asset) => asset.name === targetAssets.bundleAssetName);
    if (!bundleAsset) {
      logger.warn("update.assets_missing", {
        gitRevision: release.gitRevision,
        bundleAssetName: targetAssets.bundleAssetName,
      });
      return null;
    }

    return {
      gitRevision: release.gitRevision,
      bundleAsset: {
        name: bundleAsset.name,
        url: bundleAsset.browserDownloadUrl,
        sha256: bundleAsset.sha256,
        size: bundleAsset.size,
      },
    };
  }

  private async stageUpdate(update: AvailableUpdate): Promise<StagedUpdate> {
    const targetAssets = this.targetAssets;
    if (!targetAssets) {
      throw new Error("No target assets configured for update staging.");
    }

    const stageDirectory = await mkdtemp(join(tmpdir(), "sandy-update-"));
    const bundlePath = join(stageDirectory, update.bundleAsset.name);
    const binaryPath = join(stageDirectory, targetAssets.binaryFileName);
    const updaterPath = join(stageDirectory, targetAssets.updaterFileName);

    try {
      await downloadVerifiedAsset(update.bundleAsset.url, bundlePath, update.bundleAsset.sha256, update.bundleAsset.size);
      await extractZipBundle(bundlePath, stageDirectory);
      if (process.platform !== "win32") {
        await chmod(binaryPath, 0o755);
        await chmod(updaterPath, 0o755);
      }

      return {
        gitRevision: update.gitRevision,
        stageDirectory,
        binaryPath,
        updaterPath,
      };
    } catch (error) {
      await rm(stageDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private async installStagedUpdate(stagedUpdate: StagedUpdate): Promise<void> {
    this.restartStarted = true;
    try {
      await this.options.notifyChats(messages.updateInstalling(shortRevision(stagedUpdate.gitRevision)));
      if (this.options.mode === "exit") {
        await this.replaceExecutableThenExit(stagedUpdate);
        return;
      }

      await this.relaunchWithUpdater(stagedUpdate);
    } catch (error) {
      this.restartStarted = false;
      throw error;
    }
  }

  private async replaceExecutableThenExit(stagedUpdate: StagedUpdate): Promise<void> {
    this.stop();
    logger.info("update.restart_preparation_started", {
      mode: this.options.mode,
      gitRevision: stagedUpdate.gitRevision,
    });
    await runUpdaterProcess(
      stagedUpdate.updaterPath,
      buildReplaceOnlyPlan({
        currentExecutablePath: this.options.currentExecutablePath,
        replacementExecutablePath: stagedUpdate.binaryPath,
        stageDirectory: stagedUpdate.stageDirectory,
      }),
    );
    await waitWithSoftTimeout(
      () => this.options.prepareForRestart(),
      this.restartPreparationTimeoutMs,
      () => {
        logger.warn("update.restart_preparation_timed_out", {
          timeoutMs: this.restartPreparationTimeoutMs,
          mode: this.options.mode,
          gitRevision: stagedUpdate.gitRevision,
        });
      },
    );
    logger.info("update.restart_preparation_finished", {
      mode: this.options.mode,
      gitRevision: stagedUpdate.gitRevision,
    });
    this.exitProcess(0);
  }

  private async relaunchWithUpdater(stagedUpdate: StagedUpdate): Promise<void> {
    this.stop();
    logger.info("update.restart_preparation_started", {
      mode: this.options.mode,
      gitRevision: stagedUpdate.gitRevision,
    });
    await waitWithSoftTimeout(
      () => this.options.prepareForRestart(),
      this.restartPreparationTimeoutMs,
      () => {
        logger.warn("update.restart_preparation_timed_out", {
          timeoutMs: this.restartPreparationTimeoutMs,
          mode: this.options.mode,
          gitRevision: stagedUpdate.gitRevision,
        });
      },
    );
    logger.info("update.restart_preparation_finished", {
      mode: this.options.mode,
      gitRevision: stagedUpdate.gitRevision,
    });

    const child = spawn(stagedUpdate.updaterPath, [], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SANDY_UPDATER_PLAN: JSON.stringify(buildRelaunchPlan({
          currentExecutablePath: this.options.currentExecutablePath,
          replacementExecutablePath: stagedUpdate.binaryPath,
          relaunchArgs: this.options.currentArgs,
          currentWorkingDirectory: this.options.currentWorkingDirectory,
          stageDirectory: stagedUpdate.stageDirectory,
        })),
      },
    });
    child.unref();
    this.exitProcess(0);
  }
}

type BaseUpdaterPlan = {
  targetExecutablePath: string;
  replacementExecutablePath: string;
  backupExecutablePath: string;
  stageDirectory: string;
};

type RelaunchUpdaterPlan = BaseUpdaterPlan & {
  mode: "relaunch";
  waitPid: number;
  relaunchArgs: string[];
  currentWorkingDirectory: string;
};

type ReplaceOnlyUpdaterPlan = BaseUpdaterPlan & {
  mode: "replace-only";
};

function buildRelaunchPlan(input: {
  currentExecutablePath: string;
  replacementExecutablePath: string;
  relaunchArgs: string[];
  currentWorkingDirectory: string;
  stageDirectory: string;
}): RelaunchUpdaterPlan {
  return {
    mode: "relaunch",
    waitPid: process.pid,
    targetExecutablePath: input.currentExecutablePath,
    replacementExecutablePath: input.replacementExecutablePath,
    backupExecutablePath: join(dirname(input.currentExecutablePath), backupExecutableName(input.currentExecutablePath)),
    relaunchArgs: input.relaunchArgs,
    currentWorkingDirectory: input.currentWorkingDirectory,
    stageDirectory: input.stageDirectory,
  };
}

function buildReplaceOnlyPlan(input: {
  currentExecutablePath: string;
  replacementExecutablePath: string;
  stageDirectory: string;
}): ReplaceOnlyUpdaterPlan {
  return {
    mode: "replace-only",
    targetExecutablePath: input.currentExecutablePath,
    replacementExecutablePath: input.replacementExecutablePath,
    backupExecutablePath: join(dirname(input.currentExecutablePath), backupExecutableName(input.currentExecutablePath)),
    stageDirectory: input.stageDirectory,
  };
}

export async function waitWithSoftTimeout(
  operation: () => Promise<void>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      onTimeout();
      resolve();
    }, timeoutMs);

    void operation().then(
      () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        resolve();
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function runUpdaterProcess(updaterPath: string, plan: ReplaceOnlyUpdaterPlan): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(updaterPath, [], {
      stdio: "ignore",
      env: {
        ...process.env,
        SANDY_UPDATER_PLAN: JSON.stringify(plan),
      },
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Updater exited with code ${code ?? "null"}.`));
    });
  });
}

async function downloadVerifiedAsset(
  assetUrl: string,
  targetPath: string,
  expectedSha256: string,
  expectedSize: number,
): Promise<void> {
  const response = await fetch(
    assetUrl,
    isGitHubUrl(assetUrl)
      ? { headers: buildGitHubHeaders() }
      : undefined,
  );
  if (!response.ok) {
    throw new Error(`Asset download failed with status ${response.status}.`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.byteLength !== expectedSize) {
    throw new Error(`Downloaded asset size mismatch for ${assetUrl}. Expected ${expectedSize}, received ${buffer.byteLength}.`);
  }

  const hash = createHash("sha256").update(buffer).digest("hex");
  if (hash !== expectedSha256) {
    throw new Error(`Downloaded asset checksum mismatch for ${assetUrl}.`);
  }

  await writeFile(targetPath, buffer);
  const downloadedStats = await stat(targetPath);
  if (downloadedStats.size !== expectedSize) {
    throw new Error(`Persisted asset size mismatch for ${targetPath}.`);
  }
}

async function extractZipBundle(zipPath: string, targetDirectory: string): Promise<void> {
  if (process.platform === "win32") {
    await runExtractionCommand("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -Path '${escapePowerShellSingleQuoted(zipPath)}' -DestinationPath '${escapePowerShellSingleQuoted(targetDirectory)}' -Force`,
    ]);
    return;
  }

  await runExtractionCommand("unzip", ["-o", zipPath, "-d", targetDirectory]);
}

async function runExtractionCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
    });
    child.once("error", (error) => {
      reject(error);
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function backupExecutableName(executablePath: string): string {
  return `${executablePath.split(/[\\/]/).at(-1) ?? "sandy"}.old`;
}

export function buildReleaseApiUrl(repository: string, releaseTag: string): string {
  return `https://api.github.com/repos/${repository}/releases/tags/${releaseTag}`;
}

export function parseGitHubRelease(value: unknown): GitHubRelease {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid GitHub release payload.");
  }

  const release = value as {
    target_commitish?: unknown;
    published_at?: unknown;
    assets?: unknown;
  };

  if (typeof release.target_commitish !== "string" || !release.target_commitish.trim()) {
    throw new Error("GitHub release payload is missing target_commitish.");
  }
  if (typeof release.published_at !== "string" || !release.published_at.trim()) {
    throw new Error("GitHub release payload is missing published_at.");
  }
  if (!Array.isArray(release.assets)) {
    throw new Error("GitHub release payload is missing assets.");
  }

  const assets = release.assets.map((asset) => {
    if (!asset || typeof asset !== "object") {
      throw new Error("GitHub release asset is invalid.");
    }
    const typedAsset = asset as {
      name?: unknown;
      browser_download_url?: unknown;
      digest?: unknown;
      sha256?: unknown;
      size?: unknown;
    };
    if (typeof typedAsset.name !== "string" || !typedAsset.name.trim()) {
      throw new Error("GitHub release asset is missing name.");
    }
    if (typeof typedAsset.browser_download_url !== "string" || !typedAsset.browser_download_url.trim()) {
      throw new Error(`GitHub release asset ${typedAsset.name} is missing browser_download_url.`);
    }
    if (typeof typedAsset.digest !== "string" || !typedAsset.digest.startsWith("sha256:")) {
      throw new Error(`GitHub release asset ${typedAsset.name} is missing a sha256 digest.`);
    }
    if (typeof typedAsset.size !== "number" || !Number.isFinite(typedAsset.size) || typedAsset.size < 0) {
      throw new Error(`GitHub release asset ${typedAsset.name} is missing size.`);
    }
    return {
      name: typedAsset.name,
      browserDownloadUrl: typedAsset.browser_download_url,
      sha256: typedAsset.digest.slice("sha256:".length),
      size: typedAsset.size,
    };
  });

  return {
    gitRevision: release.target_commitish,
    publishedAt: release.published_at,
    assets,
  };
}

export function resolveExecutableAssets(
  platform: NodeJS.Platform,
  arch: string,
): ResolvedExecutableAssets | null {
  if (!isSupportedPlatform(platform) || !isSupportedArch(arch)) {
    return null;
  }

  const extension = platform === "win32" ? ".exe" : "";
  const targetPlatform = platform === "win32" ? "windows" : platform;
  const target = `bun-${targetPlatform}-${arch}`;
  return {
    bundleAssetName: `sandy-${target}.zip`,
    binaryFileName: `sandy-${target}${extension}`,
    updaterFileName: `sandy-updater-${target}${extension}`,
  };
}

function isSupportedPlatform(value: NodeJS.Platform): value is SupportedPlatform {
  return value === "linux" || value === "darwin" || value === "win32";
}

function isSupportedArch(value: string): value is SupportedArch {
  return value === "x64" || value === "arm64";
}

function shortRevision(revision: string): string {
  return revision.slice(0, 12);
}
