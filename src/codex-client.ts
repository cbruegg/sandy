import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Codex, type CodexOptions } from "@openai/codex-sdk";
import { embeddedCodexVersion } from "./codex-version.generated.js";
import { resolveCodexCacheRoot } from "./cache-paths.js";
import { buildGitHubHeaders, isGitHubUrl } from "./github-http.js";
import { logger } from "./logger.js";

export { resolveCodexCacheRoot } from "./cache-paths.js";

const SANDY_CODEX_PATH_ENV = "SANDY_CODEX_PATH";
const CODEX_RELEASE_REPOSITORY = "openai/codex";
const CODEX_RELEASE_TAG_PREFIX = "rust-v";
const CODEX_NPM_NAME = "@openai/codex";

type SupportedPlatform = "linux" | "darwin" | "win32";
type SupportedArch = "x64" | "arm64";

type GitHubReleaseAsset = {
  name: string;
  browserDownloadUrl: string;
  sha256: string;
  size: number;
};

type ManagedCodexAsset = {
  assetName: string;
  archive: "tar.gz" | "raw";
  extractedBinaryName: string;
};

type EnsureManagedCodexOptions = {
  cacheRoot?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
};

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveConfiguredCodexPath(env: NodeJS.ProcessEnv): string | null {
  const configuredPath = env[SANDY_CODEX_PATH_ENV]?.trim();
  if (!configuredPath) {
    return null;
  }

  const resolvedPath = isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath);
  if (!isExecutableFile(resolvedPath)) {
    throw new Error(`Configured ${SANDY_CODEX_PATH_ENV} path is not executable: ${resolvedPath}`);
  }
  return resolvedPath;
}

function isSupportedPlatform(value: NodeJS.Platform): value is SupportedPlatform {
  return value === "linux" || value === "darwin" || value === "win32";
}

function isSupportedArch(value: string): value is SupportedArch {
  return value === "x64" || value === "arm64";
}

export function resolveCodexTargetTriple(platform: NodeJS.Platform, arch: string): string | null {
  if (!isSupportedPlatform(platform) || !isSupportedArch(arch)) {
    return null;
  }

  if (platform === "linux") {
    return arch === "x64" ? "x86_64-unknown-linux-musl" : "aarch64-unknown-linux-musl";
  }
  if (platform === "darwin") {
    return arch === "x64" ? "x86_64-apple-darwin" : "aarch64-apple-darwin";
  }
  return arch === "x64" ? "x86_64-pc-windows-msvc" : "aarch64-pc-windows-msvc";
}

export function resolveManagedCodexAsset(platform: NodeJS.Platform, arch: string): ManagedCodexAsset | null {
  const targetTriple = resolveCodexTargetTriple(platform, arch);
  if (!targetTriple) {
    return null;
  }

  if (platform === "win32") {
    return {
      assetName: `codex-${targetTriple}.exe`,
      archive: "raw",
      extractedBinaryName: `codex-${targetTriple}.exe`,
    };
  }

  return {
    assetName: `codex-${targetTriple}.tar.gz`,
    archive: "tar.gz",
    extractedBinaryName: `codex-${targetTriple}`,
  };
}

export function resolveCodexVersion(): string {
  const version = embeddedCodexVersion;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error(`Unable to determine ${CODEX_NPM_NAME} version.`);
  }
  return version;
}

function resolveCodexBinaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "codex.exe" : "codex";
}

function buildReleaseApiUrl(repository: string, releaseTag: string): string {
  return `https://api.github.com/repos/${repository}/releases/tags/${releaseTag}`;
}

function parseGitHubReleaseAsset(value: unknown): GitHubReleaseAsset[] {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid GitHub release payload.");
  }

  const release = value as {
    assets?: unknown;
  };
  if (!Array.isArray(release.assets)) {
    throw new Error("GitHub release payload is missing assets.");
  }

  return release.assets.map((asset) => {
    if (!asset || typeof asset !== "object") {
      throw new Error("GitHub release asset is invalid.");
    }

    const typedAsset = asset as {
      name?: unknown;
      browser_download_url?: unknown;
      digest?: unknown;
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
}

async function downloadVerifiedAsset(
  fetchFn: typeof fetch,
  asset: GitHubReleaseAsset,
  targetPath: string,
): Promise<void> {
  const response = await fetchFn(
    asset.browserDownloadUrl,
    isGitHubUrl(asset.browserDownloadUrl)
      ? { headers: buildGitHubHeaders() }
      : undefined,
  );
  if (!response.ok) {
    throw new Error(`Codex asset download failed with status ${response.status}.`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength !== asset.size) {
    throw new Error(`Downloaded Codex asset size mismatch for ${asset.name}.`);
  }

  const hash = createHash("sha256").update(buffer).digest("hex");
  if (hash !== asset.sha256) {
    throw new Error(`Downloaded Codex asset checksum mismatch for ${asset.name}.`);
  }

  await writeFile(targetPath, buffer);
  const downloadedStats = await stat(targetPath);
  if (downloadedStats.size !== asset.size) {
    throw new Error(`Persisted Codex asset size mismatch for ${targetPath}.`);
  }
}

async function extractCodexAsset(
  assetPath: string,
  asset: ManagedCodexAsset,
  versionDirectory: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const finalBinaryPath = join(versionDirectory, resolveCodexBinaryName(platform));
  if (asset.archive === "raw") {
    await rename(assetPath, finalBinaryPath);
  } else {
    await runCommand("tar", ["-xzf", assetPath, "-C", versionDirectory]);
    await rename(join(versionDirectory, asset.extractedBinaryName), finalBinaryPath);
  }
  if (process.platform !== "win32") {
    await chmod(finalBinaryPath, 0o755);
  }
  return finalBinaryPath;
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}

async function pruneCodexCache(cacheRoot: string, keepVersion: string): Promise<void> {
  const entries = await readdir(cacheRoot, { withFileTypes: true }).catch(() => []);
  const removedVersions: string[] = [];
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || entry.name === keepVersion) {
      return;
    }
    await rm(join(cacheRoot, entry.name), { recursive: true, force: true });
    removedVersions.push(entry.name);
  }));
  if (removedVersions.length > 0) {
    logger.info("codex.cache_pruned", {
      cacheRoot,
      keepVersion,
      removedVersions,
    });
  }
}

