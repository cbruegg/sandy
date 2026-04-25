import { spawn } from "node:child_process";
import { loadMatrixAuthState } from "./auth-state.js";
import { promptForPasswordHidden } from "./admin-service.js";
import { matrixAdminMessages } from "../messages.js";

type MatrixVerificationConfig = {
  homeserverUrl: string;
  botUserId: string;
};

export type VerificationStatus = {
  deviceId: string;
  hasCrossSigningKeys: boolean;
  isDeviceVerified: boolean;
};

const nodeVerificationScript = String.raw`
import { join } from "node:path";
import {
  DeviceId,
  OlmMachine,
  RequestType,
  SecretStorageItems,
  SecretStorageKey,
  UserId,
} from "@matrix-org/matrix-sdk-crypto-nodejs";

const MATRIX_SECRET_STORAGE_DEFAULT_KEY = "m.secret_storage.default_key";
const CROSS_SIGNING_MASTER = "m.cross_signing.master";
const CROSS_SIGNING_SELF_SIGNING = "m.cross_signing.self_signing";
const CROSS_SIGNING_USER_SIGNING = "m.cross_signing.user_signing";

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}

const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(1);
}

async function fetchAccountData(homeserverUrl, accessToken, userId, eventType) {
  const url = new URL(
    "/_matrix/client/v3/user/" + encodeURIComponent(userId) + "/account_data/" + encodeURIComponent(eventType),
    homeserverUrl,
  );
  const response = await fetch(url, {
    headers: { authorization: "Bearer " + accessToken },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error("Failed to fetch Matrix account data " + eventType + ": HTTP " + response.status);
  }
  return await response.json();
}

async function fetchOwnKeysQuery(homeserverUrl, accessToken, userId) {
  const url = new URL("/_matrix/client/v3/keys/query", homeserverUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: "Bearer " + accessToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      device_keys: {
        [userId]: [],
      },
    }),
  });
  if (!response.ok) {
    throw new Error("Failed to query Matrix device keys: HTTP " + response.status);
  }
  return await response.json();
}

function isDeviceCrossSignedByOwnerFromKeysQuery(keysQueryResponse, userId, deviceId) {
  const selfSigningKey = keysQueryResponse?.self_signing_keys?.[userId]?.keys
    ? Object.keys(keysQueryResponse.self_signing_keys[userId].keys)[0]
    : null;
  const deviceSignatures = keysQueryResponse?.device_keys?.[userId]?.[deviceId]?.signatures?.[userId];
  return Boolean(selfSigningKey && deviceSignatures && deviceSignatures[selfSigningKey]);
}

async function uploadSignatureRequest(signatureRequest, homeserverUrl, accessToken, machine) {
  const rawBody = JSON.parse(signatureRequest.body);
  const requestBody = rawBody && typeof rawBody === "object" && rawBody.signed_keys
    ? rawBody.signed_keys
    : rawBody;
  const uploadUrl = new URL("/_matrix/client/v3/keys/signatures/upload", homeserverUrl);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      authorization: "Bearer " + accessToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const detail = typeof errorBody.error === "string" ? errorBody.error : "HTTP " + response.status;
    fail("Signature upload failed: " + detail);
  }

  const responseBody = await response.json();
  await machine.markRequestAsSent(
    signatureRequest.id,
    signatureRequest.type,
    JSON.stringify(responseBody),
  );
}

async function processOutgoingRequest(request, homeserverUrl, accessToken, machine) {
  if (request.type === RequestType.SignatureUpload) {
    await uploadSignatureRequest(request, homeserverUrl, accessToken, machine);
    return;
  }

  const parsedBody = JSON.parse(request.body);
  let path = "";
  let method = "POST";
  let payload = parsedBody;

  switch (request.type) {
    case RequestType.KeysUpload:
      path = "/_matrix/client/v3/keys/upload";
      break;
    case RequestType.KeysQuery:
      path = "/_matrix/client/v3/keys/query";
      break;
    case RequestType.KeysClaim:
      path = "/_matrix/client/v3/keys/claim";
      break;
    case RequestType.ToDevice:
      method = "PUT";
      path = "/_matrix/client/v3/sendToDevice/" + encodeURIComponent(parsedBody.event_type) + "/" + encodeURIComponent(parsedBody.txn_id);
      payload = parsedBody.messages;
      break;
    default:
      fail("Unsupported Matrix crypto outgoing request type: " + request.type);
  }

  const response = await fetch(new URL(path, homeserverUrl), {
    method,
    headers: {
      authorization: "Bearer " + accessToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  await machine.markRequestAsSent(
    request.id,
    request.type,
    responseText,
  );
}

async function drainOutgoingRequests(machine, homeserverUrl, accessToken) {
  while (true) {
    const requests = await machine.outgoingRequests();
    if (requests.length === 0) {
      return;
    }
    for (const request of requests) {
      await processOutgoingRequest(request, homeserverUrl, accessToken, machine);
    }
  }
}

async function prepareOwnDeviceState(machine, homeserverUrl, accessToken, userId) {
  await drainOutgoingRequests(machine, homeserverUrl, accessToken);
  await machine.updateTrackedUsers([new UserId(userId)]);
  await drainOutgoingRequests(machine, homeserverUrl, accessToken);
}

async function main() {
const machine = await OlmMachine.initialize(
  new UserId(input.botUserId),
  new DeviceId(input.deviceId),
  join(input.configDirectory, "state", "matrix", "crypto"),
  "",
  0,
);

await prepareOwnDeviceState(
  machine,
  input.homeserverUrl,
  input.accessToken,
  input.botUserId,
);

if (input.command === "status") {
  const crossSigningStatus = await machine.crossSigningStatus();
  const serverKeys = await fetchOwnKeysQuery(
    input.homeserverUrl,
    input.accessToken,
    input.botUserId,
  );
  process.stdout.write(JSON.stringify({
    deviceId: input.deviceId,
    hasCrossSigningKeys: crossSigningStatus.hasMaster
      && crossSigningStatus.hasSelfSigning
      && crossSigningStatus.hasUserSigning,
    isDeviceVerified: isDeviceCrossSignedByOwnerFromKeysQuery(
      serverKeys,
      input.botUserId,
      input.deviceId,
    ),
  }));
  process.exit(0);
}

if (input.command !== "verify") {
  fail("Unknown Matrix verification helper command: " + input.command);
}

const localCrossSigningStatus = await machine.crossSigningStatus();
const serverKeys = await fetchOwnKeysQuery(
  input.homeserverUrl,
  input.accessToken,
  input.botUserId,
);
const hasServerCrossSigningKeys = Boolean(
  serverKeys.master_keys?.[input.botUserId]
  && serverKeys.self_signing_keys?.[input.botUserId]
  && serverKeys.user_signing_keys?.[input.botUserId],
);

if (
  localCrossSigningStatus.hasMaster
  && localCrossSigningStatus.hasSelfSigning
  && localCrossSigningStatus.hasUserSigning
  && hasServerCrossSigningKeys
) {
  const bootstrapRequests = await machine.bootstrapCrossSigning(false);
  await uploadSignatureRequest(
    bootstrapRequests.uploadSignaturesReq,
    input.homeserverUrl,
    input.accessToken,
    machine,
  );
  process.stdout.write(JSON.stringify({
    deviceId: input.deviceId,
    path: "local_cross_signing",
  }));
  process.exit(0);
}

const defaultKeyData = await fetchAccountData(
  input.homeserverUrl,
  input.accessToken,
  input.botUserId,
  MATRIX_SECRET_STORAGE_DEFAULT_KEY,
);
if (!defaultKeyData || !defaultKeyData.key) {
  fail("Matrix secret storage is not set up on this account. Set up Secure Backup in a Matrix client first.");
}

const keyEventType = "m.secret_storage.key." + defaultKeyData.key;
const keyDescriptor = await fetchAccountData(
  input.homeserverUrl,
  input.accessToken,
  input.botUserId,
  keyEventType,
);
if (!keyDescriptor) {
  fail("Secret storage key descriptor \"" + keyEventType + "\" not found on the homeserver.");
}

let secretStorageKey;
try {
  secretStorageKey = SecretStorageKey.fromAccountData(
    String(input.recoveryKey).replace(/\s+/g, ""),
    keyEventType,
    JSON.stringify(keyDescriptor),
  );
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  fail("Failed to parse the provided recovery key against the account's secret-storage key metadata: " + detail);
}

const [masterData, selfSigningData, userSigningData] = await Promise.all([
  fetchAccountData(input.homeserverUrl, input.accessToken, input.botUserId, CROSS_SIGNING_MASTER),
  fetchAccountData(input.homeserverUrl, input.accessToken, input.botUserId, CROSS_SIGNING_SELF_SIGNING),
  fetchAccountData(input.homeserverUrl, input.accessToken, input.botUserId, CROSS_SIGNING_USER_SIGNING),
]);

if (!masterData || !selfSigningData || !userSigningData) {
  fail("Cross-signing secrets are not stored in the account's secret storage. Set up cross-signing in a Matrix client first.");
}

for (const [eventType, value] of [
  [CROSS_SIGNING_MASTER, masterData],
  [CROSS_SIGNING_SELF_SIGNING, selfSigningData],
  [CROSS_SIGNING_USER_SIGNING, userSigningData],
]) {
  try {
    secretStorageKey.decrypt(JSON.stringify(value), eventType);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail("Failed to decrypt " + eventType + " using the provided recovery key: " + detail);
  }
}

let items;
try {
  items = new SecretStorageItems({
    masterKey: JSON.stringify(masterData),
    selfSigningKey: JSON.stringify(selfSigningData),
    userSigningKey: JSON.stringify(userSigningData),
  });
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  fail("Failed to prepare secret-storage items for import: " + detail);
}

let signatureRequest;
try {
  signatureRequest = await machine.importSecretsFromSecretStorage(secretStorageKey, items);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  fail("Matrix secret import failed after successful decryption. This points to a device-store or crypto-binding issue rather than a bad recovery key: " + detail);
}

await uploadSignatureRequest(
  signatureRequest,
  input.homeserverUrl,
  input.accessToken,
  machine,
);

process.stdout.write(JSON.stringify({
  deviceId: input.deviceId,
  path: "recovery_key_import",
}));
process.exit(0);
}

await main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  fail(detail);
});
`;

