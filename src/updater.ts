import { chmod, copyFile, rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";

type BaseUpdaterPlan = {
  targetExecutablePath: string;
  replacementExecutablePath: string;
  backupExecutablePath: string;
  stageDirectory: string;
};

type RelaunchUpdaterPlan = BaseUpdaterPlan & {
  mode: "relaunch";
  waitPid: number;
  relaunchArgs: string[];
  currentWorkingDirectory: string;
};

type ReplaceOnlyUpdaterPlan = BaseUpdaterPlan & {
  mode: "replace-only";
};

type UpdaterPlan = RelaunchUpdaterPlan | ReplaceOnlyUpdaterPlan;

function readUpdaterPlan(): UpdaterPlan {
  const rawPlan = process.env["SANDY_UPDATER_PLAN"];
  if (!rawPlan) {
    throw new Error("Missing SANDY_UPDATER_PLAN.");
  }

  const parsed = JSON.parse(rawPlan) as Partial<UpdaterPlan>;
  if (parsed.mode !== "relaunch" && parsed.mode !== "replace-only") {
    throw new Error("Invalid mode in SANDY_UPDATER_PLAN.");
  }
  if (typeof parsed.targetExecutablePath !== "string" || !parsed.targetExecutablePath) {
    throw new Error("Invalid targetExecutablePath in SANDY_UPDATER_PLAN.");
  }
  if (typeof parsed.replacementExecutablePath !== "string" || !parsed.replacementExecutablePath) {
    throw new Error("Invalid replacementExecutablePath in SANDY_UPDATER_PLAN.");
  }
  if (typeof parsed.backupExecutablePath !== "string" || !parsed.backupExecutablePath) {
    throw new Error("Invalid backupExecutablePath in SANDY_UPDATER_PLAN.");
  }
  if (typeof parsed.stageDirectory !== "string" || !parsed.stageDirectory) {
    throw new Error("Invalid stageDirectory in SANDY_UPDATER_PLAN.");
  }

  if (parsed.mode === "relaunch") {
    if (typeof parsed.waitPid !== "number" || parsed.waitPid <= 0) {
      throw new Error("Invalid waitPid in SANDY_UPDATER_PLAN.");
    }
    if (!Array.isArray(parsed.relaunchArgs) || parsed.relaunchArgs.some((value) => typeof value !== "string")) {
      throw new Error("Invalid relaunchArgs in SANDY_UPDATER_PLAN.");
    }
    if (typeof parsed.currentWorkingDirectory !== "string" || !parsed.currentWorkingDirectory) {
      throw new Error("Invalid currentWorkingDirectory in SANDY_UPDATER_PLAN.");
    }

    return parsed as RelaunchUpdaterPlan;
  }

  return parsed as ReplaceOnlyUpdaterPlan;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  while (isProcessRunning(pid)) {
    await delay(250);
  }
}

async function replaceExecutable(plan: UpdaterPlan): Promise<void> {
  const temporaryExecutablePath = `${plan.targetExecutablePath}.new`;
  await rm(temporaryExecutablePath, { force: true });
  await copyFile(plan.replacementExecutablePath, temporaryExecutablePath);
  if (process.platform !== "win32") {
    await chmod(temporaryExecutablePath, 0o755);
  }

  await rm(plan.backupExecutablePath, { force: true });
  await rename(plan.targetExecutablePath, plan.backupExecutablePath);

  try {
    await rename(temporaryExecutablePath, plan.targetExecutablePath);
  } catch (error) {
    await rm(temporaryExecutablePath, { force: true }).catch(() => {});
    await rename(plan.backupExecutablePath, plan.targetExecutablePath);
    throw error;
  }
}

function relaunchExecutable(plan: RelaunchUpdaterPlan): void {
  const child = spawn(plan.targetExecutablePath, plan.relaunchArgs, {
    cwd: plan.currentWorkingDirectory,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

async function cleanup(plan: UpdaterPlan): Promise<void> {
  await rm(plan.backupExecutablePath, { force: true }).catch(() => {});
  await rm(plan.stageDirectory, { recursive: true, force: true }).catch(() => {});
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function runUpdater(): Promise<void> {
  const plan = readUpdaterPlan();
  if (plan.mode === "relaunch") {
    await waitForProcessExit(plan.waitPid);
  }
  await replaceExecutable(plan);

  if (plan.mode === "relaunch") {
    try {
      relaunchExecutable(plan);
    } catch (error) {
      await rename(plan.backupExecutablePath, plan.targetExecutablePath).catch(() => {});
      throw error;
    }
  }

  await cleanup(plan);
}
