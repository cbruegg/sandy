import {copyFile, mkdir, mkdtemp, rm} from "node:fs/promises";
import {type ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createInterface} from "node:readline";
import type {WorkerNetworkConfig} from "../config.js";
import {logger, type LogLevel} from "../logger.js";
import {hostMountPath} from "../paths.js";
import {sharedWorkspaceMountPath} from "../shared-workspace.js";
import {workerSkillsPath} from "../subagent/worker-codex-config.js";
import {
  parseHttpProxyContainerMessage,
  serializeHttpProxyHostMessage,
  type HttpProxyAuthRequestMessage,
  type HttpProxyAuthResponseMessage,
} from "../http/http-proxy-protocol.js";
import {launchNetworkGuardContainer, type StartedNetworkGuard} from "./network-guard.js";
import type {TaskBundle, TaskBundleLauncher} from "./task-bundle-types.js";
import {createBundleSharePath} from "./task-bundle-share.js";
import {SANDY_MANAGED_CONTAINER_LABEL} from "./container-label.js";
import {randomUUID} from "node:crypto";
import {SANDY_CODEX_PATH_ENV} from "../codex-client.ts";
import {
  createBundleControlDir,
  removeBundleControlDir,
  startHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  HEARTBEAT_FILE,
  CONTROLLER_CONTROL_MOUNT_PATH,
} from "./heartbeat.js";

const workerCodexSeedMountPath = "/run/sandy-codex-seed";
const workerCodexContainerPath = "/usr/local/bin/codex";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 300_000;
const workerCapabilityArgs = [
  // Keep the worker rootful enough for package managers, sudo, and Homebrew,
  // while dropping every other default Docker capability.
  "--cap-drop", "ALL",
  // Lets root bypass host-managed file mode checks on writable mounts such as
  // /workspace and /root so package managers can update their own state.
  "--cap-add", "DAC_OVERRIDE",
  // Allows tools to change file ownership inside the container.
  "--cap-add", "CHOWN",
  // Allows ownership-sensitive file operations such as preserving writable
  // access while package managers rewrite files they own.
  "--cap-add", "FOWNER",
  // Required by sudo/su to switch credentials from the root container user to
  // another uid when toolchains such as Homebrew invoke them.
  "--cap-add", "SETUID",
  // Required alongside SETUID so sudo/su can also switch group credentials.
  "--cap-add", "SETGID",
] as const;
const proxyCapabilityArgs = [
  // Keep the proxy on the pre-change capability set until we can confirm
  // whether mitmproxy startup on Linux is sensitive to dropping everything.
  "--cap-drop", "NET_ADMIN",
  "--cap-drop", "NET_RAW",
] as const;

export type TaskBundleLauncherOptions = {
  workerImage: string;
  resolveWorkerImage?: () => string;
  networkGuardImage?: string;
  shareRoot: string;
  /** Host-side directory under which per-bundle control directories are created. */
  controlRoot: string;
  codexAuthFile: string | null;
  getSkillsDirectory: () => string | null;
  workerCodexBinaryPath: string;
  workerNetworkName?: string | null;
  workerNetwork: WorkerNetworkConfig;
  httpProxyCaCertPath?: string | null;
  httpProxyConfDirPath?: string | null;
  httpProxyImage?: string | null;
  resolveHttpProxyRequest?: (request: HttpProxyAuthRequestMessage) => Promise<HttpProxyAuthResponseMessage>;
  handshakeTimeoutMs?: number;
  logLevel?: LogLevel;
  spawnImpl?: typeof spawn;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  createHostfsVolume?: (bundleId: string) => Promise<string | null>;
  removeHostfsVolume?: (bundleId: string) => Promise<void>;
};

export class TaskBundleLauncherImpl implements TaskBundleLauncher {
  private readonly handshakeTimeoutMs: number;
  private readonly spawnImpl: typeof spawn;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;

  constructor(private readonly options: TaskBundleLauncherOptions) {
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.setTimeoutImpl = options.setTimeoutImpl ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? clearTimeout;
  }

