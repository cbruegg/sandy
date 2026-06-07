import { join } from "node:path";
import { matrixStateRoot } from "../state-paths.js";
import {
  DeviceId,
  KeysClaimRequest,
  KeysQueryRequest,
  KeysUploadRequest,
  OlmMachine,
  SecretStorageItems,
  SecretStorageKey,
  SignatureUploadRequest,
  ToDeviceRequest,
  UserId,
} from "@matrix-org/matrix-sdk-crypto-nodejs";
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

const MATRIX_SECRET_STORAGE_DEFAULT_KEY = "m.secret_storage.default_key";
const CROSS_SIGNING_MASTER = "m.cross_signing.master";
const CROSS_SIGNING_SELF_SIGNING = "m.cross_signing.self_signing";
const CROSS_SIGNING_USER_SIGNING = "m.cross_signing.user_signing";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fetchAccountData(
  homeserverUrl: string,
  accessToken: string,
  userId: string,
  eventType: string,
): Promise<unknown> {
  const url = new URL(
    `/_matrix/client/v3/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(eventType)}`,
    homeserverUrl,
  );
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch Matrix account data ${eventType}: HTTP ${response.status}`);
  }
  return await response.json();
}

async function fetchOwnKeysQuery(
  homeserverUrl: string,
  accessToken: string,
  userId: string,
): Promise<unknown> {
  const url = new URL("/_matrix/client/v3/keys/query", homeserverUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      device_keys: {
        [userId]: [],
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to query Matrix device keys: HTTP ${response.status}`);
  }
  return await response.json();
}

function isDeviceCrossSignedByOwnerFromKeysQuery(
  keysQueryResponse: unknown,
  userId: string,
  deviceId: string,
): boolean {
  if (!isRecord(keysQueryResponse)) return false;

  const selfSigningKeys = keysQueryResponse["self_signing_keys"];
  if (!isRecord(selfSigningKeys)) return false;

  const userSelfSigning = selfSigningKeys[userId];
  if (!isRecord(userSelfSigning)) return false;

  const keys = userSelfSigning["keys"];
  if (!isRecord(keys)) return false;

  const selfSigningKey = Object.keys(keys)[0] ?? null;
  if (!selfSigningKey) return false;

  const deviceKeys = keysQueryResponse["device_keys"];
  if (!isRecord(deviceKeys)) return false;

  const userDevices = deviceKeys[userId];
  if (!isRecord(userDevices)) return false;

  const device = userDevices[deviceId];
  if (!isRecord(device)) return false;

  const signatures = device["signatures"];
  if (!isRecord(signatures)) return false;

  const userSignatures = signatures[userId];
  if (!isRecord(userSignatures)) return false;

  return selfSigningKey in userSignatures;
}

async function uploadSignatureRequest(
  signatureRequest: { id: string; type: number; body: string },
  homeserverUrl: string,
  accessToken: string,
  machine: OlmMachine,
): Promise<void> {
  const rawBody = JSON.parse(signatureRequest.body) as unknown;
  const requestBody =
    rawBody && typeof rawBody === "object" && "signed_keys" in rawBody
      ? (rawBody as Record<string, unknown>)["signed_keys"]
      : rawBody;
  const uploadUrl = new URL("/_matrix/client/v3/keys/signatures/upload", homeserverUrl);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const detail = typeof errorBody["error"] === "string" ? String(errorBody["error"]) : `HTTP ${response.status}`;
    throw new Error(`Signature upload failed: ${detail}`);
  }

  const responseBody = await response.json();
  await machine.markRequestAsSent(
    signatureRequest.id,
    signatureRequest.type,
    JSON.stringify(responseBody),
  );
}

