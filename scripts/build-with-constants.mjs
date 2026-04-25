import { readFile } from "node:fs/promises";

const forwardedArgs = process.argv.slice(2);

async function resolveManagedCodexVersion() {
  const sdkPackageJson = JSON.parse(
    await readFile(new URL("../node_modules/@openai/codex-sdk/package.json", import.meta.url), "utf8"),
  );
  const codexVersion = sdkPackageJson.dependencies?.["@openai/codex"];

  if (typeof codexVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(codexVersion)) {
    throw new Error(`Unable to determine exact @openai/codex version from @openai/codex-sdk: ${String(codexVersion)}`);
  }

  return codexVersion;
}

const command = Bun.spawn([
  "bun",
  "build",
  ...forwardedArgs,
  "--define",
  `SANDY_CODEX_VERSION=${JSON.stringify(await resolveManagedCodexVersion())}`,
], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await command.exited;
if (exitCode !== 0) {
  process.exit(exitCode);
}
