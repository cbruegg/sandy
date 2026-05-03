import type {ChildProcessWithoutNullStreams} from "node:child_process";

type BundleId = string;

// A warmed or active worker bundle before the host has assigned it to a task.
export type TaskBundle = {
  bundleId: BundleId;
  containerName: string;
  child: ChildProcessWithoutNullStreams;
  guardChild: ChildProcessWithoutNullStreams | null;
  guardContainerName: string | null;
  proxyChild: ChildProcessWithoutNullStreams | null;
  proxyContainerName: string | null;
  shareHostPath: string;
  cleanupWorkerCodexConfig: () => Promise<void>;
};

// A task-bound bundle after the pool has reserved it for one specific task.
export type ReservedTaskBundle = TaskBundle & {
  taskId: string;
};

export interface TaskBundleLauncher {
  createBundle(): Promise<TaskBundle>;
  terminateBundle(bundle: TaskBundle): Promise<void>;
  destroyBundle(bundle: TaskBundle): Promise<void>;
}

export interface TaskBundlePool {
  start(): Promise<void>;
  acquire(taskId: string): Promise<ReservedTaskBundle>;
  retireBundle(bundle: ReservedTaskBundle): Promise<void>;
  shutdown(): Promise<void>;
}
