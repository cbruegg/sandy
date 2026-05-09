type TaskBundleAssignment = {
  bundleId: string;
  hasHostfsVolume: boolean;
};

export interface TaskBundleAssignmentLookup {
  get(taskId: string): TaskBundleAssignment | null;
}

export class TaskBundleAssignmentRegistry implements TaskBundleAssignmentLookup {
  private readonly assignments = new Map<string, TaskBundleAssignment>();

  activate(taskId: string, bundleId: string, hasHostfsVolume: boolean): void {
    this.assignments.set(taskId, { bundleId, hasHostfsVolume });
  }

  release(taskId: string): void {
    this.assignments.delete(taskId);
  }

  get(taskId: string): TaskBundleAssignment | null {
    return this.assignments.get(taskId) ?? null;
  }
}

export function createNoopTaskBundleAssignmentRegistry(): TaskBundleAssignmentLookup {
  return {
    get: () => null,
  };
}
