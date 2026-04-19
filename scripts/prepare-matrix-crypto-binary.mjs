#!/usr/bin/env bun

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  listMatrixCryptoBinaryNamesForCompile,
  resolveMatrixCryptoBinaryName,
  resolveMatrixCryptoBinaryNameForBunTarget,
} from "../src/channel/matrix-crypto-targets.ts";

const require = createRequire(import.meta.url);

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
  const packageJsonPath = require.resolve("@matrix-org/matrix-sdk-crypto-nodejs/package.json");
  const packageRoot = dirname(packageJsonPath);
  const packageJson = require("@matrix-org/matrix-sdk-crypto-nodejs/package.json");
  const releaseTag = `v${packageJson.version}`;

  const binaryNames = args.allTargets
    ? listMatrixCryptoBinaryNamesForCompile()
    : [args.target
      ? resolveMatrixCryptoBinaryNameForBunTarget(args.target)
      : resolveMatrixCryptoBinaryName(process.platform, process.arch)];

  await mkdir(packageRoot, { recursive: true });

  for (const binaryName of binaryNames) {
    const outputPath = join(packageRoot, binaryName);
    if (existsSync(outputPath)) {
      console.log(`Matrix crypto binary already present: ${binaryName}`);
      continue;
    }

    const url = `${DOWNLOADS_BASE_URL}/${releaseTag}/${binaryName}`;
    console.log(`Downloading Matrix crypto binary ${binaryName}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${binaryName}: HTTP ${response.status}`);
    }
    const bytes = await response.bytes();
    await Bun.write(outputPath, bytes);
  }

  await patchMatrixCryptoPackageIndex(packageRoot, binaryNames);
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

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
