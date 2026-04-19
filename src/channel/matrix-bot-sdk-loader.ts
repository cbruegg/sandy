import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { logger } from "../logger.js";

const require = createRequire(import.meta.url);

export type MatrixWhoAmI = {
  user_id: string;
  device_id?: string;
};

export type MatrixMediaInfo = {
  data: Buffer;
  contentType: string;
};

export type EncryptedFile = {
  url: string;
  key: {
    kty: "oct";
    key_ops: string[];
    alg: "A256CTR";
    k: string;
    ext: true;
  };
  iv: string;
  hashes: {
    sha256: string;
  };
  v: "v2";
};

export type MatrixCryptoLike = {
  isRoomEncrypted(roomId: string): Promise<boolean>;
  encryptMedia(file: Buffer): Promise<{
    buffer: Buffer;
    file: Omit<EncryptedFile, "url">;
  }>;
  decryptMedia(file: EncryptedFile): Promise<Buffer>;
};

export type MatrixClientLike = {
  on(event: string, handler: (roomId: string, event: Record<string, unknown>) => void | Promise<void>): unknown;
  start(filter?: unknown): Promise<unknown>;
  stop(): void;
  getWhoAmI(): Promise<MatrixWhoAmI>;
  getJoinedRooms(): Promise<string[]>;
  getJoinedRoomMembers(roomId: string): Promise<string[]>;
  joinRoom(roomId: string, viaServers?: string[]): Promise<string>;
  leaveRoom(roomId: string, reason?: string): Promise<unknown>;
  getRoomStateEvent(roomId: string, type: string, stateKey: string): Promise<unknown>;
  sendHtmlNotice(roomId: string, html: string): Promise<string>;
  sendEvent(roomId: string, eventType: string, content: Record<string, unknown>): Promise<string>;
  uploadContent(data: Buffer, contentType?: string, filename?: string): Promise<string>;
  downloadContent(mxcUrl: string, allowRemote?: boolean): Promise<MatrixMediaInfo>;
  crypto?: MatrixCryptoLike;
};

type MatrixClientConstructor = new (
  homeserverUrl: string,
  accessToken: string,
  storage: unknown,
  cryptoStorage: unknown,
) => MatrixClientLike;

type StorageProviderConstructor = new (path: string) => unknown;

type LoadedMatrixBotSdk = {
  MatrixClient: MatrixClientConstructor;
  RustSdkCryptoStorageProvider: StorageProviderConstructor;
  SimpleFsStorageProvider: StorageProviderConstructor;
};

export async function loadMatrixBotSdk(): Promise<LoadedMatrixBotSdk> {
  return await requireMatrixBotSdkWithCryptoRepair();
}

async function requireMatrixBotSdkWithCryptoRepair(): Promise<LoadedMatrixBotSdk> {
  try {
    return coerceMatrixBotSdkModule(require("matrix-bot-sdk") as unknown);
  } catch (error) {
    if (!isMissingMatrixCryptoBindingError(error)) {
      throw error;
    }
    await repairMatrixCryptoBinding();
    clearMatrixBotSdkCaches();
    return coerceMatrixBotSdkModule(require("matrix-bot-sdk") as unknown);
  }
}

function isMissingMatrixCryptoBindingError(error: unknown): boolean {
  const message = extractErrorMessage(error);
  return message.includes("@matrix-org/matrix-sdk-crypto-nodejs-")
    || message.includes("matrix-sdk-crypto.")
    || message.includes("Cannot find module '@matrix-org/matrix-sdk-crypto-nodejs");
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

async function repairMatrixCryptoBinding(): Promise<void> {
  const packageJsonPath = require.resolve("@matrix-org/matrix-sdk-crypto-nodejs/package.json");
  const packageRoot = dirname(packageJsonPath);
  const downloadScriptPath = join(packageRoot, "download-lib.js");
  const binaryName = resolveMatrixCryptoBinaryName(process.platform, process.arch);
  const binaryPath = join(packageRoot, binaryName);

  if (existsSync(binaryPath)) {
    return;
  }
  if (!existsSync(downloadScriptPath)) {
    throw new Error(`Matrix crypto download helper is missing at ${downloadScriptPath}.`);
  }

  logger.info("matrix.crypto_binding_download_started", {
    binaryName,
  });
  const runtime = resolveMatrixCryptoDownloadRuntime();
  await runMatrixCryptoDownload(runtime, downloadScriptPath, packageRoot);

  if (!existsSync(binaryPath)) {
    throw new Error(`Matrix crypto binding ${binaryName} is still missing after running the download helper.`);
  }

  logger.info("matrix.crypto_binding_downloaded", {
    binaryName,
  });
}

function clearMatrixBotSdkCaches(): void {
  for (const specifier of ["matrix-bot-sdk", "@matrix-org/matrix-sdk-crypto-nodejs"]) {
    try {
      const resolved = require.resolve(specifier);
      delete require.cache[resolved];
    } catch {
      // Ignore modules that were not cached or could not be resolved.
    }
  }
}

function coerceMatrixBotSdkModule(value: unknown): LoadedMatrixBotSdk {
  const record = asRecord(value);
  const MatrixClient = record["MatrixClient"];
  const RustSdkCryptoStorageProvider = record["RustSdkCryptoStorageProvider"];
  const SimpleFsStorageProvider = record["SimpleFsStorageProvider"];

  if (
    typeof MatrixClient !== "function"
    || typeof RustSdkCryptoStorageProvider !== "function"
    || typeof SimpleFsStorageProvider !== "function"
  ) {
    throw new Error("matrix-bot-sdk did not expose the expected client and storage constructors.");
  }

  return {
    MatrixClient: MatrixClient as MatrixClientConstructor,
    RustSdkCryptoStorageProvider: RustSdkCryptoStorageProvider as StorageProviderConstructor,
    SimpleFsStorageProvider: SimpleFsStorageProvider as StorageProviderConstructor,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function resolveMatrixCryptoBinaryName(platform: NodeJS.Platform, arch: string): string {
  switch (platform) {
    case "darwin":
      if (arch === "arm64") {
        return "matrix-sdk-crypto.darwin-arm64.node";
      }
      if (arch === "x64") {
        return "matrix-sdk-crypto.darwin-x64.node";
      }
      break;
    case "linux":
      if (arch === "x64") {
        return "matrix-sdk-crypto.linux-x64-gnu.node";
      }
      if (arch === "arm64") {
        return "matrix-sdk-crypto.linux-arm64-gnu.node";
      }
      if (arch === "arm") {
        return "matrix-sdk-crypto.linux-arm-gnueabihf.node";
      }
      break;
    case "win32":
      if (arch === "x64") {
        return "matrix-sdk-crypto.win32-x64-msvc.node";
      }
      if (arch === "ia32") {
        return "matrix-sdk-crypto.win32-ia32-msvc.node";
      }
      if (arch === "arm64") {
        return "matrix-sdk-crypto.win32-arm64-msvc.node";
      }
      break;
  }

  throw new Error(`Unsupported platform for Matrix crypto binding download: ${platform}/${arch}`);
}

function resolveMatrixCryptoDownloadRuntime(): string {
  for (const candidate of ["node", "bun"]) {
    const found = Bun.which(candidate);
    if (found) {
      return found;
    }
  }
  throw new Error("Unable to locate `bun` or `node` to download the Matrix crypto binding.");
}

async function runMatrixCryptoDownload(runtime: string, scriptPath: string, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(runtime, [scriptPath], {
      cwd,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Matrix crypto download helper exited with status ${code ?? "unknown"}.`));
    });
  });
}
