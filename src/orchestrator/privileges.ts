import { randomUUID } from "node:crypto";
import { isSupportedPrivilegeRequest } from "../privilege/privilege-broker.js";
import { resolveTaskShareHostPath } from "../shared-workspace.js";
import { logger } from "../logger.js";
import { messages } from "../messages.js";
import { ActiveTaskRuntimeRegistry } from "./active-task-runtime-registry.js";
import type {OrchestratorCoreDependencies} from "./shared.js";
import { parseWorkerToolPayload } from "../subagent/worker-tools.js";
import type { WorkerToolPayload } from "../subagent/worker-tools.js";
import type { NormalizedChatEvent, PrivilegeRequest, PrivilegeResolutionResult, SessionState } from "../types.js";
import type { WorkerToolsHandler } from "./worker-tools-handler.js";

export interface OrchestratorPrivileges {
  executeNativeWorkerToolCall(input: {
    taskId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<{ isError: boolean; message: string }>;
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
    private readonly deps: OrchestratorCoreDependencies,
    private readonly activeTasks: ActiveTaskRuntimeRegistry,
    private readonly workerToolsHandler: WorkerToolsHandler,
    private readonly taskFailureHandler: TaskFailureHandler,
  ) {}

  async executeNativeWorkerToolCall(input: {
    taskId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<{ isError: boolean; message: string }> {
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
      const result = await this.executeWorkerToolCall(chatId, session, input.taskId, call);
      logger.info("task.native_tool_call_executed", {
        chatId,
        taskId: input.taskId,
        toolName: input.toolName,
        outcome: result.outcome,
      });
      return {
        isError: result.outcome !== "approved",
        message: result.message,
      };
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
    this.deps.taskCoordinator.recordTaskActivity(session, activeTask.taskId);
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
    await this.sendPrivilegeResolutionMessage(session.chatId, activeTask.taskId, result);

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
      isPersistentAllowed: async () => await this.isToolAlwaysAllowed(input.serverId, input.toolName),
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
      isPersistentAllowed: async () => await this.isResourceReadAlwaysAllowed(input.serverId, input.uri),
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
    chatId: string,
    session: SessionState,
    taskId: string,
    call: WorkerToolPayload,
  ): Promise<PrivilegeResolutionResult> {
    switch (call.type) {
      case "send_file_to_channel":
        await this.sendSharedFileToUser(chatId, session, taskId, call.path, call.caption);
        return {
          requestId: randomUUID(),
          outcome: "approved",
          message: messages.sharedFileSentToUser(call.path),
        };
      case "copy_into_share":
      case "copy_out_of_share":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "host_operation",
          requestId: randomUUID(),
          payload: call,
        });
      case "request_http_token":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "http_token_use",
          requestId: randomUUID(),
          tokenId: call.tokenId,
          host: call.host,
          reason: call.reason,
          confirmsAutoApprovalForTask: await this.shouldConfirmHttpTokenAutoApprovalForTask(session, taskId, call.tokenId, call.host),
        });
      case "request_host_directory_access":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "host_directory_access",
          requestId: randomUUID(),
          path: call.path,
          level: call.level,
        });
      case "create_skill":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "skill_mutation",
          requestId: randomUUID(),
          operation: "create",
          skillId: call.skillId,
          name: call.name,
          description: call.description,
          body: call.body,
        });
      case "update_skill":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "skill_mutation",
          requestId: randomUUID(),
          operation: "update",
          skillId: call.skillId,
          name: call.name,
          description: call.description,
          body: call.body,
        });
      case "delete_skill":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "skill_mutation",
          requestId: randomUUID(),
          operation: "delete",
          skillId: call.skillId,
        });
      case "list_jobs":
        return await this.workerToolsHandler.listJobs();
      case "get_job":
        return await this.workerToolsHandler.getJob(call.jobId);
      case "create_job":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "job_mutation",
          requestId: randomUUID(),
          mutation: { operation: "create", jobId: call.definition.id, definition: call.definition },
        });
      case "update_job":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "job_mutation",
          requestId: randomUUID(),
          mutation: { operation: "update", jobId: call.definition.id, definition: call.definition },
        });
      case "delete_job":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "job_mutation",
          requestId: randomUUID(),
          mutation: { operation: "delete", jobId: call.jobId },
        });
      case "enable_job":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "job_mutation",
          requestId: randomUUID(),
          mutation: { operation: "enable", jobId: call.jobId },
        });
      case "disable_job":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "job_mutation",
          requestId: randomUUID(),
          mutation: { operation: "disable", jobId: call.jobId },
        });
      case "run_job_now":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, taskId, {
          kind: "job_mutation",
          requestId: randomUUID(),
          mutation: { operation: "run_now", jobId: call.jobId },
        });
    }

    assertNever(call);
  }

  private async sendSharedFileToUser(
    chatId: string,
    session: SessionState,
    taskId: string,
    sharePath: string,
    caption?: string,
  ): Promise<void> {
    const activeTask = this.deps.taskCoordinator.findTask(session, taskId);
    if (!activeTask) {
      return;
    }

    await this.deps.taskCoordinator.runJobUserVisibleOperation(chatId, taskId, activeTask.taskName, async () => {
      await this.deps.channel.sendFile(
        chatId,
        resolveTaskShareHostPath(this.activeTasks.requireHandle(activeTask.taskId).getTaskSharePath(), sharePath, "send_file_to_channel path"),
        caption,
      );
    });
  }

  private async awaitNativeToolPrivilegeResolution(
    chatId: string,
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
      const immediateTokenResult = await this.tryAuthorizeNativeHttpTokenUse(activeTask, request);
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
    await this.deps.taskCoordinator.runJobUserVisibleOperation(chatId, taskId, activeTask.taskName, async () => {
      await this.deps.channel.sendPrivilegeRequest(chatId, request);
    });

    return await resultPromise;
  }

  private async grantHostDirectoryAccess(
    activeTask: NonNullable<SessionState["activeTask"]>,
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
        await this.allowHostDirectory(request.path, request.level);
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
    activeTask: NonNullable<SessionState["activeTask"]>,
    request: Extract<PrivilegeRequest, { kind: "host_directory_access" }>,
  ): Promise<PrivilegeResolutionResult | null> {
    if (this.isTaskHostDirectoryAccessAllowed(activeTask, request.path, request.level)) {
      return this.withHostDirectoryGrantMessage(
        await this.grantHostDirectoryAccess(activeTask, request),
        messages.hostDirectoryAccessAllowedForWorkerSession(request.path, request.level),
        "worker_session",
      );
    }

    if (await this.isHostDirectoryAlwaysAllowed(request.path, request.level)) {
      return this.withHostDirectoryGrantMessage(
        await this.grantHostDirectoryAccess(activeTask, request),
        this.buildPersistentHostDirectoryMessage(request.path, request.level),
        "always",
      );
    }

    return null;
  }

  private grantTaskHostDirectoryAccess(
    task: NonNullable<SessionState["activeTask"]>,
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
    task: NonNullable<SessionState["activeTask"]>,
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
    chatId: string,
    taskId: string,
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
        await this.deps.channel.sendText(chatId, messages.privilegeDenied(result.requestId));
        return;
      case "failed":
        await this.deps.channel.sendText(chatId, messages.privilegeFailed(result.requestId, result.message));
        return;
      default:
        assertNever(result.outcome);
    }
  }

  private async authorizeMcpRequest(
    taskId: string,
    options: {
      serverId: string;
      isTaskGrantAllowed: (task: NonNullable<SessionState["activeTask"]>) => boolean;
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
    if (this.isTaskPersistentMcpApprovalAllowed(activeTask, options.serverId, hasConfiguredAutoApproval)) {
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
    await this.deps.taskCoordinator.runJobUserVisibleOperation(chatId, taskId, activeTask.taskName, async () => {
      await this.deps.channel.sendPrivilegeRequest(chatId, request);
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
      grantAutoApprovalForTask: (task) => grantMcpAutoApprovalForTask(task, request.serverId),
      grantAccess: (task) => this.grantTaskToolAccess(task, request.serverId, request.toolName),
      persist: async () => await this.allowTool(request.serverId, request.toolName),
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
      grantAutoApprovalForTask: (task) => grantMcpAutoApprovalForTask(task, request.serverId),
      grantAccess: (task) => this.grantTaskResourceReadAccess(task, request.serverId, request.uri),
      persist: async () => await this.allowResourceRead(request.serverId, request.uri),
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
      grantAutoApprovalForTask: (task: NonNullable<SessionState["activeTask"]>) => void;
      grantAccess: (task: NonNullable<SessionState["activeTask"]>) => void;
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
          options.grantAutoApprovalForTask(activeTask);
          await this.persistJobTaskPolicy(activeTask);
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
          options.grantAutoApprovalForTask(activeTask);
          await this.persistJobTaskPolicy(activeTask);
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
        options.grantAutoApprovalForTask(activeTask);
        await this.persistJobTaskPolicy(activeTask);
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
    task: NonNullable<SessionState["activeTask"]>,
    serverId: string,
    toolName: string,
  ): boolean {
    return task.approvedMcpTools.some((entry) => entry.serverId === serverId && entry.toolName === toolName);
  }

  private grantTaskToolAccess(
    task: NonNullable<SessionState["activeTask"]>,
    serverId: string,
    toolName: string,
  ): void {
    if (this.isTaskToolGrantAllowed(task, serverId, toolName)) {
      return;
    }
    task.approvedMcpTools.push({ serverId, toolName });
  }

  private isTaskResourceReadGrantAllowed(
    task: NonNullable<SessionState["activeTask"]>,
    serverId: string,
    uri: string,
  ): boolean {
    return task.approvedMcpResourceReads.some((entry) => entry.serverId === serverId && entry.uri === uri);
  }

  private grantTaskResourceReadAccess(
    task: NonNullable<SessionState["activeTask"]>,
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
          grantHttpTokenAutoApprovalForTask(activeTask, request.tokenId);
          await this.persistJobTaskPolicy(activeTask);
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
          grantHttpTokenAutoApprovalForTask(activeTask, request.tokenId);
          await this.persistJobTaskPolicy(activeTask);
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
        await this.allowHttpToken(request.tokenId, request.host);
        grantHttpTokenAutoApprovalForTask(activeTask, request.tokenId);
        await this.persistJobTaskPolicy(activeTask);
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
    return await this.workerToolsHandler.resolveSkillMutation(
      request,
      decision,
      session.activeTask ? null : messages.taskNoLongerActive(session.chatId),
    );
  }

  private async resolvePendingJobMutationRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "job_mutation" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<PrivilegeResolutionResult> {
    return await this.workerToolsHandler.resolveJobMutation(
      request,
      decision,
      session.activeTask ? null : messages.taskNoLongerActive(session.chatId),
    );
  }

  private async tryAuthorizeNativeHttpTokenUse(
    activeTask: NonNullable<SessionState["activeTask"]>,
    request: Extract<PrivilegeRequest, { kind: "http_token_use" }>,
  ): Promise<PrivilegeResolutionResult | null> {

    if (activeTask.approvedHttpTokenSessionGrants.some((entry) => entry.tokenId === request.tokenId && entry.host === request.host)) {
      return {
        requestId: request.requestId,
        outcome: "approved",
        message: messages.httpTokenAllowedForWorkerSession(request.tokenId, request.host),
        scope: "worker_session",
      };
    }

    if (
      this.isTaskPersistentHttpTokenApprovalAllowed(activeTask, request.tokenId)
      && await this.isHttpTokenAlwaysAllowed(request.tokenId, request.host)
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

  private async shouldConfirmHttpTokenAutoApprovalForTask(
    session: SessionState,
    taskId: string,
    tokenId: string,
    host: string,
  ): Promise<boolean> {
    const activeTask = this.deps.taskCoordinator.findTask(session, taskId);
    return activeTask !== null
      && !this.isTaskPersistentHttpTokenApprovalAllowed(activeTask, tokenId)
      && await this.isHttpTokenAlwaysAllowed(tokenId, host);
  }

  private grantHttpTokenOnce(
    task: NonNullable<SessionState["activeTask"]>,
    tokenId: string,
    host: string,
  ): void {
    task.approvedHttpTokenOnceGrants.push({ tokenId, host, consumed: false });
  }

  private grantHttpTokenSessionAccess(
    task: NonNullable<SessionState["activeTask"]>,
    tokenId: string,
    host: string,
  ): void {
    if (task.approvedHttpTokenSessionGrants.some((entry) => entry.tokenId === tokenId && entry.host === host)) {
      return;
    }
    task.approvedHttpTokenSessionGrants.push({ tokenId, host });
  }

  private isTaskPersistentMcpApprovalAllowed(
    task: NonNullable<SessionState["activeTask"]>,
    serverId: string,
    isPersisted: boolean,
  ): boolean {
    return isPersisted && isMcpAutoApprovalAllowed(task, serverId);
  }

  private isTaskPersistentHttpTokenApprovalAllowed(
    task: NonNullable<SessionState["activeTask"]>,
    tokenId: string,
  ): boolean {
    return isHttpTokenAutoApprovalAllowed(task, tokenId);
  }

  private isToolAlwaysAllowed(serverId: string, toolName: string): Promise<boolean> {
    return Promise.resolve(this.deps.persistentApprovalStore.isAlwaysAllowed(serverId, toolName));
  }

  private async allowTool(serverId: string, toolName: string): Promise<void> {
    await this.deps.persistentApprovalStore.allowTool(serverId, toolName);
  }

  private isResourceReadAlwaysAllowed(serverId: string, uri: string): Promise<boolean> {
    return Promise.resolve(this.deps.persistentApprovalStore.isResourceReadAlwaysAllowed(serverId, uri));
  }

  private async allowResourceRead(serverId: string, uri: string): Promise<void> {
    await this.deps.persistentApprovalStore.allowResourceRead(serverId, uri);
  }

  private isHttpTokenAlwaysAllowed(tokenId: string, host: string): Promise<boolean> {
    return Promise.resolve(this.deps.persistentApprovalStore.isHttpTokenAlwaysAllowed(tokenId, host));
  }

  private async allowHttpToken(tokenId: string, host: string): Promise<void> {
    await this.deps.persistentApprovalStore.allowHttpToken(tokenId, host);
  }

  private isHostDirectoryAlwaysAllowed(path: string, level: "read_only" | "read_write"): Promise<boolean> {
    return Promise.resolve(this.deps.persistentApprovalStore.isHostDirectoryAlwaysAllowed(path, level));
  }

  private async allowHostDirectory(path: string, level: "read_only" | "read_write"): Promise<void> {
    await this.deps.persistentApprovalStore.allowHostDirectory(path, level);
  }

  private buildPersistentHostDirectoryMessage(path: string, level: "read_only" | "read_write"): string {
    return messages.hostDirectoryAccessAllowedFromPersistentConfig(path, level);
  }

  private async persistJobTaskPolicy(task: NonNullable<SessionState["activeTask"]>): Promise<void> {
    if (task.origin?.kind !== "launchedByJob") {
      return;
    }
    await this.deps.jobApprovalStore.saveTaskPolicy(task.origin.jobId, task.taskPolicy);
  }
}

export interface TaskFailureHandler {
  failActiveTaskFromEventHandling(session: SessionState, taskId: string, message: string): Promise<void>;
}

function isMcpAutoApprovalAllowed(task: NonNullable<SessionState["activeTask"]>, serverId: string): boolean {
  return task.taskPolicy.autoApproveMcpServers.includes(serverId);
}

function grantMcpAutoApprovalForTask(task: NonNullable<SessionState["activeTask"]>, serverId: string): void {
  if (isMcpAutoApprovalAllowed(task, serverId)) {
    return;
  }
  task.taskPolicy.autoApproveMcpServers.push(serverId);
}

function isHttpTokenAutoApprovalAllowed(task: NonNullable<SessionState["activeTask"]>, tokenId: string): boolean {
  return task.taskPolicy.autoApproveHttpTokens.includes(tokenId);
}

function grantHttpTokenAutoApprovalForTask(task: NonNullable<SessionState["activeTask"]>, tokenId: string): void {
  if (isHttpTokenAutoApprovalAllowed(task, tokenId)) {
    return;
  }
  task.taskPolicy.autoApproveHttpTokens.push(tokenId);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled main agent decision: ${JSON.stringify(value)}`);
}
