import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Default MemPalace palace directory. */
const MEMPALACE_PALACE_PATH = join(homedir(), ".mempalace", "palace");

let cachedAvailability: boolean | null = null;

function isMemPalaceAvailable(): boolean {
  if (cachedAvailability !== null) {
    return cachedAvailability;
  }

  const result = spawnSync("python3", ["-c", "import mempalace"], {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 5000,
  });

  cachedAvailability = result.status === 0;
  return cachedAvailability;
}

export function buildMainAgentMcpConfig(): { [key: string]: unknown } | null {
  if (!isMemPalaceAvailable()) {
    return null;
  }

  return {
    mcp_servers: {
      mempalace: {
        command: "python3",
        args: ["-m", "mempalace.mcp_server", "--palace", MEMPALACE_PALACE_PATH],
      },
    },
  };
}
