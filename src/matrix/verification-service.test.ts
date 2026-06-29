import { test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  buildMatrixCryptoMachineStoragePath,
  sanitizeMatrixKeysUploadPayload,
} from "./verification-service.js";

test("buildMatrixCryptoMachineStoragePath matches Matrix bot SDK per-device path", () => {
  const storagePath = buildMatrixCryptoMachineStoragePath(
    "/home/pi/sandy/config",
    "SANDY_MQZM85E4_D0DED705C354C40E",
  );

  assert.equal(
    storagePath,
    join(
      "/home/pi/sandy/config/state/matrix/crypto",
      "12097ffcf0b66d79fba8cc1c505f8d769d4bedba0ad745d78f8007011b31f87b",
    ),
  );
});

test("sanitizeMatrixKeysUploadPayload removes one-time keys only", () => {
  const payload = {
    device_keys: { keys: {} },
    one_time_keys: {
      "signed_curve25519:AAAAAAAAAA0": { key: "one-time" },
    },
    fallback_keys: {
      "signed_curve25519:fallback": { key: "fallback" },
    },
  };

  sanitizeMatrixKeysUploadPayload(payload);

  assert.deepEqual(payload, {
    device_keys: { keys: {} },
    fallback_keys: {
      "signed_curve25519:fallback": { key: "fallback" },
    },
  });
});
