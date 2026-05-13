import type { SandboxHandle } from "./sandbox/sandbox-runner.js";
import type { PrivilegeResolutionResult } from "./types.js";

type PrivilegeResolver = (result: PrivilegeResolutionResult) => void;

export class OrchestratorRuntimeState {
  private readonly handles = new Map<string, SandboxHandle>();
  private readonly pendingMcpPrivilegeResolvers = new Map<string, PrivilegeResolver>();
  private readonly pendingNativeToolResolvers = new Map<string, PrivilegeResolver>();

  registerHandle(taskId: string, handle: SandboxHandle): void {
    this.handles.set(taskId, handle);
  }

  requireHandle(taskId: string): SandboxHandle {
    const handle = this.handles.get(taskId);
    if (!handle) {
      throw new Error(`No sandbox handle is registered for task ${taskId}.`);
    }
    return handle;
  }

  getHandle(taskId: string): SandboxHandle | undefined {
    return this.handles.get(taskId);
  }

  deleteHandle(taskId: string): void {
    this.handles.delete(taskId);
  }

  setPendingMcpPrivilegeResolver(requestId: string, resolve: PrivilegeResolver): void {
    this.pendingMcpPrivilegeResolvers.set(requestId, resolve);
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
