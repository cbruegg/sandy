import {spawn} from "node:child_process";
import {logger} from "../logger.js";

type HostfsVolumeManagerOptions = {
  volumePrefix?: string;
  webdavBaseUrl: string;
  spawnImpl?: typeof spawn;
};

const DEFAULT_VOLUME_PREFIX = "sandy-hostfs";
const WORKER_MOUNT_PATH = "/workspace/host";

export class HostfsVolumeManager {
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly options: HostfsVolumeManagerOptions) {
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async createVolume(bundleId: string, secret: string): Promise<string> {
    const volumeName = this.buildVolumeName(bundleId);
    const webdavUrl = `${this.options.webdavBaseUrl}/bundles/${bundleId}`;

    logger.info("hostfs.creating_volume", {
      bundleId,
      volumeName,
      webdavUrl,
    });

    try {
      await this.runDockerVolumeCommand([
        "create",
        "-d", "rclone",
        "-o", "type=webdav",
        "-o", `webdav-url=${webdavUrl}`,
        "-o", "webdav-vendor=other",
        "-o", "webdav-user=sandy",
        "-o", `webdav-pass=${secret}`,
        volumeName,
      ]);
    } catch (error) {
      // If the volume already exists, remove and recreate
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("already exists") || message.includes("Volume exists")) {
        logger.warn("hostfs.volume_already_exists", {volumeName});
        await this.removeVolume(bundleId);
        await this.runDockerVolumeCommand([
          "create",
          "-d", "rclone",
          "-o", "type=webdav",
          "-o", `webdav-url=${webdavUrl}`,
          "-o", "webdav-vendor=other",
          "-o", "webdav-user=sandy",
          "-o", `webdav-pass=${secret}`,
          volumeName,
        ]);
      } else {
        throw error;
      }
    }

    logger.info("hostfs.volume_created", {bundleId, volumeName});
    return volumeName;
  }

  async removeVolume(bundleId: string): Promise<void> {
    const volumeName = this.buildVolumeName(bundleId);
    logger.info("hostfs.removing_volume", {bundleId, volumeName});

    try {
      await this.runDockerVolumeCommand(["rm", volumeName]);
      logger.info("hostfs.volume_removed", {bundleId, volumeName});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("No such volume")) {
        logger.warn("hostfs.volume_not_found", {volumeName});
        return;
      }
      throw error;
    }
  }

  getWorkerMountArgs(bundleId: string): string[] {
    const volumeName = this.buildVolumeName(bundleId);
    return ["-v", `${volumeName}:${WORKER_MOUNT_PATH}`];
  }

  private buildVolumeName(bundleId: string): string {
    const prefix = this.options.volumePrefix ?? DEFAULT_VOLUME_PREFIX;
    return `${prefix}-${bundleId}`;
  }

  private runDockerVolumeCommand(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl("docker", ["volume", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Docker volume command failed (code=${code}): ${stderr || stdout}`));
        }
      });

      child.on("error", (error) => {
        reject(error);
      });
    });
  }
}
