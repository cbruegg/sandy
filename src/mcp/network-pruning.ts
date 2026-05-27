import { logger } from "../logger.js";
import { HEARTBEAT_FILE, HEARTBEAT_TIMEOUT_MS, isHeartbeatFreshSync } from "../sandbox/heartbeat.js";

export const MANAGED_NETWORK_LABEL = "sandy.managed";
export const CONTROLLER_HEARTBEAT_PATH_LABEL = "sandy.controller_heartbeat_path";

type RunDockerCommand = (args: string[], ignoreFailure?: boolean) => Promise<void>;
type RunDockerCommandCapture = (args: string[], ignoreFailure?: boolean) => Promise<string>;

export function buildManagedNetworkCreateArgs(
  workerNetworkName: string,
  controllerControlDir: string,
): string[] {
  return [
    "network",
    "create",
    "--label",
    `${MANAGED_NETWORK_LABEL}=true`,
    "--label",
    `${CONTROLLER_HEARTBEAT_PATH_LABEL}=${controllerControlDir}/${HEARTBEAT_FILE}`,
    workerNetworkName,
  ];
}

export async function pruneStaleManagedNetworks(options: {
  runDockerCommand: RunDockerCommand;
  runDockerCommandCapture: RunDockerCommandCapture;
  heartbeatTimeoutMs?: number;
}): Promise<void> {
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const existingNetworkNames = await options.runDockerCommandCapture([
    "network",
    "ls",
    "--filter",
    `label=${MANAGED_NETWORK_LABEL}=true`,
    "--format",
    "{{.Name}}",
  ]);

  const networkNames = existingNetworkNames
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  for (const networkName of networkNames) {
    const heartbeatPath = await getManagedNetworkHeartbeatPath(networkName, options.runDockerCommandCapture);

    try {
      if (!heartbeatPath || isHeartbeatFreshSync(heartbeatPath, heartbeatTimeoutMs)) {
        continue;
      }
    } catch {
      // isHeartbeatFreshSync threw — file missing, treat as stale → prune.
    }

    logger.info("mcp.sidecar.network_prune", { networkName });
    await options.runDockerCommand(["network", "rm", networkName], true);
  }
}

async function getManagedNetworkHeartbeatPath(
  networkName: string,
  runDockerCommandCapture: RunDockerCommandCapture,
): Promise<string | null> {
  const labelsJson = await runDockerCommandCapture([
    "network",
    "inspect",
    networkName,
    "--format",
    "{{json .Labels}}",
  ], true);

  const trimmed = labelsJson.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const labels = JSON.parse(trimmed) as Record<string, string | undefined>;
    return labels[CONTROLLER_HEARTBEAT_PATH_LABEL] ?? null;
  } catch {
    logger.warn("mcp.sidecar.network_labels_invalid", {
      networkName,
    });
    return null;
  }
}
