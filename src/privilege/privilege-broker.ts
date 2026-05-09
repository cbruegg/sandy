import {cp, mkdir} from "node:fs/promises";
import {dirname} from "node:path";
import {resolveAbsoluteHostPath} from "../host-paths.js";
import {resolveTaskShareHostPath} from "../shared-workspace.js";
import type {PrivilegedWorkerToolPayload} from "../subagent/worker-tools.js";

type PrivilegeContext = {
  taskId: string;
  taskSharePath: string;
};

export type SupportedPrivilegeRequest = Extract<
  PrivilegedWorkerToolPayload,
  { type: "copy_into_share" | "copy_out_of_share" }
>;

type PrivilegeOperationResult = {
  outcome: "approved" | "failed";
  message: string;
};

export interface PrivilegeBroker {
  apply(request: SupportedPrivilegeRequest, context: PrivilegeContext): Promise<PrivilegeOperationResult>;
}

export class PrivilegeBrokerImpl implements PrivilegeBroker {
  async apply(request: SupportedPrivilegeRequest, context: PrivilegeContext): Promise<PrivilegeOperationResult> {
    try {
      switch (request.type) {
        case "copy_into_share":
          return await this.copyIntoShare(request, context);
        case "copy_out_of_share":
          return await this.copyOutOfShare(request, context);
      }
    } catch (error) {
      return {
        outcome: "failed",
        message: error instanceof Error ? error.message : "Privilege operation failed.",
      };
    }
  }

  private async copyIntoShare(
    request: Extract<SupportedPrivilegeRequest, { type: "copy_into_share" }>,
    context: PrivilegeContext,
  ): Promise<PrivilegeOperationResult> {
    const sourcePath = resolveAbsoluteHostPath(request.sourcePath, "copy_into_share sourcePath");
    const targetPath = resolveTaskShareHostPath(context.taskSharePath, request.targetPath, "copy_into_share targetPath");

    await mkdir(dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });

    return {
      outcome: "approved",
      message: `Copied ${sourcePath} into the shared workspace at ${request.targetPath}.`,
    };
  }

  private async copyOutOfShare(
    request: Extract<SupportedPrivilegeRequest, { type: "copy_out_of_share" }>,
    context: PrivilegeContext,
  ): Promise<PrivilegeOperationResult> {
    const sourcePath = resolveTaskShareHostPath(context.taskSharePath, request.sourcePath, "copy_out_of_share sourcePath");
    const targetPath = resolveAbsoluteHostPath(request.targetPath, "copy_out_of_share targetPath");

    await mkdir(dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });

    return {
      outcome: "approved",
      message: `Copied ${request.sourcePath} out of the shared workspace to ${targetPath}.`,
    };
  }
}

export function isSupportedPrivilegeRequest(request: PrivilegedWorkerToolPayload): request is SupportedPrivilegeRequest {
  return request.type === "copy_into_share" || request.type === "copy_out_of_share";
}
