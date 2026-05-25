import { spawn } from "node:child_process";
import { logger } from "../logger.js";
import { SANDY_MANAGED_CONTAINER_LABEL } from "./container-label.js";

export async function cleanupStaleContainers(spawnImpl?: typeof spawn): Promise<void> {
  const spawner = spawnImpl ?? spawn;

  const ids = await listContainerIds(spawner);
  if (ids.length === 0) {
    return;
  }

  logger.info("janitor.stale_containers_found", {
    count: ids.length,
  });

  await Promise.all(ids.map((id) => removeContainer(spawner, id)));
}

async function listContainerIds(spawner: typeof spawn): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawner("docker", ["ps", "-a", "--filter", `label=${SANDY_MANAGED_CONTAINER_LABEL}`, "--format", "{{.ID}}"], {
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

    child.once("error", (error) => {
      reject(error);
    });
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(
          stdout
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        );
      } else {
        reject(new Error(`docker ps failed (code=${code}): ${stderr || stdout}`));
      }
    });
  });
}

async function removeContainer(spawner: typeof spawn, id: string): Promise<void> {
  return new Promise<void>((resolve) => {
    logger.info("janitor.removing_stale_container", { containerId: id });

    const child = spawner("docker", ["rm", "-f", id], {
      stdio: "ignore",
    });

    child.once("error", (error) => {
      logger.error("janitor.removal_failed", error, String(error), {
        containerId: id,
      });
      resolve();
    });
    child.once("exit", (code) => {
      if (code === 0) {
        logger.info("janitor.removal_succeeded", { containerId: id });
      } else {
        logger.warn("janitor.removal_exit_code", {
          containerId: id,
          code,
        });
      }
      resolve();
    });
  });
}
