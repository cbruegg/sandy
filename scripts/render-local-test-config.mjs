#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as toml from "@iarna/toml";

const [, , sourcePathArg, targetPathArg, spoolRootArg] = process.argv;

if (!sourcePathArg || !targetPathArg || !spoolRootArg) {
  throw new Error("Usage: render-local-test-config.mjs <source> <target> <spool-root>");
}

const sourcePath = resolve(sourcePathArg);
const targetPath = resolve(targetPathArg);
const spoolRoot = resolve(spoolRootArg);

const parsed = toml.parse(readFileSync(sourcePath, "utf8"));
parsed["channel"] = {
  kind: "local_test",
  local_test: {
    spool_root: spoolRoot,
  },
};

mkdirSync(dirname(targetPath), { recursive: true });
writeFileSync(targetPath, toml.stringify(parsed), "utf8");
