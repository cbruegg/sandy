import { randomUUID } from "node:crypto";
import { isSupportedPrivilegeRequest } from "../privilege/privilege-broker.js";
import { resolveTaskShareHostPath } from "../shared-workspace.js";
import { logger } from "../logger.js";
import { messages } from "../messages.js";
import { OrchestratorRuntimeState } from "./runtime-state.js";
import type { SandyOrchestratorDependencies } from "./shared.js";
import { parseWorkerToolPayload } from "../subagent/worker-tools.js";
import type { WorkerToolPayload } from "../subagent/worker-tools.js";
import type { NormalizedChatEvent, PrivilegeRequest, PrivilegeResolutionResult, SessionState } from "../types.js";

export class OrchestratorPrivileges {
  constructor(
    private readonly deps: SandyOrchestratorDependencies,
    private readonly runtimeState: OrchestratorRuntimeState,
    private readonly failActiveTaskFromEventHandling: (
      session: SessionState,
      taskId: string,
      message: string,
    ) => Promise<void>,
  ) {}

  async executeNativeWorkerToolCall(input: {
    taskId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<{ isError: boolean; message: string }> {
    const session = this.deps.sessionStore.getByActiveTaskId(input.taskId);
    if (!session) {
      return {
        isError: true,
        message: messages.taskNotActive(input.taskId),
      };
    }

    const chatId = session.chatId;
    const activeTask = session.activeTask;
    if (!activeTask || activeTask.taskId !== input.taskId) {
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
      const result = await this.executeWorkerToolCall(chatId, session, call);
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
      await this.failActiveTaskFromEventHandling(session, input.taskId, message);
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
        taskSharePath: await this.deps.sandboxRunner.getTaskSharePath(activeTask.taskId),
      });
      result = {
        requestId: request.requestId,
        ...operation,
      };
    }

    if (request.kind === "host_operation" || request.kind === "http_token_use" || request.kind === "host_directory_access" || request.kind === "skill_mutation") {
      if (!this.runtimeState.resolvePendingNativeTool(request.requestId, result)) {
        await this.runtimeState.requireHandle(activeTask.taskId).resolvePrivilege(result);
      }
    } else if (request.kind === "mcp_tool_call" || request.kind === "mcp_resource_read") {
      this.runtimeState.resolvePendingMcpPrivilege(request.requestId, result);
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
      isPersistentAllowed: () => this.deps.persistentApprovalStore.isAlwaysAllowed(input.serverId, input.toolName),
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
      isPersistentAllowed: () => this.deps.persistentApprovalStore.isResourceReadAlwaysAllowed(input.serverId, input.uri),
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
    call: WorkerToolPayload,
  ): Promise<PrivilegeResolutionResult> {
    switch (call.type) {
      case "send_file_to_channel":
        await this.sendSharedFileToUser(chatId, session, call.path, call.caption);
        return {
          requestId: randomUUID(),
          outcome: "approved",
          message: messages.sharedFileSentToUser(call.path),
        };
      case "copy_into_share":
      case "copy_out_of_share":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, {
          kind: "host_operation",
          requestId: randomUUID(),
          payload: call,
        });
      case "request_http_token":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, {
          kind: "http_token_use",
          requestId: randomUUID(),
          tokenId: call.tokenId,
          host: call.host,
          reason: call.reason,
          confirmsAutoApprovalForTask: this.shouldConfirmHttpTokenAutoApprovalForTask(session, call.tokenId, call.host),
        });
      case "request_host_directory_access":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, {
          kind: "host_directory_access",
          requestId: randomUUID(),
          path: call.path,
          level: call.level,
        });
      case "create_skill":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, {
          kind: "skill_mutation",
          requestId: randomUUID(),
          operation: "create",
          skillId: call.skillId,
          name: call.name,
          description: call.description,
          body: call.body,
        });
      case "update_skill":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, {
          kind: "skill_mutation",
          requestId: randomUUID(),
          operation: "update",
          skillId: call.skillId,
          name: call.name,
          description: call.description,
          body: call.body,
        });
      case "delete_skill":
        return await this.awaitNativeToolPrivilegeResolution(chatId, session, {
          kind: "skill_mutation",
          requestId: randomUUID(),
          operation: "delete",
          skillId: call.skillId,
        });
    }

    assertNever(call);
  }

  private async sendSharedFileToUser(
    chatId: string,
    session: SessionState,
    sharePath: string,
    caption?: string,
  ): Promise<void> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return;
    }

    await this.deps.channel.sendFile(
      chatId,
      resolveTaskShareHostPath(await this.deps.sandboxRunner.getTaskSharePath(activeTask.taskId), sharePath, "send_file_to_channel path"),
      caption,
    );
  }

  private async awaitNativeToolPrivilegeResolution(
    chatId: string,
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "host_operation" | "http_token_use" | "host_directory_access" | "skill_mutation" }>,
  ): Promise<PrivilegeResolutionResult> {
    const activeTask = session.activeTask;
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
      const immediateTokenResult = this.tryAuthorizeNativeHttpTokenUse(session, request);
      if (immediateTokenResult) {
        return immediateTokenResult;
      }
    }

    if (request.kind === "host_directory_access") {
      const immediateHostDirectoryResult = await this.tryAuthorizeHostDirectoryAccess(session, request);
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
    await this.deps.channel.sendPrivilegeRequest(chatId, request);

    return await new Promise<PrivilegeResolutionResult>((resolve) => {
      this.runtimeState.setPendingNativeToolResolver(request.requestId, resolve);
    });
  }

  private async grantHostDirectoryAccess(
    activeTask: NonNullable<SessionState["activeTask"]>,
    request: Extract<PrivilegeRequest, { kind: "host_directory_access" }>,
  ): Promise<PrivilegeResolutionResult> {
    const assignment = this.deps.taskBundleAssignmentRegistry.get(activeTask.taskId);
    if (!assignment) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: "No bundle is assigned to this task.",
      };
    }

    if (!assignment.hasHostfsVolume) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.hostDirectoryAccessFailed(request.path, "This task bundle does not have a hostfs mount."),
      };
    }

    const result = await this.deps.hostfsBroker.requestDirectoryAccess(
      assignment.bundleId,
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
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "host_directory_access" }>,
  ): Promise<PrivilegeResolutionResult | null> {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.taskNoLongerActive(session.chatId),
      };
    }

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
      isPersistentAllowed: () => boolean;
      sessionMessage: string;
      persistentMessage: string;
      buildRequest: (requestId: string) => Extract<PrivilegeRequest, { kind: "mcp_tool_call" | "mcp_resource_read" }>;
    },
  ): Promise<PrivilegeResolutionResult> {
    const session = this.deps.sessionStore.getByActiveTaskId(taskId);
    if (!session) {
      return {
        requestId: randomUUID(),
        outcome: "failed",
        message: messages.taskNotActive(taskId),
      };
    }

    const chatId = session.chatId;
    const activeTask = session.activeTask;
    if (!activeTask || activeTask.taskId !== taskId) {
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

    const hasConfiguredAutoApproval = options.isPersistentAllowed();
    if (isMcpAutoApprovalAllowed(activeTask, options.serverId) && hasConfiguredAutoApproval) {
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
    await this.deps.channel.sendPrivilegeRequest(chatId, request);

    return await new Promise<PrivilegeResolutionResult>((resolve) => {
      this.runtimeState.setPendingMcpPrivilegeResolver(request.requestId, resolve);
    });
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
      persist: () => this.deps.persistentApprovalStore.allowTool(request.serverId, request.toolName),
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
      persist: () => this.deps.persistentApprovalStore.allowResourceRead(request.serverId, request.uri),
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
        grantHttpTokenAutoApprovalForTask(activeTask, request.tokenId);
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
    const activeTask = session.activeTask;
    if (!activeTask) {
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
      if (request.operation === "create") {
        await this.deps.skillService.createSkill({
          skillId: request.skillId,
          name: request.name ?? "",
          description: request.description ?? "",
          body: request.body ?? "",
        });
      } else if (request.operation === "update") {
        await this.deps.skillService.updateSkill({
          skillId: request.skillId,
          ...(request.name !== undefined ? { name: request.name } : {}),
          ...(request.description !== undefined ? { description: request.description } : {}),
          ...(request.body !== undefined ? { body: request.body } : {}),
        });
      } else if (request.operation === "delete") {
        await this.deps.skillService.deleteSkill({ skillId: request.skillId });
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

  private tryAuthorizeNativeHttpTokenUse(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "http_token_use" }>,
  ): PrivilegeResolutionResult | null {
    const activeTask = session.activeTask;
    if (!activeTask) {
      return {
        requestId: request.requestId,
        outcome: "failed",
        message: messages.taskNoLongerActive(session.chatId),
      };
    }

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
    tokenId: string,
    host: string,
  ): boolean {
    const activeTask = session.activeTask;
    return activeTask !== null
      && !isHttpTokenAutoApprovalAllowed(activeTask, tokenId)
      && this.deps.persistentApprovalStore.isHttpTokenAlwaysAllowed(tokenId, host);
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
