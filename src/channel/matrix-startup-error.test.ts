import { describe, expect, test } from "bun:test";
import { describeMatrixStartupError } from "./matrix-startup-error.js";

describe("describeMatrixStartupError", () => {
  test("rewrites Matrix one-time-key conflicts with actionable guidance", () => {
    const error = new Error("M_UNKNOWN: One time key signed_curve25519:AAAA already exists. Old key: ...");

    const described = describeMatrixStartupError(error, {
      botUserId: "@og_sandy:matrix.org",
      botDeviceId: "ARlQs8xUea",
      stateRoot: "/tmp/sandy/state/matrix",
    });

    expect(described.message).toContain("Matrix encrypted startup failed for @og_sandy:matrix.org device ARlQs8xUea");
    expect(described.message).toContain("copied from Element or another Matrix client");
    expect(described.message).toContain("/tmp/sandy/state/matrix");
  });

  test("passes through unrelated startup errors", () => {
    const error = new Error("network timeout");
    const described = describeMatrixStartupError(error, {
      botUserId: "@og_sandy:matrix.org",
      botDeviceId: "ARlQs8xUea",
      stateRoot: "/tmp/sandy/state/matrix",
    });

    expect(described).toBe(error);
  });
});
