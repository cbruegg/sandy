import {spawn} from "node:child_process";
import {logger} from "../logger.js";

type RclonePluginManagerOptions = {
  pluginName?: string;
  pluginImage?: string;
  spawnImpl?: typeof spawn;
};

const DEFAULT_PLUGIN_NAME = "rclone";
const DEFAULT_PLUGIN_IMAGE = "rclone/docker-volume-rclone:latest";

export class RclonePluginManager {
  private readonly spawnImpl: typeof spawn;

  constructor(private readonly options: RclonePluginManagerOptions = {}) {
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async ensureInstalled(): Promise<void> {
    const pluginName = this.options.pluginName ?? DEFAULT_PLUGIN_NAME;

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
    ]);

    logger.info("hostfs.rclone_plugin_installed", {pluginName});
  }

  private async isPluginInstalled(pluginName: string): Promise<boolean> {
    try {
      const output = await this.runDockerPluginCommandOutput(["ls", "--format", "{{.Name}}"]);
      const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
      return lines.includes(pluginName);
    } catch {
      return false;
    }
  }

  private async isPluginEnabled(pluginName: string): Promise<boolean> {
    try {
      const output = await this.runDockerPluginCommandOutput(["ls", "--format", "{{.Name}}:{{.Enabled}}"]);
      const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        const [name, enabled] = line.split(":");
        if (name === pluginName) {
          return enabled === "true";
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  private runDockerPluginCommand(args: string[]): Promise<void> {
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