async function fetchCodexReleaseAsset(
  version: string,
  assetName: string,
  fetchFn: typeof fetch,
): Promise<GitHubReleaseAsset> {
  const response = await fetchFn(buildReleaseApiUrl(CODEX_RELEASE_REPOSITORY, `${CODEX_RELEASE_TAG_PREFIX}${version}`), {
    headers: buildGitHubHeaders({
      accept: "application/vnd.github+json",
    }),
  });
  if (!response.ok) {
    throw new Error(`Codex release metadata request failed with status ${response.status}.`);
  }

  const assets = parseGitHubReleaseAsset(await response.json());
  const asset = assets.find((entry) => entry.name === assetName);
  if (!asset) {
    throw new Error(`Codex release ${version} is missing asset ${assetName}.`);
  }
  return asset;
}

export async function ensureManagedCodexPath(options: EnsureManagedCodexOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const configuredPath = resolveConfiguredCodexPath(env);
  if (configuredPath) {
    logger.info("codex.path_override", {
      path: configuredPath,
      source: SANDY_CODEX_PATH_ENV,
    });
    return configuredPath;
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const version = resolveCodexVersion();
  const asset = resolveManagedCodexAsset(platform, arch);
  const targetTriple = resolveCodexTargetTriple(platform, arch);
  if (!asset || !targetTriple) {
    throw new Error(`Unsupported Codex platform: ${platform} (${arch})`);
  }

  const cacheRoot = options.cacheRoot
    ?? (platform === process.platform && arch === process.arch
      ? resolveCodexCacheRoot(env)
      : join(resolveCodexCacheRoot(env), targetTriple));
  const versionDirectory = join(cacheRoot, version);
  const binaryPath = join(versionDirectory, resolveCodexBinaryName(platform));
  logger.info("codex.resolve_started", {
    version,
    cacheRoot,
    assetName: asset.assetName,
    platform,
    arch,
  });
  if (isExecutableFile(binaryPath)) {
    logger.info("codex.cache_hit", {
      version,
      binaryPath,
    });
    await pruneCodexCache(cacheRoot, version);
    return binaryPath;
  }

  const fetchFn = options.fetchFn ?? fetch;
  await mkdir(cacheRoot, { recursive: true });
  const stagingDirectory = await mkdtemp(join(tmpdir(), "sandy-codex-"));
  logger.info("codex.download_started", {
    version,
    assetName: asset.assetName,
    cacheRoot,
    stagingDirectory,
  });

  try {
    logger.debug("codex.release_metadata_fetching", {
      version,
      releaseTag: `${CODEX_RELEASE_TAG_PREFIX}${version}`,
    });
    const releaseAsset = await fetchCodexReleaseAsset(version, asset.assetName, fetchFn);
    const downloadedAssetPath = join(stagingDirectory, asset.assetName);
    logger.info("codex.asset_downloading", {
      version,
      assetName: releaseAsset.name,
      size: releaseAsset.size,
      url: releaseAsset.browserDownloadUrl,
    });
    await downloadVerifiedAsset(fetchFn, releaseAsset, downloadedAssetPath);
    await mkdir(versionDirectory, { recursive: true });
    logger.info("codex.asset_extracting", {
      version,
      assetName: releaseAsset.name,
      versionDirectory,
    });
    await extractCodexAsset(downloadedAssetPath, asset, versionDirectory, platform);
    await pruneCodexCache(cacheRoot, version);
    logger.info("codex.download_ready", {
      version,
      binaryPath,
    });
    return binaryPath;
  } catch (error) {
    logger.error("codex.download_failed", {
      version,
      cacheRoot,
      message: error instanceof Error ? error.message : "Unknown Codex download failure.",
    });
    await rm(versionDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function createCodexClient(options: Omit<CodexOptions, "codexPathOverride"> = {}): Promise<Codex> {
  const codexPathOverride = await ensureManagedCodexPath();
  return new Codex({
    ...options,
    codexPathOverride,
  });
}

export function resolveCodexPathOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveConfiguredCodexPath(env) ?? undefined;
}
