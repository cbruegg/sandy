import { readFile, writeFile } from "node:fs/promises";

const sdkPackageJson = JSON.parse(await readFile(new URL("../node_modules/@openai/codex-sdk/package.json", import.meta.url), "utf8"));
const codexVersion = sdkPackageJson.dependencies?.["@openai/codex"];

if (typeof codexVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(codexVersion)) {
  throw new Error(`Unable to determine exact @openai/codex version from @openai/codex-sdk: ${String(codexVersion)}`);
}

const output = `// Overwritten by local tooling and CI to embed the exact managed Codex version.\n// Safe to commit when this value matches the Codex version implied by bun.lock.\nexport const embeddedCodexVersion = ${JSON.stringify(codexVersion)} as const;\n`;
await writeFile(new URL("../src/codex-version.generated.ts", import.meta.url), output);