  async createBundle(): Promise<TaskBundle> {
    const bundleId = randomUUID();
    const shareHostPath = await createBundleSharePath(this.options.shareRoot, bundleId);
    const controlDir = await createBundleControlDir(bundleId, this.options.controlRoot);
    const heartbeat = startHeartbeat(controlDir, HEARTBEAT_INTERVAL_MS, this.setTimeoutImpl, this.clearTimeoutImpl);

    let workerTempDir: string | null = null;
    let workerCodexHomeTempDir: string | null = null;
    const needsWorkerCodexHome = Boolean(this.options.codexAuthFile);
    if (needsWorkerCodexHome) {
      workerTempDir = await mkdtemp(join(tmpdir(), "sandy-worker-launch-"));
      workerCodexHomeTempDir = join(workerTempDir, "codex-home");
      await mkdir(workerCodexHomeTempDir, {recursive: true});
      if (this.options.codexAuthFile) {
        try {
          await copyFile(this.options.codexAuthFile, join(workerCodexHomeTempDir, "auth.json"));
        } catch (error) {
          await rm(workerTempDir, {recursive: true, force: true});
          throw error;
        }
      }
    }

    let tempConfigCleanedUp = false;
    const cleanupWorkerCodexConfig = async (): Promise<void> => {
      if (tempConfigCleanedUp) {
        return;
      }
      tempConfigCleanedUp = true;
      if (workerTempDir) {
        await rm(workerTempDir, {recursive: true, force: true});
      }
    };

    const workerImage = this.resolveWorkerImage();
    const containerName = `sandy-${bundleId}`;

    let hostfsVolumeName: string | null = null;
    if (this.options.createHostfsVolume) {
      try {
        hostfsVolumeName = await this.options.createHostfsVolume(bundleId);
      } catch (error) {
        logger.error("bundle.hostfs_volume_creation_failed", error, String(error), {
          bundleId,
        });
        // Continue without hostfs volume
      }
    }

    logger.info("bundle.creating", {
      bundleId,
      shareHostPath,
      workerImage,
      workerNetworkMode: this.options.workerNetwork.mode,
      hostfsVolumeName,
    });

    const networkGuard = await (async (): Promise<StartedNetworkGuard | null> => {
      try {
        return await this.launchNetworkGuard(bundleId, controlDir);
      } catch (error) {
        heartbeat.stop();
        await removeBundleControlDir(controlDir);
        await cleanupWorkerCodexConfig();
        throw error;
      }
    })();

    let proxyContainerName: string | null = null;
    let proxyChild: ChildProcessWithoutNullStreams | null = null;

    if (this.options.httpProxyImage) {
      if (!networkGuard) {
        throw new Error("HTTP proxy requires a network guard container.");
      }
      assertHttpProxySupportConfigured(this.options);
      proxyContainerName = `sandy-http-proxy-${bundleId}`;
      const proxyDockerArgs = [
        "run",
        "--rm",
        "-i",
        "--name",
        proxyContainerName,
        "--label",
        SANDY_MANAGED_CONTAINER_LABEL,
        "--network",
        `container:${networkGuard.containerName}`,
        ...proxyCapabilityArgs,
        "-v",
        `${this.options.httpProxyConfDirPath}:/run/sandy-mitmproxy-conf:ro`,
        "-v",
        `${controlDir}:${CONTROLLER_CONTROL_MOUNT_PATH}:ro`,
        "-e",
        `SANDY_CONTROLLER_HEARTBEAT_PATH=${CONTROLLER_CONTROL_MOUNT_PATH}/${HEARTBEAT_FILE}`,
        "-e",
        `SANDY_CONTROLLER_HEARTBEAT_TIMEOUT_MS=${HEARTBEAT_TIMEOUT_MS}`,
        "-e",
        "MITMPROXY_CONFDIR=/run/sandy-mitmproxy-conf",
        this.options.httpProxyImage,
      ];

      proxyChild = this.spawnImpl("docker", proxyDockerArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      try {
        await this.attachProxyControlChannelAndWaitForReady(
          proxyChild,
          proxyContainerName,
          async (proxyRequest) => await this.options.resolveHttpProxyRequest!(proxyRequest),
        );
      } catch (error) {
        proxyChild.kill("SIGTERM");
        heartbeat.stop();
        await removeBundleControlDir(controlDir);
        await cleanupWorkerCodexConfig();
        throw error;
      }
    }

    const dockerArgs = [
      "run",
      "--rm",
      "-i",
      "--name",
      containerName,
      "--label",
      SANDY_MANAGED_CONTAINER_LABEL,
      ...workerCapabilityArgs,
    ];

    if (this.options.logLevel) {
      dockerArgs.push("-e", `SANDY_LOG_LEVEL=${this.options.logLevel}`);
    }

    const hostTz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    dockerArgs.push("-e", `TZ=${hostTz}`);

    dockerArgs.push("-e", `${SANDY_CODEX_PATH_ENV}=${workerCodexContainerPath}`);

    if (this.options.httpProxyCaCertPath && this.options.httpProxyImage) {
      dockerArgs.push(
        "-v",
        `${this.options.httpProxyCaCertPath}:/etc/pki/trust/anchors/sandy-ca.pem:ro`,
      );
    }

    if (workerCodexHomeTempDir) {
      dockerArgs.push("-v", `${workerCodexHomeTempDir}:${workerCodexSeedMountPath}:ro`);
    }

    dockerArgs.push("-v", `${this.options.workerCodexBinaryPath}:${workerCodexContainerPath}:ro`);

    const skillsDirectory = this.options.getSkillsDirectory();
    if (skillsDirectory) {
      dockerArgs.push("-v", `${skillsDirectory}:${workerSkillsPath}:ro`);
    }

    if (networkGuard) {
      dockerArgs.push("--network", `container:${networkGuard.containerName}`);
    } else if (this.options.workerNetworkName) {
      dockerArgs.push("--network", this.options.workerNetworkName);
    }

    if (hostfsVolumeName) {
      dockerArgs.push("-v", `${hostfsVolumeName}:${hostMountPath}`);
    }

    dockerArgs.push(
      "-v",
      `${controlDir}:${CONTROLLER_CONTROL_MOUNT_PATH}:ro`,
      "-e",
      `SANDY_CONTROLLER_HEARTBEAT_PATH=${CONTROLLER_CONTROL_MOUNT_PATH}/${HEARTBEAT_FILE}`,
      "-e",
      `SANDY_CONTROLLER_HEARTBEAT_TIMEOUT_MS=${HEARTBEAT_TIMEOUT_MS}`,
    );

    dockerArgs.push("-v", `${shareHostPath}:${sharedWorkspaceMountPath}`, workerImage);

    const child = this.spawnImpl("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    logger.info("bundle.created", {
      bundleId,
      containerName,
      guardContainerName: networkGuard?.containerName ?? null,
      proxyContainerName,
      controlDir,
    });

    const stopHeartbeat = async () => {
      heartbeat.stop();
      await removeBundleControlDir(controlDir);
    };

    return {
      bundleId,
      containerName,
      child,
      guardChild: networkGuard?.child ?? null,
      guardContainerName: networkGuard?.containerName ?? null,
      proxyChild,
      proxyContainerName,
      shareHostPath,
      hostfsVolumeName,
      controlDir,
      stopHeartbeat,
      cleanupWorkerCodexConfig,
    };
  }

