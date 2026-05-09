import {spawn} from "node:child_process";
import {logger} from "../logger.js";

type RclonePluginManagerOptions = {
  pluginName?: string;
  pluginImage?: string;
  pluginConfigDir?: string;
  pluginCacheDir?: string;
  helperImage?: string;
  enableRecovery?: boolean;
  spawnImpl?: typeof spawn;
};

const DEFAULT_PLUGIN_NAME = "rclone";
const DEFAULT_PLUGIN_IMAGE = "rclone/docker-volume-rclone:latest";
const DEFAULT_PLUGIN_CONFIG_DIR = "/var/lib/docker-plugins/rclone/config";
const DEFAULT_PLUGIN_CACHE_DIR = "/var/lib/docker-plugins/rclone/cache";
const DEFAULT_HELPER_IMAGE = "alpine:latest";
const PLUGIN_STATE_FILE_NAME = "docker-plugin.state";
const DEFAULT_ENABLE_PLUGIN_RECOVERY = false;

export class RclonePluginManager {
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly options: RclonePluginManagerOptions = {}) {
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async ensureInstalled(): Promise<void> {
    const pluginName = this.options.pluginName ?? DEFAULT_PLUGIN_NAME;
    const pluginConfigDir = this.options.pluginConfigDir ?? DEFAULT_PLUGIN_CONFIG_DIR;
    const pluginCacheDir = this.options.pluginCacheDir ?? DEFAULT_PLUGIN_CACHE_DIR;

    await this.ensurePluginStateDirectories(pluginConfigDir, pluginCacheDir);

    try {
      await this.ensureInstalledOnce(pluginName, pluginConfigDir, pluginCacheDir);
    } catch (error) {
      if (!this.isRecoveryEnabled() || !this.isRecoverablePluginError(error)) {
        throw error;
      }

      logger.warn("hostfs.rclone_plugin_recovering", {
        pluginName,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.recoverPlugin(pluginName, pluginCacheDir);
      await this.ensureInstalledOnce(pluginName, pluginConfigDir, pluginCacheDir);
    }
  }

  async recover(): Promise<void> {
    const pluginName = this.options.pluginName ?? DEFAULT_PLUGIN_NAME;
    const pluginConfigDir = this.options.pluginConfigDir ?? DEFAULT_PLUGIN_CONFIG_DIR;
    const pluginCacheDir = this.options.pluginCacheDir ?? DEFAULT_PLUGIN_CACHE_DIR;

    await this.ensurePluginStateDirectories(pluginConfigDir, pluginCacheDir);
    await this.recoverPlugin(pluginName, pluginCacheDir);
    await this.ensureInstalledOnce(pluginName, pluginConfigDir, pluginCacheDir);
  }

  isRecoveryEnabled(): boolean {
    return this.options.enableRecovery ?? DEFAULT_ENABLE_PLUGIN_RECOVERY;
  }

  isRecoverablePluginError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("plugin.moby.localhost")
      || message.includes("VolumeDriver.Create")
      || message.includes("VolumeDriver.Get")
      || message.includes("context deadline exceeded")
      || message.includes("Client.Timeout exceeded")
      || message.includes("rclone.sock")
      || message.includes("error looking up volume plugin");
  }

  private async ensureInstalledOnce(pluginName: string, pluginConfigDir: string, pluginCacheDir: string): Promise<void> {
    const isInstalled = await this.isPluginInstalled(pluginName);
    if (isInstalled) {
      const isEnabled = await this.isPluginEnabled(pluginName);
      if (!isEnabled) {
        logger.info("hostfs.rclone_enabling_plugin", {pluginName});
        await this.runDockerPluginCommand(["enable", pluginName]);
      }
      logger.info("hostfs.rclone_plugin_ready", {pluginName});
      return;
    }

    await this.installPlugin(pluginName, pluginConfigDir, pluginCacheDir);
    logger.info("hostfs.rclone_plugin_installed", {pluginName});
  }

  private async installPlugin(pluginName: string, pluginConfigDir: string, pluginCacheDir: string): Promise<void> {
    logger.info("hostfs.rclone_installing_plugin", {
      pluginName,
      pluginImage: this.options.pluginImage ?? DEFAULT_PLUGIN_IMAGE,
    });

    // Install the plugin with grant-all-permissions since it needs mount privileges
    await this.runDockerPluginCommand([
      "install",
      "--grant-all-permissions",
      "--alias",
      pluginName,
      this.options.pluginImage ?? DEFAULT_PLUGIN_IMAGE,
      `config=${pluginConfigDir}`,
      `cache=${pluginCacheDir}`,
    ]).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("already exists")) {
        throw error;
      }

      logger.warn("hostfs.rclone_plugin_already_exists", {pluginName});
      const isEnabled = await this.isPluginEnabled(pluginName);
      if (!isEnabled) {
        logger.info("hostfs.rclone_enabling_plugin", {pluginName});
        await this.runDockerPluginCommand(["enable", pluginName]);
      }
    });
  }

  private async recoverPlugin(pluginName: string, pluginCacheDir: string): Promise<void> {
    logger.warn("hostfs.rclone_plugin_resetting_state", {
      pluginName,
      pluginCacheDir,
      stateFile: `${pluginCacheDir}/${PLUGIN_STATE_FILE_NAME}`,
    });

    await this.runDockerPluginCommand(["disable", "-f", pluginName]).catch(() => {});
    await this.clearPluginStateFile(pluginCacheDir);
    await this.runDockerPluginCommand(["rm", "-f", pluginName]).catch(() => {});
  }

  private async ensurePluginStateDirectories(pluginConfigDir: string, pluginCacheDir: string): Promise<void> {
    logger.info("hostfs.rclone_preparing_plugin_state", {
      pluginConfigDir,
      pluginCacheDir,
      helperImage: this.options.helperImage ?? DEFAULT_HELPER_IMAGE,
    });

    await this.runHelperCommand([
      "run",
      "--rm",
      "-v",
      `${pluginConfigDir}:${pluginConfigDir}`,
      "-v",
      `${pluginCacheDir}:${pluginCacheDir}`,
      this.options.helperImage ?? DEFAULT_HELPER_IMAGE,
      "mkdir",
      "-p",
      pluginConfigDir,
      pluginCacheDir,
    ]);
  }

  private async clearPluginStateFile(pluginCacheDir: string): Promise<void> {
    await this.runHelperCommand([
      "run",
      "--rm",
      "-v",
      `${pluginCacheDir}:${pluginCacheDir}`,
      this.options.helperImage ?? DEFAULT_HELPER_IMAGE,
      "rm",
      "-f",
      `${pluginCacheDir}/${PLUGIN_STATE_FILE_NAME}`,
    ]);
  }

  private async isPluginInstalled(pluginName: string): Promise<boolean> {
    try {
      const output = await this.runDockerPluginCommandOutput(["ls", "--format", "{{.Name}}"]); 
      const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
      return lines.some((line) => this.matchesPluginName(line, pluginName));
    } catch {
      return false;
    }
  }

  private async isPluginEnabled(pluginName: string): Promise<boolean> {
    try {
      const output = await this.runDockerPluginCommandOutput(["ls", "--format", "{{.Name}}:{{.Enabled}}"]);
      const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        const separatorIndex = line.lastIndexOf(":");
        if (separatorIndex === -1) {
          continue;
        }
        const name = line.slice(0, separatorIndex);
        const enabled = line.slice(separatorIndex + 1);
        if (this.matchesPluginName(name, pluginName)) {
          return enabled === "true";
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  private runDockerPluginCommand(args: string[]): Promise<void> {
    return this.runDockerCommand(["plugin", ...args]);
  }

  private matchesPluginName(candidate: string, pluginName: string): boolean {
    return candidate === pluginName || candidate.startsWith(`${pluginName}:`);
  }

  private runHelperCommand(args: string[]): Promise<void> {
    return this.runDockerCommand(args);
  }

  private runDockerCommand(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl("docker", args, {
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
          reject(new Error(`Docker plugin command failed (code=${code}): ${stderr || stdout}`));
        }
      });

      child.on("error", (error) => {
        reject(error);
      });
    });
  }

  private runDockerPluginCommandOutput(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl("docker", ["plugin", ...args], {
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
          resolve(stdout);
        } else {
          reject(new Error(`Docker plugin command failed (code=${code}): ${stderr || stdout}`));
        }
      });

      child.on("error", (error) => {
        reject(error);
      });
    });
  }
}
