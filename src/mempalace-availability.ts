import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type {ThreadStartParams} from "./codex-app-server-client/generated/v2";

let cachedAvailable: boolean | null = null;

export function isMemPalaceAvailable(): boolean {
  if (cachedAvailable !== null) {
    return cachedAvailable;
  }

  const result = spawnSync("uv", ["--version"], {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 5000,
  });

  cachedAvailable = result.status === 0;
  return cachedAvailable;
}

export function buildMainAgentConfig(configDirectory: string, enabled: boolean): ThreadStartParams["config"] {
  if (!enabled || !isMemPalaceAvailable()) {
    return {};
  }

  const palacePath = join(configDirectory, "mempalace", "palace");

  return {
    mcp_servers: {
      mempalace: {
        command: "uv",
        args: ["run", "--with", "mempalace", "python3", "-m", "mempalace.mcp_server", "--palace", palacePath],
      },
    },
  };
}
