import type {ChildProcessWithoutNullStreams} from "node:child_process";

type BundleId = string;

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
