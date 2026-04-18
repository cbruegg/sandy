import {type ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import type {WorkerNetworkConfig} from "../config.js";
import {logger} from "../logger.js";
import {mcpProxyContainerAlias} from "../mcp/proxy-route.js";
import {createInterface} from "node:readline";

const DEFAULT_NETWORK_GUARD_IMAGE = "sandy-network-guard:latest";

export type StartedNetworkGuard = {
  child: ChildProcessWithoutNullStreams;
  containerName: string;
};

type LaunchNetworkGuardOptions = {
  taskId: string;
  workerNetwork: WorkerNetworkConfig;
  networkGuardImage?: string;
  workerNetworkName?: string | null;
  handshakeTimeoutMs: number;
  spawnImpl?: typeof spawn;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  cleanupContainer: (containerName: string) => Promise<void>;
};

export async function launchNetworkGuardContainer(
  options: LaunchNetworkGuardOptions,
): Promise<StartedNetworkGuard | null> {
  if (options.workerNetwork.mode !== "public_internet_only") {
    return null;
  }

  const spawnImpl = options.spawnImpl ?? spawn;
  const setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  const containerName = `sandy-netguard-${options.taskId}`;
  const dockerArgs = [
    "run",
    "--rm",
    "-i",
    "--name",
    containerName,
    "--cap-add",
    "NET_ADMIN",
    "--cap-drop",
    "NET_RAW",
    "-e",
    `SANDY_NETWORK_GUARD_MODE=${options.workerNetwork.mode}`,
    "-e",
    `SANDY_NETWORK_GUARD_ALLOWED_LOCAL_CIDRS=${options.workerNetwork.allowLocalCidrs.join(",")}`,
  ];

  if (options.workerNetworkName) {
    dockerArgs.push(
      "--network",
      options.workerNetworkName,
      "-e",
      `SANDY_NETWORK_GUARD_ALLOWED_HOSTS=${mcpProxyContainerAlias}`,
    );
  }

  dockerArgs.push(options.networkGuardImage ?? DEFAULT_NETWORK_GUARD_IMAGE);

  logger.info("sandbox.network_guard_launching", {
    taskId: options.taskId,
    containerName,
    workerNetworkName: options.workerNetworkName ?? "bridge",
  });

  const child = spawnImpl("docker", dockerArgs, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();

  child.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) {
      logger.warn("sandbox.network_guard_stderr", {
        taskId: options.taskId,
        message,
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const stdout = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    const timer = setTimeoutImpl(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      void options.cleanupContainer(containerName);
      reject(new Error(`Task network guard did not become ready in time for ${options.taskId}.`));
    }, options.handshakeTimeoutMs);

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeoutImpl(timer);
      stdout.close();
      fn();
    };

    stdout.on("line", (line) => {
      if (line.trim() === "ready") {
        finish(resolve);
      }
    });

    child.once("error", (error) => {
      finish(() => reject(error));
    });
    child.once("exit", (code, signal) => {
      finish(() => reject(new Error(`Task network guard exited before ready (code=${code}, signal=${signal}).`)));
    });
  });

  logger.info("sandbox.network_guard_started", {
    taskId: options.taskId,
    containerName,
  });

  return {
    child,
    containerName,
  };
}