export class SandyMatrixVerificationService {
  constructor(
    private readonly configDirectory: string,
    private readonly matrixConfig: MatrixVerificationConfig | null,
  ) {}

  async status(): Promise<VerificationStatus | null> {
    if (!this.matrixConfig) {
      return null;
    }

    const authState = await loadMatrixAuthState(this.configDirectory);
    if (!authState) {
      return null;
    }

    return this.runNodeVerificationCommand<VerificationStatus>({
      command: "status",
      configDirectory: this.configDirectory,
      homeserverUrl: this.matrixConfig.homeserverUrl,
      botUserId: this.matrixConfig.botUserId,
      deviceId: authState.deviceId,
      accessToken: authState.accessToken,
    });
  }

  async verifyWithRecoveryKey(): Promise<{ deviceId: string }> {
    if (!this.matrixConfig) {
      throw new Error(matrixAdminMessages.noMatrixConfig());
    }

    const authState = await loadMatrixAuthState(this.configDirectory);
    if (!authState) {
      throw new Error(matrixAdminMessages.authStateMissing());
    }

    const currentStatus = await this.status();
    if (currentStatus?.hasCrossSigningKeys) {
      return this.runNodeVerificationCommand<{ deviceId: string }>({
        command: "verify",
        configDirectory: this.configDirectory,
        homeserverUrl: this.matrixConfig.homeserverUrl,
        botUserId: this.matrixConfig.botUserId,
        deviceId: authState.deviceId,
        accessToken: authState.accessToken,
      });
    }

    const recoveryKey = await promptForPasswordHidden(
      matrixAdminMessages.verifyRecoveryKeyPrompt(),
    );

    if (!recoveryKey) {
      throw new Error(matrixAdminMessages.recoveryKeyRequired());
    }

    return this.runNodeVerificationCommand<{ deviceId: string }>({
      command: "verify",
      configDirectory: this.configDirectory,
      homeserverUrl: this.matrixConfig.homeserverUrl,
      botUserId: this.matrixConfig.botUserId,
      deviceId: authState.deviceId,
      accessToken: authState.accessToken,
      recoveryKey,
    });
  }

  private async runNodeVerificationCommand<T>(payload: Record<string, unknown>): Promise<T> {
    const nodeExecutable = process.env["NODE"]?.trim() || "node";
    const child = spawn(
      nodeExecutable,
      ["--input-type=module", "-e", nodeVerificationScript],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    });

    child.stdin.end(JSON.stringify(payload));

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });

    const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

    if (exitCode !== 0) {
      throw new Error(
        stderr || `Matrix verification helper exited with code ${exitCode ?? "unknown"}.`,
      );
    }

    return JSON.parse(stdout) as T;
  }
}
