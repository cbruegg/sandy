import { isAbsolute, relative, resolve } from "node:path";

export const sharedWorkspaceMountPath = "/workspace/share";

export function resolveSharedWorkspaceRelativePath(sharedPath: string, fieldName: string): string {
  if (!isAbsolute(sharedPath)) {
    throw new Error(`${fieldName} must be an absolute path under ${sharedWorkspaceMountPath}.`);
  }

  const normalizedSharedPath = resolve(sharedPath);
  const relativeToShare = relative(sharedWorkspaceMountPath, normalizedSharedPath);
  if (relativeToShare.startsWith("..") || isAbsolute(relativeToShare)) {
    throw new Error(`${fieldName} must stay within ${sharedWorkspaceMountPath}.`);
  }

  return relativeToShare;
}

/**
 * Convert a worker-visible shared-workspace path such as `/workspace/share/foo.txt`
 * into the corresponding host path inside the current task's mounted share directory.
 */
export function resolveTaskShareHostPath(taskShareHostPath: string, requestedSharedPath: string, fieldName: string): string {
  return resolve(taskShareHostPath, resolveSharedWorkspaceRelativePath(requestedSharedPath, fieldName));
}

export function toSharedWorkspacePath(taskSharePath: string, hostPath: string): string {
  const normalizedTaskSharePath = resolve(taskSharePath);
  const normalizedHostPath = resolve(hostPath);
  const relativeToTaskShare = relative(normalizedTaskSharePath, normalizedHostPath);
  if (relativeToTaskShare.startsWith("..") || isAbsolute(relativeToTaskShare)) {
    throw new Error("Path must stay within the task share.");
  }

  return resolve(sharedWorkspaceMountPath, relativeToTaskShare);
}
