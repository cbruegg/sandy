import { cp, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { PrivilegeRequest, PrivilegeResolutionResult } from "../types.js";

const shareMountPath = "/workspace/share";

export type PrivilegeContext = {
  taskId: string;
  taskSharePath: string;
};

export type SupportedPrivilegeRequest = Extract<
  PrivilegeRequest,
  { type: "copy_into_share" | "copy_out_of_share" }
>;

export interface PrivilegeBroker {
  apply(request: SupportedPrivilegeRequest, context: PrivilegeContext): Promise<PrivilegeResolutionResult>;
}

export class PrivilegeBrokerImpl implements PrivilegeBroker {
  async apply(request: SupportedPrivilegeRequest, context: PrivilegeContext): Promise<PrivilegeResolutionResult> {
    try {
      switch (request.type) {
        case "copy_into_share":
          return await this.copyIntoShare(request, context);
        case "copy_out_of_share":
          return await this.copyOutOfShare(request, context);
      }
    } catch (error) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: error instanceof Error ? error.message : "Privilege operation failed.",
      };
    }
  }

  private async copyIntoShare(
    request: Extract<SupportedPrivilegeRequest, { type: "copy_into_share" }>,
    context: PrivilegeContext,
  ): Promise<PrivilegeResolutionResult> {
    const sourcePath = resolveAbsoluteHostPath(request.sourcePath, "copy_into_share sourcePath");
    const targetPath = resolveSharePath(context.taskSharePath, request.targetPath, "copy_into_share targetPath");

    await mkdir(dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });

    return {
      requestId: request.requestId,
      outcome: "approved",
      message: `Copied ${sourcePath} into the shared workspace at ${request.targetPath}.`,
    };
  }

  private async copyOutOfShare(
    request: Extract<SupportedPrivilegeRequest, { type: "copy_out_of_share" }>,
    context: PrivilegeContext,
  ): Promise<PrivilegeResolutionResult> {
    const sourcePath = resolveSharePath(context.taskSharePath, request.sourcePath, "copy_out_of_share sourcePath");
    const targetPath = resolveAbsoluteHostPath(request.targetPath, "copy_out_of_share targetPath");

    await mkdir(dirname(targetPath), { recursive: true });
    await cp(sourcePath, targetPath, { recursive: true });

    return {
      requestId: request.requestId,
      outcome: "approved",
      message: `Copied ${request.sourcePath} out of the shared workspace to ${targetPath}.`,
    };
  }
}

export function isSupportedPrivilegeRequest(request: PrivilegeRequest): request is SupportedPrivilegeRequest {
  return request.type === "copy_into_share" || request.type === "copy_out_of_share";
}

function resolveAbsoluteHostPath(inputPath: string, fieldName: string): string {
  const expandedPath = expandHomePath(inputPath);
  if (!isAbsolute(expandedPath)) {
    throw new Error(`${fieldName} must be an absolute path.`);
  }
  return resolve(expandedPath);
}

function resolveSharePath(taskSharePath: string, requestPath: string, fieldName: string): string {
  if (!isAbsolute(requestPath)) {
    throw new Error(`${fieldName} must be an absolute path under ${shareMountPath}.`);
  }

  const normalizedRequestPath = resolve(requestPath);
  const relativeToShare = relative(shareMountPath, normalizedRequestPath);
  if (relativeToShare.startsWith("..") || isAbsolute(relativeToShare)) {
    throw new Error(`${fieldName} must stay within ${shareMountPath}.`);
  }

  return resolve(taskSharePath, relativeToShare);
}

function expandHomePath(inputPath: string): string {
  if (inputPath === "~") {
    return homedir();
  }
  if (inputPath.startsWith("~/")) {
    return resolve(homedir(), inputPath.slice(2));
  }
  return inputPath;
}
