import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  listMatrixCryptoBinaryNamesForCompile,
  resolveMatrixCryptoBinaryName,
  resolveMatrixCryptoBinaryNameForBunTarget,
} from "./matrix-crypto-targets.js";

describe("prepare-matrix-crypto-binary", () => {
  test("patches crypto copies nested under scoped and unscoped dependencies", async () => {
    const temporaryRoot = join(import.meta.dirname, "../../tmp");
    await mkdir(temporaryRoot, { recursive: true });
    const workspaceRoot = await mkdtemp(join(temporaryRoot, "matrix-crypto-"));
    try {
      await mkdir(join(workspaceRoot, "scripts"), { recursive: true });
      await mkdir(join(workspaceRoot, "src/channel"), { recursive: true });
      await copyFile(
        new URL("../../scripts/prepare-matrix-crypto-binary.mjs", import.meta.url),
        join(workspaceRoot, "scripts/prepare-matrix-crypto-binary.mjs"),
      );
      await copyFile(
        new URL("./matrix-crypto-targets.ts", import.meta.url),
        join(workspaceRoot, "src/channel/matrix-crypto-targets.ts"),
      );

      const binaryName = "matrix-sdk-crypto.linux-arm64-gnu.node";
      const cryptoPackage = "node_modules/@matrix-org/matrix-sdk-crypto-nodejs";
      const packages = [
        { path: cryptoPackage, version: "0.6.6" },
        { path: `node_modules/@vector-im/matrix-bot-sdk/${cryptoPackage}`, version: "0.6.1" },
        { path: `node_modules/unscoped/${cryptoPackage}`, version: "0.6.1" },
        { path: `node_modules/@matrix-org/other/${cryptoPackage}`, version: "0.6.1" },
        { path: `node_modules/@outer/package/node_modules/@inner/package/${cryptoPackage}`, version: "0.6.1" },
      ];
      for (const installedPackage of packages) {
        const packageRoot = join(workspaceRoot, installedPackage.path);
        await mkdir(packageRoot, { recursive: true });
        await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: installedPackage.version }));
        // Seed matching cached binaries so preparation never needs a network download.
        await writeFile(join(packageRoot, binaryName), "cached test binary");
        await writeFile(join(packageRoot, `${binaryName}.version`), `v${installedPackage.version}\n`);
        await writeFile(join(packageRoot, "index.js"), `const localFileExisted = existsSync(\n  join(__dirname, '${binaryName}')\n)\n`);
      }

      const result = Bun.spawnSync([
        process.execPath,
        join(workspaceRoot, "scripts/prepare-matrix-crypto-binary.mjs"),
        "--target", "bun-linux-arm64",
      ], { cwd: workspaceRoot });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      for (const installedPackage of packages) {
        const source = await readFile(join(workspaceRoot, installedPackage.path, "index.js"), "utf8");
        expect(source).toContain(`localFileExisted = true /* patched by Sandy for Bun --compile: ${binaryName} */`);
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

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
