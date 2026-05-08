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
  hostfsVolumeName: string | null;
  cleanupWorkerCodexConfig: () => Promise<void>;
};

// A task-bound bundle after the pool has reserved it for one specific task.
export type ReservedTaskBundle = TaskBundle & {
  taskId: string;
};

export interface TaskBundleLauncher {
  createBundle(): Promise<TaskBundle>;

  // Stop a bundle that has been assigned to a task, but leave share cleanup to the caller.
  terminateBundle(bundle: TaskBundle): Promise<void>;

  // Tear down a bundle completely, including its bundle-local share directory.
  destroyBundle(bundle: TaskBundle): Promise<void>;
}

export interface TaskBundlePool {
  start(): void;
  acquire(taskId: string): Promise<ReservedTaskBundle>;
  retireBundle(bundle: ReservedTaskBundle): Promise<void>;
  shutdown(): Promise<void>;
}
