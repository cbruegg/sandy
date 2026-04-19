import { createRequire } from "node:module";

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
  preloadMatrixCryptoNativeModule();
  return coerceMatrixBotSdkModule(await import("matrix-bot-sdk"));
}

function preloadMatrixCryptoNativeModule(): void {
  try {
    switch (process.platform) {
      case "darwin":
        if (process.arch === "arm64") {
          require("@matrix-org/matrix-sdk-crypto-nodejs/matrix-sdk-crypto.darwin-arm64.node");
        } else if (process.arch === "x64") {
          require("@matrix-org/matrix-sdk-crypto-nodejs/matrix-sdk-crypto.darwin-x64.node");
        }
        return;
      case "linux":
        if (process.arch === "arm64") {
          require("@matrix-org/matrix-sdk-crypto-nodejs/matrix-sdk-crypto.linux-arm64-gnu.node");
        } else if (process.arch === "x64") {
          require("@matrix-org/matrix-sdk-crypto-nodejs/matrix-sdk-crypto.linux-x64-gnu.node");
        } else if (process.arch === "arm") {
          require("@matrix-org/matrix-sdk-crypto-nodejs/matrix-sdk-crypto.linux-arm-gnueabihf.node");
        }
        return;
      case "win32":
        if (process.arch === "arm64") {
          require("@matrix-org/matrix-sdk-crypto-nodejs/matrix-sdk-crypto.win32-arm64-msvc.node");
        } else if (process.arch === "x64") {
          require("@matrix-org/matrix-sdk-crypto-nodejs/matrix-sdk-crypto.win32-x64-msvc.node");
        } else if (process.arch === "ia32") {
          require("@matrix-org/matrix-sdk-crypto-nodejs/matrix-sdk-crypto.win32-ia32-msvc.node");
        }
        return;
      default:
        return;
    }
  } catch {
    // Ignore here. This is only to make Bun bundle the native assets when present.
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
