import type { SandboxHandle } from "../sandbox/sandbox-runner.js";
import type { PrivilegeResolutionResult } from "../types.js";

type PrivilegeResolver = (result: PrivilegeResolutionResult) => void;

export class ActiveTaskRuntimeRegistry {
  private readonly activeTaskHandles = new Map<string, SandboxHandle>();
  private readonly pendingMcpPrivilegeResolvers = new Map<string, PrivilegeResolver>();
  private readonly pendingNativeToolResolvers = new Map<string, PrivilegeResolver>();

  registerHandle(taskId: string, handle: SandboxHandle): void {
    this.activeTaskHandles.set(taskId, handle);
  }

  requireHandle(taskId: string): SandboxHandle {
    const handle = this.activeTaskHandles.get(taskId);
    if (!handle) {
      throw new Error(`No sandbox handle is registered for task ${taskId}.`);
    }
    return handle;
  }

  getHandle(taskId: string): SandboxHandle | undefined {
    return this.activeTaskHandles.get(taskId);
  }

  async notifyTaskBecameInteractive(taskId: string): Promise<void> {
    await this.requireHandle(taskId).notifyTaskBecameInteractive();
  }

  deleteHandle(taskId: string): void {
    this.activeTaskHandles.delete(taskId);
  }

  setPendingMcpPrivilegeResolver(requestId: string, resolve: PrivilegeResolver): void {
    this.pendingMcpPrivilegeResolvers.set(requestId, resolve);
  }

  deletePendingMcpPrivilegeResolver(requestId: string): void {
    this.pendingMcpPrivilegeResolvers.delete(requestId);
  }

  resolvePendingMcpPrivilege(requestId: string, result: PrivilegeResolutionResult): boolean {
    const resolver = this.pendingMcpPrivilegeResolvers.get(requestId);
    if (!resolver) {
      return false;
    }
    resolver(result);
    this.pendingMcpPrivilegeResolvers.delete(requestId);
    return true;
  }

  setPendingNativeToolResolver(requestId: string, resolve: PrivilegeResolver): void {
    this.pendingNativeToolResolvers.set(requestId, resolve);
  }

  deletePendingNativeToolResolver(requestId: string): void {
    this.pendingNativeToolResolvers.delete(requestId);
  }

  takePendingNativeToolResolver(requestId: string): PrivilegeResolver | undefined {
    const resolver = this.pendingNativeToolResolvers.get(requestId);
    if (!resolver) {
      return undefined;
    }
    this.pendingNativeToolResolvers.delete(requestId);
    return resolver;
  }

  resolvePendingNativeTool(requestId: string, result: PrivilegeResolutionResult): boolean {
    const resolver = this.takePendingNativeToolResolver(requestId);
    if (!resolver) {
      return false;
    }
    resolver(result);
    return true;
  }

}
