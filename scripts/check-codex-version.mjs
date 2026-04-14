import { readFile } from "node:fs/promises";
import { renderCodexVersionFile } from "./codex-version-file.mjs";

const expectedOutput = await renderCodexVersionFile();
const currentOutput = await readFile(new URL("../src/codex-version.generated.ts", import.meta.url), "utf8");

if (currentOutput !== expectedOutput) {
  throw new Error("src/codex-version.generated.ts is stale. Run `bun run sync:codex-version` and commit the result.");
}