  async terminateBundle(bundle: TaskBundle): Promise<void> {
    logger.info("bundle.terminating", {
      bundleId: bundle.bundleId,
      containerName: bundle.containerName,
    });
    // Stop the heartbeat first so containers can self-terminate if we fail.
    await bundle.stopHeartbeat();
    bundle.child.kill("SIGTERM");
    bundle.guardChild?.kill("SIGTERM");
    bundle.proxyChild?.kill("SIGTERM");
    await Promise.all([
      bundle.cleanupWorkerCodexConfig(),
      this.cleanupTaskContainers(bundle.containerName, bundle.guardContainerName, bundle.proxyContainerName),
    ]);
    if (bundle.hostfsVolumeName && this.options.removeHostfsVolume) {
      try {
        await this.options.removeHostfsVolume(bundle.bundleId);
      } catch (error) {
        logger.warn("bundle.hostfs_volume_cleanup_failed", {
          bundleId: bundle.bundleId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    logger.info("bundle.terminated", {
      bundleId: bundle.bundleId,
      containerName: bundle.containerName,
    });
  }

  async destroyBundle(bundle: TaskBundle): Promise<void> {
    await this.terminateBundle(bundle);
    try {
      await rm(bundle.shareHostPath, {recursive: true, force: true});
    } catch (error) {
      logger.warn("bundle.share_cleanup_failed", {
        bundleId: bundle.bundleId,
        shareHostPath: bundle.shareHostPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private resolveWorkerImage(): string {
    return this.options.resolveWorkerImage?.() ?? this.options.workerImage;
  }

  private async launchNetworkGuard(bundleId: string, controlDir: string): Promise<StartedNetworkGuard | null> {
    return await launchNetworkGuardContainer({
      taskId: bundleId,
      workerNetwork: this.options.workerNetwork,
      networkGuardImage: this.options.networkGuardImage,
      workerNetworkName: this.options.workerNetworkName,
      needsNamespaceHolder: Boolean(this.options.httpProxyImage),
      handshakeTimeoutMs: this.handshakeTimeoutMs,
      spawnImpl: this.spawnImpl,
      setTimeoutImpl: this.setTimeoutImpl,
      clearTimeoutImpl: this.clearTimeoutImpl,
      cleanupContainer: async (containerName) => this.cleanupContainer(containerName),
      controlDir,
    });
  }

  private async attachProxyControlChannelAndWaitForReady(
    proxyChild: ChildProcessWithoutNullStreams,
    containerName: string,
    resolveHttpProxyRequest: (request: HttpProxyAuthRequestMessage) => Promise<HttpProxyAuthResponseMessage>,
  ): Promise<void> {
    const proxyStdout = createInterface({
      input: proxyChild.stdout,
      crlfDelay: Infinity,
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = this.setTimeoutImpl(() => {
        if (settled) {
          return;
        }
        settled = true;
        proxyChild.kill("SIGTERM");
        reject(new Error("HTTP proxy container did not become ready in time."));
      }, this.handshakeTimeoutMs);

      proxyStdout.on("line", (line) => {
        try {
          const message = parseHttpProxyContainerMessage(line.trim());
          if (message.type === "log") {
            this.forwardContainerLog(message.level, message.event, message.data, {containerName, source: "http_proxy_container"});
            return;
          }
          if (message.type === "auth_request") {
            void this.handleHttpProxyAuthRequest(proxyChild, resolveHttpProxyRequest, message);
            return;
          }
          if (message.type === "ready") {
            if (settled) {
              return;
            }
            settled = true;
            this.clearTimeoutImpl(timer);
            resolve();
            return;
          }
          if (message.type === "fatal_error") {
            if (settled) {
              return;
            }
            settled = true;
            this.clearTimeoutImpl(timer);
            reject(new Error(message.message ?? "HTTP proxy container failed during startup."));
          }
        } catch (error) {
          logger.error("bundle.http_proxy_protocol_error", error, "Invalid proxy control message.", {
            containerName,
            line: line.trim(),
          });
        }
      });

      proxyChild.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearTimeoutImpl(timer);
        reject(error);
      });

      proxyChild.once("exit", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        this.clearTimeoutImpl(timer);
        reject(new Error(`HTTP proxy container exited before ready (code=${code}, signal=${signal}).`));
      });
    });

    proxyChild.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) {
        logger.warn("bundle.http_proxy_stderr", {
          containerName,
          message,
        });
      }
    });
  }

  private async handleHttpProxyAuthRequest(
    proxyChild: ChildProcessWithoutNullStreams,
    resolveHttpProxyRequest: (request: HttpProxyAuthRequestMessage) => Promise<HttpProxyAuthResponseMessage>,
    request: HttpProxyAuthRequestMessage,
  ): Promise<void> {
    let response: HttpProxyAuthResponseMessage;
    try {
      response = await resolveHttpProxyRequest(request);
    } catch (error) {
      response = {
        type: "auth_response",
        requestId: request.requestId,
        outcome: "failed",
        message: error instanceof Error ? error.message : "Authorization service error.",
      };
    }

    await new Promise<void>((resolve, reject) => {
      proxyChild.stdin.write(serializeHttpProxyHostMessage(response), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private forwardContainerLog(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    data?: Record<string, unknown>,
    extraFields?: Record<string, unknown>,
  ): void {
    const payload = {
      source: "worker",
      ...extraFields,
      ...(data ?? {}),
    };
    switch (level) {
      case "debug":
        logger.debug(event, payload);
        return;
      case "info":
        logger.info(event, payload);
        return;
      case "warn":
        logger.warn(event, payload);
        return;
      case "error":
        logger.error(event, null, undefined, payload);
        return;
    }
  }

  private async cleanupTaskContainers(
    containerName: string,
    guardContainerName: string | null,
    proxyContainerName: string | null,
  ): Promise<void> {
    const containerNames = [containerName];
    if (guardContainerName) {
      containerNames.push(guardContainerName);
    }
    if (proxyContainerName) {
      containerNames.push(proxyContainerName);
    }
    await Promise.all(containerNames.map(async (name) => this.cleanupContainer(name)));
  }

  private async cleanupContainer(containerName: string): Promise<void> {
    await new Promise<void>((resolve) => {
      logger.debug("bundle.force_remove", {
        containerName,
      });
      const child = this.spawnImpl("docker", ["rm", "-f", containerName], {
        stdio: "ignore",
      });
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });
  }
}

function assertHttpProxySupportConfigured(options: TaskBundleLauncherOptions): void {
  if (!options.httpProxyCaCertPath) {
    throw new Error("HTTP proxy image requires httpProxyCaCertPath.");
  }
  if (!options.httpProxyConfDirPath) {
    throw new Error("HTTP proxy image requires httpProxyConfDirPath.");
  }
  if (!options.resolveHttpProxyRequest) {
    throw new Error("HTTP proxy image requires resolveHttpProxyRequest.");
  }
}
