import { writeFile } from "node:fs/promises";
import { renderCodexVersionFile } from "./codex-version-file.mjs";

const output = await renderCodexVersionFile();
await writeFile(new URL("../src/codex-version.generated.ts", import.meta.url), output);
