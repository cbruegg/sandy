import { randomUUID } from "node:crypto";
import { isSupportedPrivilegeRequest } from "../privilege/privilege-broker.js";
import { logger } from "../logger.js";
import { messages } from "../messages.js";
import { ActiveTaskRuntimeRegistry } from "./active-task-runtime-registry.js";
import type {OrchestratorCoreDependencies} from "./shared.js";
import { parseWorkerToolPayload } from "../subagent/worker-tools.js";
import type { NativeWorkerToolCallResult, WorkerToolPayload } from "../subagent/worker-tools.js";
import type { ActiveTaskState, NormalizedChatEvent, PrivilegeRequest, PrivilegeResolutionResult, SessionState } from "../types.js";
import type { ChatId } from "../types.js";
import type { WorkerToolsHandler } from "../subagent/worker-tools-handler.js";
import type { JobService } from "../jobs/job-service.js";

export interface OrchestratorPrivileges {
  executeNativeWorkerToolCall(input: {
    taskId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<NativeWorkerToolCallResult>;
  authorizeMcpToolCall(input: {
    taskId: string;
    serverId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<PrivilegeResolutionResult>;
  authorizeMcpResourceRead(input: {
    taskId: string;
    serverId: string;
    uri: string;
  }): Promise<PrivilegeResolutionResult>;
  resolvePendingPrivilegeRequest(
    session: SessionState,
    request: PrivilegeRequest,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<void>;
}

export class OrchestratorPrivilegesImpl implements OrchestratorPrivileges {

  constructor(
    private readonly deps: Omit<OrchestratorCoreDependencies, "channel">,
    private readonly activeTasks: ActiveTaskRuntimeRegistry,
    private readonly workerToolsHandler: WorkerToolsHandler,
    private readonly jobService: JobService,
    private readonly taskFailureHandler: TaskFailureHandler,
  ) {}

  async executeNativeWorkerToolCall(input: {
    taskId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<NativeWorkerToolCallResult> {
    const session = this.deps.sessionStore.getByTaskId(input.taskId);
    if (!session) {
      return {
        isError: true,
        message: messages.taskNotActive(input.taskId),
      };
    }

    const chatId = session.chatId;
    const activeTask = this.deps.taskCoordinator.findTask(session, input.taskId);
    if (!activeTask) {
      return {
        isError: true,
        message: messages.taskNotActive(input.taskId),
      };
    }

    logger.info("task.native_tool_call_executing", {
      chatId,
      taskId: input.taskId,
      toolName: input.toolName,
    });

    let call: WorkerToolPayload;
    try {
      call = parseWorkerToolPayload(input.toolName, input.arguments);
    } catch (error) {
      return {
        isError: true,
        message: error instanceof Error ? error.message : "Invalid Sandy tool payload.",
      };
    }

    try {
      const result = await this.executeWorkerToolCall(chatId, session, activeTask, call);
      logger.info("task.native_tool_call_executed", {
        chatId,
        taskId: input.taskId,
        toolName: input.toolName,
        isError: result.isError,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown native tool execution failure.";
      logger.error("task.native_tool_handler_failed", error, "Unknown native tool execution failure.", {
        chatId,
        taskId: input.taskId,
        toolName: input.toolName,
      });
      await this.taskFailureHandler.failActiveTaskFromEventHandling(session, input.taskId, message);
      return {
        isError: true,
        message,
      };
    }
  }

  async resolvePendingPrivilegeRequest(
    session: SessionState,
    request: PrivilegeRequest,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    let result: PrivilegeResolutionResult;
    if (request.kind === "mcp_tool_call") {
      result = await this.resolvePendingMcpPrivilegeRequest(session, request, decision);
    } else if (request.kind === "mcp_resource_read") {
      result = await this.resolvePendingMcpResourceReadRequest(session, request, decision);
    } else if (request.kind === "http_token_use") {
      result = await this.resolvePendingHttpTokenRequest(session, request, decision);
    } else if (request.kind === "host_directory_access") {
      result = await this.resolvePendingHostDirectoryRequest(session, request, decision);
    } else if (request.kind === "skill_mutation") {
      result = await this.resolvePendingSkillMutationRequest(session, request, decision);
    } else if (request.kind === "job_mutation") {
      result = await this.resolvePendingJobMutationRequest(session, request, decision);
    } else if (decision === "deny") {
      result = {
        requestId: request.requestId,
        outcome: "denied",
        message: messages.userDeniedPrivilegeRequest(request.requestId),
      };
    } else if (!isSupportedPrivilegeRequest(request.payload)) {
      result = this.buildUnsupportedPrivilegeResult(request);
    } else {
      const operation = await this.deps.privilegeBroker.apply(request.payload, {
        taskId: activeTask.taskId,
        taskSharePath: this.activeTasks.requireHandle(activeTask.taskId).getTaskSharePath(),
      });
      result = {
        requestId: request.requestId,
        ...operation,
      };
    }

    if (request.kind === "host_operation" || request.kind === "http_token_use" || request.kind === "host_directory_access" || request.kind === "skill_mutation" || request.kind === "job_mutation") {
      if (!this.activeTasks.resolvePendingNativeTool(request.requestId, result)) {
        await this.activeTasks.requireHandle(activeTask.taskId).resolvePrivilege(result);
      }
    } else if (request.kind === "mcp_tool_call" || request.kind === "mcp_resource_read") {
      this.activeTasks.resolvePendingMcpPrivilege(request.requestId, result);
    }
    await this.sendPrivilegeResolutionMessage(session.chatId, activeTask.taskId, activeTask.taskName, result);

    activeTask.pendingPrivilegeRequest = null;
    activeTask.status = "running";
  }

  async authorizeMcpToolCall(input: {
    taskId: string;
    serverId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<PrivilegeResolutionResult> {
    return this.authorizeMcpRequest(input.taskId, {
      serverId: input.serverId,
      isTaskGrantAllowed: (task) => this.isTaskToolGrantAllowed(task, input.serverId, input.toolName),
      isPersistentAllowed: () => Promise.resolve(this.deps.persistentApprovalStore.isAlwaysAllowed(input.serverId, input.toolName)),
      sessionMessage: messages.mcpToolAllowedForWorkerSession(input.serverId, input.toolName),
      persistentMessage: messages.mcpToolAllowedFromPersistentConfig(input.serverId, input.toolName),
      buildRequest: (requestId) => ({
        kind: "mcp_tool_call" as const,
        requestId,
        serverId: input.serverId,
        toolName: input.toolName,
        arguments: input.arguments,
      }),
    });
  }

  async authorizeMcpResourceRead(input: {
    taskId: string;
    serverId: string;
    uri: string;
  }): Promise<PrivilegeResolutionResult> {
    return this.authorizeMcpRequest(input.taskId, {
      serverId: input.serverId,
      isTaskGrantAllowed: (task) => this.isTaskResourceReadGrantAllowed(task, input.serverId, input.uri),
      isPersistentAllowed: () => Promise.resolve(this.deps.persistentApprovalStore.isResourceReadAlwaysAllowed(input.serverId, input.uri)),
      sessionMessage: messages.mcpResourceReadAllowedForWorkerSession(input.serverId, input.uri),
      persistentMessage: messages.mcpResourceReadAllowedFromPersistentConfig(input.serverId, input.uri),
      buildRequest: (requestId) => ({
        kind: "mcp_resource_read" as const,
        requestId,
        serverId: input.serverId,
        uri: input.uri,
      }),
    });
  }

  private async executeWorkerToolCall(
    chatId: ChatId,
    session: SessionState,
    activeTask: ActiveTaskState,
    call: WorkerToolPayload,
  ): Promise<NativeWorkerToolCallResult> {
    const taskId = activeTask.taskId;

    switch (call.type) {
      case "send_file_to_channel":
        return await this.workerToolsHandler.sendFileToChannel({
          chatId,
          task: activeTask,
          sharePath: call.path,
          caption: call.caption,
        });
      case "request_interaction":
        return await this.workerToolsHandler.requestInteraction({
          chatId,
          task: activeTask,
          message: call.message,
        });
      case "copy_into_share":
      case "copy_out_of_share":
        return this.buildNativeWorkerToolResultFromPrivilegeResolution(await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "host_operation",
          requestId: randomUUID(),
          payload: call,
        }));
      case "request_http_token":
        return this.buildNativeWorkerToolResultFromPrivilegeResolution(await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "http_token_use",
          requestId: randomUUID(),
          tokenId: call.tokenId,
          host: call.host,
          reason: call.reason,
          confirmsAutoApprovalForTask: this.shouldConfirmHttpTokenAutoApprovalForTask(session, taskId, call.tokenId, call.host),
        }));
      case "request_host_directory_access":
        return this.buildNativeWorkerToolResultFromPrivilegeResolution(await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "host_directory_access",
          requestId: randomUUID(),
          path: call.path,
          level: call.level,
        }));
      case "create_skill":
        return this.buildNativeWorkerToolResultFromPrivilegeResolution(await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "skill_mutation",
          requestId: randomUUID(),
          operation: "create",
          skillId: call.skillId,
          name: call.name,
          description: call.description,
          body: call.body,
        }));
      case "update_skill":
        return this.buildNativeWorkerToolResultFromPrivilegeResolution(await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "skill_mutation",
          requestId: randomUUID(),
          operation: "update",
          skillId: call.skillId,
          name: call.name,
          description: call.description,
          body: call.body,
        }));
      case "delete_skill":
        return this.buildNativeWorkerToolResultFromPrivilegeResolution(await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "skill_mutation",
          requestId: randomUUID(),
          operation: "delete",
          skillId: call.skillId,
        }));
      case "list_jobs":
        return await this.workerToolsHandler.listJobs();
      case "get_job": {
        return await this.workerToolsHandler.getJob(call.jobId);
      }
      case "create_job":
        return this.buildNativeWorkerToolResultFromPrivilegeResolution(await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "job_mutation",
          requestId: randomUUID(),
          mutation: { operation: "create", jobId: call.definition.id, definition: call.definition },
        }));
      case "update_job":
        return this.buildNativeWorkerToolResultFromPrivilegeResolution(await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "job_mutation",
          requestId: randomUUID(),
          mutation: { operation: "update", jobId: call.definition.id, definition: call.definition },
        }));
      case "delete_job":
        return this.buildNativeWorkerToolResultFromPrivilegeResolution(await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "job_mutation",
          requestId: randomUUID(),
          mutation: { operation: "delete", jobId: call.jobId },
        }));
      case "enable_job":
        return this.buildNativeWorkerToolResultFromPrivilegeResolution(await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "job_mutation",
          requestId: randomUUID(),
          mutation: { operation: "enable", jobId: call.jobId },
        }));
      case "disable_job":
        return this.buildNativeWorkerToolResultFromPrivilegeResolution(await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "job_mutation",
          requestId: randomUUID(),
          mutation: { operation: "disable", jobId: call.jobId },
        }));
      case "run_job_now":
        return this.buildNativeWorkerToolResultFromPrivilegeResolution(await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "job_mutation",
          requestId: randomUUID(),
          mutation: { operation: "run_now", jobId: call.jobId },
        }));
    }

    assertNever(call);
  }

  private buildNativeWorkerToolResultFromPrivilegeResolution(result: PrivilegeResolutionResult): NativeWorkerToolCallResult {
    return {
      isError: result.outcome !== "approved",
      message: result.message,
    };
  }

  private async awaitNativeToolPrivilegeResolution(
    chatId: ChatId,
    session: SessionState,
    taskId: string,
    request: Extract<PrivilegeRequest, { kind: "host_operation" | "http_token_use" | "host_directory_access" | "skill_mutation" | "job_mutation" }>,
  ): Promise<PrivilegeResolutionResult> {
    const activeTask = this.deps.taskCoordinator.findTask(session, taskId);
    if (!activeTask) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.taskNoLongerActive(chatId),
      };
    }

    if (request.kind === "host_operation" && !isSupportedPrivilegeRequest(request.payload)) {
      return this.buildUnsupportedPrivilegeResult(request);
    }

    if (request.kind === "http_token_use") {
      const immediateTokenResult = this.tryAuthorizeNativeHttpTokenUse(activeTask, request);
      if (immediateTokenResult) {
        return immediateTokenResult;
      }
    }

    if (request.kind === "host_directory_access") {
      const immediateHostDirectoryResult = await this.tryAuthorizeHostDirectoryAccess(activeTask, request);
      if (immediateHostDirectoryResult) {
        return immediateHostDirectoryResult;
      }
    }

    if (activeTask.pendingPrivilegeRequest) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.anotherPrivilegeRequestPendingForTask(),
      };
    }

    activeTask.pendingPrivilegeRequest = request;
    activeTask.status = "awaiting_privilege_decision";
    const resultPromise = new Promise<PrivilegeResolutionResult>((resolve) => {
      this.activeTasks.setPendingNativeToolResolver(request.requestId, resolve);
    });
    await this.deps.taskCoordinator.runJobUserVisibleOperation(chatId, taskId, activeTask.taskName, async (channel) => {
      await channel.sendPrivilegeRequest(chatId, request);
    });

    return await resultPromise;
  }

  private async grantHostDirectoryAccess(
    activeTask: ActiveTaskState,
    request: Extract<PrivilegeRequest, { kind: "host_directory_access" }>,
  ): Promise<PrivilegeResolutionResult> {
    const taskBundle = this.activeTasks.requireHandle(activeTask.taskId).getTaskBundle();
    if (!taskBundle.hostfsVolumeName) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.hostDirectoryAccessFailed(request.path, "This task bundle does not have a hostfs mount."),
      };
    }

    const result = await this.deps.hostfsBroker.requestDirectoryAccess(
      taskBundle.bundleId,
      activeTask.taskId,
      request.path,
      request.level,
    );

    if (!result.ok) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.hostDirectoryAccessFailed(request.path, result.error),
      };
    }

    return {
      requestId: request.requestId,
      outcome: "approved",
      message: `Use the path: ${result.grantPath}`,
    };
  }

  private async resolvePendingHostDirectoryRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "host_directory_access" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<PrivilegeResolutionResult> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.taskNoLongerActive(session.chatId),
      };
    }

    switch (decision) {
      case "deny":
        return {
          requestId: request.requestId,
          outcome: "denied",
          message: messages.hostDirectoryAccessDenied(request.path, request.level),
        };
      case "approve":
      case "approve_once":
      case "approve_worker_session":
        this.grantTaskHostDirectoryAccess(activeTask, request.path, request.level);
        return this.withHostDirectoryGrantMessage(
          await this.grantHostDirectoryAccess(activeTask, request),
          messages.hostDirectoryAccessAllowedForWorkerSession(request.path, request.level),
          "worker_session",
        );
      case "approve_always":
        await this.deps.persistentApprovalStore.allowHostDirectory(request.path, request.level);
        this.grantTaskHostDirectoryAccess(activeTask, request.path, request.level);
        return this.withHostDirectoryGrantMessage(
          await this.grantHostDirectoryAccess(activeTask, request),
          messages.hostDirectoryAccessAllowedAndPersisted(request.path, request.level),
          "always",
        );
      default:
        assertNever(decision);
    }
  }

  private async tryAuthorizeHostDirectoryAccess(
    activeTask: ActiveTaskState,
    request: Extract<PrivilegeRequest, { kind: "host_directory_access" }>,
  ): Promise<PrivilegeResolutionResult | null> {
    if (this.isTaskHostDirectoryAccessAllowed(activeTask, request.path, request.level)) {
      return this.withHostDirectoryGrantMessage(
        await this.grantHostDirectoryAccess(activeTask, request),
        messages.hostDirectoryAccessAllowedForWorkerSession(request.path, request.level),
        "worker_session",
      );
    }

    if (this.deps.persistentApprovalStore.isHostDirectoryAlwaysAllowed(request.path, request.level)) {
      return this.withHostDirectoryGrantMessage(
        await this.grantHostDirectoryAccess(activeTask, request),
        messages.hostDirectoryAccessAllowedFromPersistentConfig(request.path, request.level),
        "always",
      );
    }

    return null;
  }

  private grantTaskHostDirectoryAccess(
    task: ActiveTaskState,
    path: string,
    level: "read_only" | "read_write",
  ): void {
    const existing = task.approvedHostDirectories.find((grant) => grant.path === path);
    if (existing) {
      if (existing.level === "read_write" || level === "read_only") {
        return;
      }
      existing.level = level;
      return;
    }
    task.approvedHostDirectories.push({ path, level });
  }

  private isTaskHostDirectoryAccessAllowed(
    task: ActiveTaskState,
    path: string,
    level: "read_only" | "read_write",
  ): boolean {
    return task.approvedHostDirectories.some(
      (grant) => grant.path === path && (grant.level === "read_write" || level === "read_only"),
    );
  }

  private withHostDirectoryGrantMessage(
    result: PrivilegeResolutionResult,
    message: string,
    scope: Extract<NonNullable<PrivilegeResolutionResult["scope"]>, "worker_session" | "always">,
  ): PrivilegeResolutionResult {
    if (result.outcome !== "approved") {
      return result;
    }

    return {
      ...result,
      message: `${message} ${result.message}`,
      scope,
    };
  }

  private buildUnsupportedPrivilegeResult(
    request: Extract<PrivilegeRequest, { kind: "host_operation" | "mcp_tool_call" | "mcp_resource_read" | "http_token_use" }>,
  ): PrivilegeResolutionResult {
    switch (request.kind) {
      case "host_operation":
        return {
          requestId: request.requestId,
          outcome: "failed",
          message: messages.unsupportedPrivilegeRequestType(request.payload.type),
        };
      case "mcp_tool_call":
        return {
          requestId: request.requestId,
          outcome: "failed",
          message: messages.unsupportedMcpPrivilegeRequest(request.serverId, request.toolName),
        };
      case "mcp_resource_read":
        return {
          requestId: request.requestId,
          outcome: "failed",
          message: messages.unsupportedMcpResourceReadPrivilegeRequest(request.serverId, request.uri),
        };
      case "http_token_use":
        return {
          requestId: request.requestId,
          outcome: "failed",
          message: messages.httpTokenNotConfigured(request.tokenId),
        };
    }
  }

  private async sendPrivilegeResolutionMessage(
    chatId: ChatId,
    taskId: string,
    taskName: string,
    result: PrivilegeResolutionResult,
  ): Promise<void> {
    logger.info("task.privilege_resolved", {
      chatId,
      taskId,
      requestId: result.requestId,
      outcome: result.outcome,
    });

    switch (result.outcome) {
      case "approved":
        return;
      case "denied":
        await this.deps.taskCoordinator.runJobUserVisibleOperation(chatId, taskId, taskName, async (channel) => {
          await channel.sendText(chatId, messages.privilegeDenied(result.requestId));
        });
        return;
      case "failed":
        await this.deps.taskCoordinator.runJobUserVisibleOperation(chatId, taskId, taskName, async (channel) => {
          await channel.sendText(chatId, messages.privilegeFailed(result.requestId, result.message));
        });
        return;
      default:
        assertNever(result.outcome);
    }
  }

  private async authorizeMcpRequest(
    taskId: string,
    options: {
      serverId: string;
      isTaskGrantAllowed: (task: ActiveTaskState) => boolean;
      isPersistentAllowed: () => Promise<boolean>;
      sessionMessage: string;
      persistentMessage: string;
      buildRequest: (requestId: string) => Extract<PrivilegeRequest, { kind: "mcp_tool_call" | "mcp_resource_read" }>;
    },
  ): Promise<PrivilegeResolutionResult> {
    const session = this.deps.sessionStore.getByTaskId(taskId);
    if (!session) {
      return {
        requestId: randomUUID(),
        outcome: "failed",
        message: messages.taskNotActive(taskId),
      };
    }

    const chatId = session.chatId;
    const activeTask = this.deps.taskCoordinator.findTask(session, taskId);
    if (!activeTask) {
      return {
        requestId: randomUUID(),
        outcome: "failed",
        message: messages.taskNotActive(taskId),
      };
    }

    if (options.isTaskGrantAllowed(activeTask)) {
      return {
        requestId: randomUUID(),
        outcome: "approved",
        message: options.sessionMessage,
        scope: "worker_session",
      };
    }

    const hasConfiguredAutoApproval = await options.isPersistentAllowed();
    if (hasConfiguredAutoApproval && isMcpAutoApprovalAllowed(activeTask, options.serverId)) {
      return {
        requestId: randomUUID(),
        outcome: "approved",
        message: options.persistentMessage,
        scope: "always",
      };
    }

    if (activeTask.pendingPrivilegeRequest) {
      return {
        requestId: randomUUID(),
        outcome: "failed",
        message: messages.anotherPrivilegeRequestPendingForTask(),
      };
    }

    const request = {
      ...options.buildRequest(randomUUID()),
      confirmsAutoApprovalForTask: hasConfiguredAutoApproval,
    };
    activeTask.pendingPrivilegeRequest = request;
    activeTask.status = "awaiting_privilege_decision";
    const resultPromise = new Promise<PrivilegeResolutionResult>((resolve) => {
      this.activeTasks.setPendingMcpPrivilegeResolver(request.requestId, resolve);
    });
    await this.deps.taskCoordinator.runJobUserVisibleOperation(chatId, taskId, activeTask.taskName, async (channel) => {
      await channel.sendPrivilegeRequest(chatId, request);
    });

    return await resultPromise;
  }

  private async resolvePendingMcpPrivilegeRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "mcp_tool_call" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<PrivilegeResolutionResult> {
    return this.resolvePendingMcpRequest(session, request, decision, {
      deniedMessage: messages.userDeniedMcpToolCall(request.serverId, request.toolName),
      onceMessage: messages.mcpToolAllowedOnce(request.serverId, request.toolName),
      sessionMessage: messages.mcpToolAllowedForWorkerSession(request.serverId, request.toolName),
      alwaysMessage: messages.mcpToolAllowedAndPersisted(request.serverId, request.toolName),
      persistentMessage: messages.mcpToolAllowedFromPersistentConfig(request.serverId, request.toolName),
      grantAutoApprovalForTask: async (task) => await this.grantMcpAutoApprovalForTask(task, request.serverId),
      grantAccess: (task) => this.grantTaskToolAccess(task, request.serverId, request.toolName),
      persist: async () => await this.deps.persistentApprovalStore.allowTool(request.serverId, request.toolName),
    });
  }

  private async resolvePendingMcpResourceReadRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "mcp_resource_read" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<PrivilegeResolutionResult> {
    return this.resolvePendingMcpRequest(session, request, decision, {
      deniedMessage: messages.userDeniedMcpResourceRead(request.serverId, request.uri),
      onceMessage: messages.mcpResourceReadAllowedOnce(request.serverId, request.uri),
      sessionMessage: messages.mcpResourceReadAllowedForWorkerSession(request.serverId, request.uri),
      alwaysMessage: messages.mcpResourceReadAllowedAndPersisted(request.serverId, request.uri),
      persistentMessage: messages.mcpResourceReadAllowedFromPersistentConfig(request.serverId, request.uri),
      grantAutoApprovalForTask: async (task) => await this.grantMcpAutoApprovalForTask(task, request.serverId),
      grantAccess: (task) => this.grantTaskResourceReadAccess(task, request.serverId, request.uri),
      persist: async () => await this.deps.persistentApprovalStore.allowResourceRead(request.serverId, request.uri),
    });
  }

  private async resolvePendingMcpRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "mcp_tool_call" | "mcp_resource_read" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
    options: {
      deniedMessage: string;
      onceMessage: string;
      sessionMessage: string;
      alwaysMessage: string;
      persistentMessage: string;
      grantAutoApprovalForTask: (task: ActiveTaskState) => Promise<void>;
      grantAccess: (task: ActiveTaskState) => void;
      persist: () => Promise<void>;
    },
  ): Promise<PrivilegeResolutionResult> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.taskNoLongerActive(session.chatId),
      };
    }

    switch (decision) {
      case "deny":
        return {
          requestId: request.requestId,
          outcome: "denied",
          message: options.deniedMessage,
        };
      case "approve":
      case "approve_once":
        if (request.confirmsAutoApprovalForTask) {
          await options.grantAutoApprovalForTask(activeTask);
          return {
            requestId: request.requestId,
            outcome: "approved",
            message: options.persistentMessage,
            scope: "always",
          };
        }
        return {
          requestId: request.requestId,
          outcome: "approved",
          message: options.onceMessage,
          scope: "once",
        };
      case "approve_worker_session":
        if (request.confirmsAutoApprovalForTask) {
          await options.grantAutoApprovalForTask(activeTask);
          return {
            requestId: request.requestId,
            outcome: "approved",
            message: options.persistentMessage,
            scope: "always",
          };
        }
        options.grantAccess(activeTask);
        return {
          requestId: request.requestId,
          outcome: "approved",
          message: options.sessionMessage,
          scope: "worker_session",
        };
      case "approve_always":
        await options.persist();
        await options.grantAutoApprovalForTask(activeTask);
        return {
          requestId: request.requestId,
          outcome: "approved",
          message: options.alwaysMessage,
          scope: "always",
        };
      default:
        assertNever(decision);
    }
  }

  private isTaskToolGrantAllowed(
    task: ActiveTaskState,
    serverId: string,
    toolName: string,
  ): boolean {
    return task.approvedMcpTools.some((entry) => entry.serverId === serverId && entry.toolName === toolName);
  }

  private grantTaskToolAccess(
    task: ActiveTaskState,
    serverId: string,
    toolName: string,
  ): void {
    if (this.isTaskToolGrantAllowed(task, serverId, toolName)) {
      return;
    }
    task.approvedMcpTools.push({ serverId, toolName });
  }

  private isTaskResourceReadGrantAllowed(
    task: ActiveTaskState,
    serverId: string,
    uri: string,
  ): boolean {
    return task.approvedMcpResourceReads.some((entry) => entry.serverId === serverId && entry.uri === uri);
  }

  private grantTaskResourceReadAccess(
    task: ActiveTaskState,
    serverId: string,
    uri: string,
  ): void {
    if (this.isTaskResourceReadGrantAllowed(task, serverId, uri)) {
      return;
    }
    task.approvedMcpResourceReads.push({ serverId, uri });
  }

  private async resolvePendingHttpTokenRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "http_token_use" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<PrivilegeResolutionResult> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.taskNoLongerActive(session.chatId),
      };
    }

    switch (decision) {
      case "deny":
        return {
          requestId: request.requestId,
          outcome: "denied",
          message: messages.httpTokenDenied(request.tokenId, request.host),
        };
      case "approve":
      case "approve_once":
        if (request.confirmsAutoApprovalForTask) {
          await this.grantHttpTokenAutoApprovalForTask(activeTask, request.tokenId);
          return {
            requestId: request.requestId,
            outcome: "approved",
            message: messages.httpTokenAllowedFromPersistentConfig(request.tokenId, request.host),
            scope: "always",
          };
        }
        this.grantHttpTokenOnce(activeTask, request.tokenId, request.host);
        return {
          requestId: request.requestId,
          outcome: "approved",
          message: messages.httpTokenAllowedOnce(request.tokenId, request.host),
          scope: "once",
        };
      case "approve_worker_session":
        if (request.confirmsAutoApprovalForTask) {
          await this.grantHttpTokenAutoApprovalForTask(activeTask, request.tokenId);
          return {
            requestId: request.requestId,
            outcome: "approved",
            message: messages.httpTokenAllowedFromPersistentConfig(request.tokenId, request.host),
            scope: "always",
          };
        }
        this.grantHttpTokenSessionAccess(activeTask, request.tokenId, request.host);
        return {
          requestId: request.requestId,
          outcome: "approved",
          message: messages.httpTokenAllowedForWorkerSession(request.tokenId, request.host),
          scope: "worker_session",
        };
      case "approve_always":
        await this.deps.persistentApprovalStore.allowHttpToken(request.tokenId, request.host);
        await this.grantHttpTokenAutoApprovalForTask(activeTask, request.tokenId);
        return {
          requestId: request.requestId,
          outcome: "approved",
          message: messages.httpTokenAllowedAndPersisted(request.tokenId, request.host),
          scope: "always",
        };
      default:
        assertNever(decision);
    }
  }

  private async resolvePendingSkillMutationRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "skill_mutation" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<PrivilegeResolutionResult> {
    if (!session.activeTask) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.taskNoLongerActive(session.chatId),
      };
    }

    if (decision !== "approve") {
      return {
        requestId: request.requestId,
        outcome: "denied",
        message: messages.skillMutationDenied(request.operation, request.skillId),
      };
    }

    try {
      switch (request.operation) {
        case "create":
          await this.deps.skillService.createSkill({
            skillId: request.skillId,
            name: request.name ?? "",
            description: request.description ?? "",
            body: request.body ?? "",
          });
          break;
        case "update":
          await this.deps.skillService.updateSkill({
            skillId: request.skillId,
            ...(request.name !== undefined ? { name: request.name } : {}),
            ...(request.description !== undefined ? { description: request.description } : {}),
            ...(request.body !== undefined ? { body: request.body } : {}),
          });
          break;
        case "delete":
          await this.deps.skillService.deleteSkill({ skillId: request.skillId });
          break;
        default:
          assertNever(request.operation);
      }

      return {
        requestId: request.requestId,
        outcome: "approved",
        message: messages.skillMutationApproved(request.operation, request.skillId),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown skill mutation failure.";
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.skillMutationFailed(request.operation, request.skillId, detail),
      };
    }
  }

  private async resolvePendingJobMutationRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "job_mutation" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<PrivilegeResolutionResult> {
    if (!session.activeTask) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.taskNoLongerActive(session.chatId),
      };
    }

    const { operation, jobId } = request.mutation;
    if (decision !== "approve") {
      return {
        requestId: request.requestId,
        outcome: "denied",
        message: messages.jobMutationDenied(operation, jobId),
      };
    }

    try {
      const detail = await this.jobService.applyMutation(request.mutation);
      return {
        requestId: request.requestId,
        outcome: "approved",
        message: `${messages.jobMutationApproved(operation, jobId)} ${detail}`,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown job mutation failure.";
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.jobMutationFailed(operation, jobId, detail),
      };
    }
  }

  private tryAuthorizeNativeHttpTokenUse(
    activeTask: ActiveTaskState,
    request: Extract<PrivilegeRequest, { kind: "http_token_use" }>,
  ): PrivilegeResolutionResult | null {

    if (activeTask.approvedHttpTokenSessionGrants.some((entry) => entry.tokenId === request.tokenId && entry.host === request.host)) {
      return {
        requestId: request.requestId,
        outcome: "approved",
        message: messages.httpTokenAllowedForWorkerSession(request.tokenId, request.host),
        scope: "worker_session",
      };
    }

    if (
      isHttpTokenAutoApprovalAllowed(activeTask, request.tokenId)
      && this.deps.persistentApprovalStore.isHttpTokenAlwaysAllowed(request.tokenId, request.host)
    ) {
      return {
        requestId: request.requestId,
        outcome: "approved",
        message: messages.httpTokenAllowedFromPersistentConfig(request.tokenId, request.host),
        scope: "always",
      };
    }

    const onceGrant = activeTask.approvedHttpTokenOnceGrants.find(
      (entry) => entry.tokenId === request.tokenId && entry.host === request.host && !entry.consumed,
    );
    if (!onceGrant) {
      return null;
    }

    onceGrant.consumed = true;
    return {
      requestId: request.requestId,
      outcome: "approved",
      message: messages.httpTokenAllowedOnce(request.tokenId, request.host),
      scope: "once",
    };
  }

  private shouldConfirmHttpTokenAutoApprovalForTask(
    session: SessionState,
    taskId: string,
    tokenId: string,
    host: string,
  ): boolean {
    const activeTask = this.deps.taskCoordinator.findTask(session, taskId);
    return activeTask !== null
      && !isHttpTokenAutoApprovalAllowed(activeTask, tokenId)
      && this.deps.persistentApprovalStore.isHttpTokenAlwaysAllowed(tokenId, host);
  }

  private grantHttpTokenOnce(
    task: ActiveTaskState,
    tokenId: string,
    host: string,
  ): void {
    task.approvedHttpTokenOnceGrants.push({ tokenId, host, consumed: false });
  }

  private grantHttpTokenSessionAccess(
    task: ActiveTaskState,
    tokenId: string,
    host: string,
  ): void {
    if (task.approvedHttpTokenSessionGrants.some((entry) => entry.tokenId === tokenId && entry.host === host)) {
      return;
    }
    task.approvedHttpTokenSessionGrants.push({ tokenId, host });
  }

  private async grantMcpAutoApprovalForTask(
    task: ActiveTaskState,
    serverId: string,
  ): Promise<void> {
    await this.updateTaskPolicy(task, () => {
      if (isMcpAutoApprovalAllowed(task, serverId)) {
        return false;
      }
      task.taskPolicy.autoApproveMcpServers.push(serverId);
      return true;
    });
  }

  private async grantHttpTokenAutoApprovalForTask(
    task: ActiveTaskState,
    tokenId: string,
  ): Promise<void> {
    await this.updateTaskPolicy(task, () => {
      if (isHttpTokenAutoApprovalAllowed(task, tokenId)) {
        return false;
      }
      task.taskPolicy.autoApproveHttpTokens.push(tokenId);
      return true;
    });
  }

  private async updateTaskPolicy(
    task: ActiveTaskState,
    applyMutation: () => boolean,
  ): Promise<void> {
    const changed = applyMutation();
    if (!changed || task.origin.kind !== "launchedByJob") {
      return;
    }
    await this.deps.jobApprovalStore.saveTaskPolicy(task.origin.jobId, task.taskPolicy);
  }
}

export interface TaskFailureHandler {
  failActiveTaskFromEventHandling(session: SessionState, taskId: string, message: string): Promise<void>;
}

function isMcpAutoApprovalAllowed(task: ActiveTaskState, serverId: string): boolean {
  return task.taskPolicy.autoApproveMcpServers.includes(serverId);
}

function isHttpTokenAutoApprovalAllowed(task: ActiveTaskState, tokenId: string): boolean {
  return task.taskPolicy.autoApproveHttpTokens.includes(tokenId);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled main agent decision: ${JSON.stringify(value)}`);
}
