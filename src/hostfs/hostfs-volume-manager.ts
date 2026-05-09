import {spawn} from "node:child_process";
import {createCipheriv, randomBytes} from "node:crypto";
import {logger} from "../logger.js";

type HostfsVolumeManagerOptions = {
  volumePrefix?: string;
  webdavBaseUrl: string;
  spawnImpl?: typeof spawn;
};

const DEFAULT_VOLUME_PREFIX = "sandy-hostfs";
const WORKER_MOUNT_PATH = "/workspace/host";
const RCLONE_OBSCURE_KEY = Buffer.from([
  0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d,
  0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
  0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb,
  0xf4, 0xde, 0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38,
]);

export class HostfsVolumeManager {
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly options: HostfsVolumeManagerOptions) {
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async createVolume(bundleId: string, secret: string): Promise<string> {
    const volumeName = this.buildVolumeName(bundleId);
    const webdavUrl = `${this.options.webdavBaseUrl}/bundles/${bundleId}`;
    const obscuredSecret = obscureRclonePassword(secret);

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
        "-o", `webdav-pass=${obscuredSecret}`,
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
          "-o", `webdav-pass=${obscuredSecret}`,
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

function obscureRclonePassword(value: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-ctr", RCLONE_OBSCURE_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString("base64url");
}