async function processOutgoingRequest(
  request:
    | KeysUploadRequest
    | KeysQueryRequest
    | KeysClaimRequest
    | ToDeviceRequest
    | SignatureUploadRequest,
  homeserverUrl: string,
  accessToken: string,
  machine: OlmMachine,
): Promise<void> {
  if (request instanceof SignatureUploadRequest) {
    await uploadSignatureRequest(request, homeserverUrl, accessToken, machine);
    return;
  }

  const parsedBody = JSON.parse(request.body) as Record<string, unknown>;
  let path: string;
  let method = "POST";
  let payload: unknown = parsedBody;

  if (request instanceof KeysUploadRequest) {
    path = "/_matrix/client/v3/keys/upload";
  } else if (request instanceof KeysQueryRequest) {
    path = "/_matrix/client/v3/keys/query";
  } else if (request instanceof KeysClaimRequest) {
    path = "/_matrix/client/v3/keys/claim";
  } else if (request instanceof ToDeviceRequest) {
    method = "PUT";
    path = `/_matrix/client/v3/sendToDevice/${encodeURIComponent(String(parsedBody["event_type"]))}/${encodeURIComponent(String(parsedBody["txn_id"]))}`;
    payload = parsedBody["messages"];
  } else {
    throw new Error("Unsupported Matrix crypto outgoing request type");
  }

  const response = await fetch(new URL(path, homeserverUrl), {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
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

async function drainOutgoingRequests(
  machine: OlmMachine,
  homeserverUrl: string,
  accessToken: string,
): Promise<void> {
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

async function prepareOwnDeviceState(
  machine: OlmMachine,
  homeserverUrl: string,
  accessToken: string,
  userId: string,
): Promise<void> {
  await drainOutgoingRequests(machine, homeserverUrl, accessToken);
  await machine.updateTrackedUsers([new UserId(userId)]);
  await drainOutgoingRequests(machine, homeserverUrl, accessToken);
}

async function createMachine(
  configDirectory: string,
  botUserId: string,
  deviceId: string,
): Promise<OlmMachine> {
  return await OlmMachine.initialize(
    new UserId(botUserId),
    new DeviceId(deviceId),
    join(matrixStateRoot(configDirectory), "crypto"),
    "",
    0,
  );
}

async function getVerificationStatus(
  machine: OlmMachine,
  homeserverUrl: string,
  accessToken: string,
  botUserId: string,
  deviceId: string,
): Promise<VerificationStatus> {
  await prepareOwnDeviceState(machine, homeserverUrl, accessToken, botUserId);

  const crossSigningStatus = await machine.crossSigningStatus();
  const serverKeys = await fetchOwnKeysQuery(homeserverUrl, accessToken, botUserId);

  return {
    deviceId,
    hasCrossSigningKeys:
      crossSigningStatus.hasMaster &&
      crossSigningStatus.hasSelfSigning &&
      crossSigningStatus.hasUserSigning,
    isDeviceVerified: isDeviceCrossSignedByOwnerFromKeysQuery(serverKeys, botUserId, deviceId),
  };
}

async function verifyDevice(
  machine: OlmMachine,
  homeserverUrl: string,
  accessToken: string,
  botUserId: string,
  deviceId: string,
  recoveryKey: string | undefined,
): Promise<{ deviceId: string }> {
  await prepareOwnDeviceState(machine, homeserverUrl, accessToken, botUserId);

  const localCrossSigningStatus = await machine.crossSigningStatus();
  const serverKeys = await fetchOwnKeysQuery(homeserverUrl, accessToken, botUserId);
  const hasServerCrossSigningKeys = Boolean(
    isRecord(serverKeys) &&
      isRecord(serverKeys["master_keys"]) &&
      botUserId in serverKeys["master_keys"] &&
      isRecord(serverKeys["self_signing_keys"]) &&
      botUserId in serverKeys["self_signing_keys"] &&
      isRecord(serverKeys["user_signing_keys"]) &&
      botUserId in serverKeys["user_signing_keys"],
  );

  if (
    localCrossSigningStatus.hasMaster &&
    localCrossSigningStatus.hasSelfSigning &&
    localCrossSigningStatus.hasUserSigning &&
    hasServerCrossSigningKeys
  ) {
    const bootstrapRequests = await machine.bootstrapCrossSigning(false);
    await uploadSignatureRequest(
      bootstrapRequests.uploadSignaturesReq,
      homeserverUrl,
      accessToken,
      machine,
    );
    return { deviceId };
  }

  const defaultKeyData = await fetchAccountData(
    homeserverUrl,
    accessToken,
    botUserId,
    MATRIX_SECRET_STORAGE_DEFAULT_KEY,
  );
  if (
    !defaultKeyData ||
    typeof defaultKeyData !== "object" ||
    !("key" in defaultKeyData) ||
    typeof defaultKeyData["key"] !== "string" ||
    !defaultKeyData["key"]
  ) {
    throw new Error(
      "Matrix secret storage is not set up on this account. Set up Secure Backup in a Matrix client first.",
    );
  }

  const keyEventType = `m.secret_storage.key.${defaultKeyData["key"]}`;
  const keyDescriptor = await fetchAccountData(
    homeserverUrl,
    accessToken,
    botUserId,
    keyEventType,
  );
  if (!keyDescriptor) {
    throw new Error(`Secret storage key descriptor "${keyEventType}" not found on the homeserver.`);
  }

  let secretStorageKey: SecretStorageKey;
  try {
    secretStorageKey = SecretStorageKey.fromAccountData(
      String(recoveryKey).replace(/\s+/g, ""),
      keyEventType,
      JSON.stringify(keyDescriptor),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to parse the provided recovery key against the account's secret-storage key metadata: ${detail}`,
      { cause: error },
    );
  }

  const [masterData, selfSigningData, userSigningData] = await Promise.all([
    fetchAccountData(homeserverUrl, accessToken, botUserId, CROSS_SIGNING_MASTER),
    fetchAccountData(homeserverUrl, accessToken, botUserId, CROSS_SIGNING_SELF_SIGNING),
    fetchAccountData(homeserverUrl, accessToken, botUserId, CROSS_SIGNING_USER_SIGNING),
  ]);

  if (!masterData || !selfSigningData || !userSigningData) {
    throw new Error(
      "Cross-signing secrets are not stored in the account's secret storage. Set up cross-signing in a Matrix client first.",
    );
  }

  for (const [eventType, value] of [
    [CROSS_SIGNING_MASTER, masterData],
    [CROSS_SIGNING_SELF_SIGNING, selfSigningData],
    [CROSS_SIGNING_USER_SIGNING, userSigningData],
  ] as const) {
    try {
      secretStorageKey.decrypt(JSON.stringify(value), eventType);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to decrypt ${eventType} using the provided recovery key: ${detail}`,
        { cause: error },
      );
    }
  }

  let items: SecretStorageItems;
  try {
    items = new SecretStorageItems({
      masterKey: JSON.stringify(masterData),
      selfSigningKey: JSON.stringify(selfSigningData),
      userSigningKey: JSON.stringify(userSigningData),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to prepare secret-storage items for import: ${detail}`,
      { cause: error },
    );
  }

  let signatureRequest;
  try {
    signatureRequest = await machine.importSecretsFromSecretStorage(secretStorageKey, items);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Matrix secret import failed after successful decryption. This points to a device-store or crypto-binding issue rather than a bad recovery key: ${detail}`,
      { cause: error },
    );
  }

  await uploadSignatureRequest(signatureRequest, homeserverUrl, accessToken, machine);

  return { deviceId };
}

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

    const machine = await createMachine(
      this.configDirectory,
      this.matrixConfig.botUserId,
      authState.deviceId,
    );

    try {
      return await getVerificationStatus(
        machine,
        this.matrixConfig.homeserverUrl,
        authState.accessToken,
        this.matrixConfig.botUserId,
        authState.deviceId,
      );
    } finally {
      machine.close();
    }
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
    let recoveryKey: string | undefined;

    if (!currentStatus?.hasCrossSigningKeys) {
      recoveryKey = await promptForPasswordHidden(
        matrixAdminMessages.verifyRecoveryKeyPrompt(),
      );

      if (!recoveryKey) {
        throw new Error(matrixAdminMessages.recoveryKeyRequired());
      }
    }

    const machine = await createMachine(
      this.configDirectory,
      this.matrixConfig.botUserId,
      authState.deviceId,
    );

    try {
      return await verifyDevice(
        machine,
        this.matrixConfig.homeserverUrl,
        authState.accessToken,
        this.matrixConfig.botUserId,
        authState.deviceId,
        recoveryKey,
      );
    } finally {
      machine.close();
    }
  }
}
