import { describe, expect, test } from "bun:test";
import {
  listMatrixCryptoBinaryNamesForCompile,
  resolveMatrixCryptoBinaryName,
  resolveMatrixCryptoBinaryNameForBunTarget,
} from "./matrix-crypto-targets.js";

describe("resolveMatrixCryptoBinaryName", () => {
  test("maps runtime platforms", () => {
    expect(resolveMatrixCryptoBinaryName("darwin", "arm64")).toBe("matrix-sdk-crypto.darwin-arm64.node");
    expect(resolveMatrixCryptoBinaryName("darwin", "x64")).toBe("matrix-sdk-crypto.darwin-x64.node");
    expect(resolveMatrixCryptoBinaryName("linux", "x64")).toBe("matrix-sdk-crypto.linux-x64-gnu.node");
    expect(resolveMatrixCryptoBinaryName("linux", "arm64")).toBe("matrix-sdk-crypto.linux-arm64-gnu.node");
    expect(resolveMatrixCryptoBinaryName("win32", "arm64")).toBe("matrix-sdk-crypto.win32-arm64-msvc.node");
  });
});

describe("resolveMatrixCryptoBinaryNameForBunTarget", () => {
  test("maps executable compile targets", () => {
    expect(resolveMatrixCryptoBinaryNameForBunTarget("bun-linux-arm64")).toBe("matrix-sdk-crypto.linux-arm64-gnu.node");
    expect(resolveMatrixCryptoBinaryNameForBunTarget("bun-linux-x64-modern")).toBe("matrix-sdk-crypto.linux-x64-gnu.node");
    expect(resolveMatrixCryptoBinaryNameForBunTarget("bun-linux-x64-musl")).toBe("matrix-sdk-crypto.linux-x64-musl.node");
    expect(resolveMatrixCryptoBinaryNameForBunTarget("bun-darwin-arm64")).toBe("matrix-sdk-crypto.darwin-arm64.node");
    expect(resolveMatrixCryptoBinaryNameForBunTarget("bun-windows-x64")).toBe("matrix-sdk-crypto.win32-x64-msvc.node");
  });

  test("lists unique binaries across compile targets", () => {
    expect(listMatrixCryptoBinaryNamesForCompile()).toEqual([
      "matrix-sdk-crypto.linux-x64-gnu.node",
      "matrix-sdk-crypto.linux-arm64-gnu.node",
      "matrix-sdk-crypto.linux-x64-musl.node",
      "matrix-sdk-crypto.darwin-x64.node",
      "matrix-sdk-crypto.darwin-arm64.node",
      "matrix-sdk-crypto.win32-x64-msvc.node",
      "matrix-sdk-crypto.win32-arm64-msvc.node",
    ]);
  });
});
