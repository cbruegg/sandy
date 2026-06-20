#!/usr/bin/env bun

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listMatrixCryptoBinaryNamesForCompile,
  resolveMatrixCryptoBinaryName,
  resolveMatrixCryptoBinaryNameForBunTarget,
} from "../src/channel/matrix-crypto-targets.ts";

const workspaceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nodeModulesRoot = join(workspaceRoot, "node_modules");

const DOWNLOADS_BASE_URL = "https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs/releases/download";

function parseArgs(argv) {
  const args = {
    target: null,
    allTargets: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--target":
        args.target = argv[++index] ?? null;
        break;
      case "--all-targets":
        args.allTargets = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const packageRoots = await findMatrixCryptoPackageRoots(nodeModulesRoot);
  if (packageRoots.length === 0) {
    throw new Error("Could not find any installed @matrix-org/matrix-sdk-crypto-nodejs packages under node_modules.");
  }

  const binaryNames = args.allTargets
    ? listMatrixCryptoBinaryNamesForCompile()
    : [args.target
      ? resolveMatrixCryptoBinaryNameForBunTarget(args.target)
      : resolveMatrixCryptoBinaryName(process.platform, process.arch)];

  for (const packageRoot of packageRoots) {
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    const releaseTag = `v${packageJson.version}`;

    await mkdir(packageRoot, { recursive: true });

    for (const binaryName of binaryNames) {
      const outputPath = join(packageRoot, binaryName);
      const versionPath = `${outputPath}.version`;
      const hasMatchingVersion = await hasExpectedVersion(versionPath, releaseTag);

      if (existsSync(outputPath) && hasMatchingVersion) {
        console.log(`Matrix crypto binary already present: ${relativePackageLabel(packageRoot)} ${binaryName}`);
        continue;
      }

      if (existsSync(outputPath) && !hasMatchingVersion) {
        console.log(`Removing stale Matrix crypto binary ${relativePackageLabel(packageRoot)} ${binaryName} due to version mismatch`);
        await rm(outputPath, { force: true });
      }

      const url = `${DOWNLOADS_BASE_URL}/${releaseTag}/${binaryName}`;
      console.log(`Downloading Matrix crypto binary ${relativePackageLabel(packageRoot)} ${binaryName}`);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download ${binaryName} for ${relativePackageLabel(packageRoot)}: HTTP ${response.status}`);
      }
      const bytes = await response.bytes();
      await Bun.write(outputPath, bytes);
      await writeFile(versionPath, `${releaseTag}\n`);
    }

    await patchMatrixCryptoPackageIndex(packageRoot, binaryNames);
  }
}

async function hasExpectedVersion(versionPath, releaseTag) {
  if (!existsSync(versionPath)) {
    return false;
  }

  const actual = (await readFile(versionPath, "utf8")).trim();
  return actual === releaseTag;
}

await main();

async function patchMatrixCryptoPackageIndex(packageRoot, binaryNames) {
  const indexPath = join(packageRoot, "index.js");
  let source = await readFile(indexPath, "utf8");

  for (const binaryName of binaryNames) {
    const original = new RegExp(
      `localFileExisted = existsSync\\(\\s*join\\(__dirname, '${escapeRegExp(binaryName)}'\\)\\s*\\)`,
      "m",
    );
    const patched = `localFileExisted = true /* patched by Sandy for Bun --compile: ${binaryName} */`;
    const nextSource = source.replace(original, patched);
    if (nextSource === source) {
      throw new Error(
        `Failed to patch @matrix-org/matrix-sdk-crypto-nodejs/index.js for ${binaryName}. `
        + "The expected existsSync(join(__dirname, ...)) loader pattern was not found.",
      );
    }
    source = nextSource;
  }

  await writeFile(indexPath, source);
}

async function findMatrixCryptoPackageRoots(rootDirectory) {
  const packageRoots = [];
  await collectMatrixCryptoPackageRoots(rootDirectory, packageRoots);
  return packageRoots.sort();
}

async function collectMatrixCryptoPackageRoots(directoryPath, packageRoots) {
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === ".bin") {
      continue;
    }

    const entryPath = join(directoryPath, entry.name);
    if (entry.name === "@matrix-org") {
      const packageRoot = join(entryPath, "matrix-sdk-crypto-nodejs");
      if (existsSync(join(packageRoot, "package.json"))) {
        packageRoots.push(packageRoot);
      }
      await collectScopedNodeModules(entryPath, packageRoots);
      continue;
    }

    const nestedNodeModules = join(entryPath, "node_modules");
    if (existsSync(nestedNodeModules)) {
      await collectMatrixCryptoPackageRoots(nestedNodeModules, packageRoots);
    }
  }
}

async function collectScopedNodeModules(scopeDirectoryPath, packageRoots) {
  const scopeEntries = await readdir(scopeDirectoryPath, { withFileTypes: true });

  for (const scopeEntry of scopeEntries) {
    if (!scopeEntry.isDirectory()) {
      continue;
    }

    const packageDirectoryPath = join(scopeDirectoryPath, scopeEntry.name);
    const nestedNodeModules = join(packageDirectoryPath, "node_modules");
    if (existsSync(nestedNodeModules)) {
      await collectMatrixCryptoPackageRoots(nestedNodeModules, packageRoots);
    }
  }
}

function relativePackageLabel(packageRoot) {
  return packageRoot.startsWith(`${workspaceRoot}/`)
    ? packageRoot.slice(workspaceRoot.length + 1)
    : packageRoot;
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
