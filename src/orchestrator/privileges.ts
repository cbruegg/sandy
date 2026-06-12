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
import {
  approvedPrivilegeResult,
  buildUnsupportedPrivilegeResult,
  deniedPrivilegeResult,
  failedPrivilegeResult,
  isMcpPrivilegeRequest,
  isNativeToolPrivilegeRequest,
  toNativeWorkerToolCallResult,
  withHostDirectoryGrantMessage,
} from "./privilege-results.js";
import type { NativeToolPrivilegeRequest } from "./privilege-results.js";
import {
  grantHttpTokenOnce,
  grantHttpTokenSessionAccess,
  grantHttpTokenAutoApprovalForTask,
  grantMcpAutoApprovalForTask,
  grantTaskHostDirectoryAccess,
  grantTaskResourceReadAccess,
  grantTaskToolAccess,
  isHttpTokenAutoApprovalAllowed,
  isMcpAutoApprovalAllowed,
  isTaskHostDirectoryAccessAllowed,
  isTaskResourceReadGrantAllowed,
  isTaskToolGrantAllowed,
} from "./task-grants.js";

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
    private readonly taskFailureHandler: TaskFailureHandler,
  ) {}

  async executeNativeWorkerToolCall(input: {
    taskId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<NativeWorkerToolCallResult> {
    const taskContext = this.getTaskContext(input.taskId);
    if (!taskContext) {
      return {
        isError: true,
        message: messages.taskNotActive(input.taskId),
      };
    }

    const { session, chatId, activeTask } = taskContext;

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
    switch (request.kind) {
      case "mcp_tool_call":
        result = await this.resolvePendingMcpPrivilegeRequest(session, request, decision);
        break;
      case "mcp_resource_read":
        result = await this.resolvePendingMcpResourceReadRequest(session, request, decision);
        break;
      case "http_token_use":
        result = await this.resolvePendingHttpTokenRequest(session, request, decision);
        break;
      case "host_directory_access":
        result = await this.resolvePendingHostDirectoryRequest(session, request, decision);
        break;
      case "skill_mutation":
        result = await this.resolvePendingSkillMutationRequest(session, request, decision);
        break;
      case "job_mutation":
        result = await this.resolvePendingJobMutationRequest(session, request, decision);
        break;
      case "host_operation": {
        if (decision === "deny") {
          result = deniedPrivilegeResult(request.requestId, messages.userDeniedPrivilegeRequest(request.requestId));
          break;
        }
        if (!isSupportedPrivilegeRequest(request.payload)) {
          result = buildUnsupportedPrivilegeResult(request);
          break;
        }
        const operation = await this.deps.privilegeBroker.apply(request.payload, {
          taskId: activeTask.taskId,
          taskSharePath: this.activeTasks.requireHandle(activeTask.taskId).getTaskSharePath(),
        });
        result = {
          requestId: request.requestId,
          ...operation,
        };
        break;
      }
      default:
        assertNever(request);
    }

    if (isNativeToolPrivilegeRequest(request)) {
      if (!this.activeTasks.resolvePendingNativeTool(request.requestId, result)) {
        await this.activeTasks.requireHandle(activeTask.taskId).resolvePrivilege(result);
      }
    } else if (isMcpPrivilegeRequest(request)) {
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
      isTaskGrantAllowed: (task) => isTaskToolGrantAllowed(task, input.serverId, input.toolName),
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
      isTaskGrantAllowed: (task) => isTaskResourceReadGrantAllowed(task, input.serverId, input.uri),
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
      case "request_http_token":
      case "request_host_directory_access":
      case "create_skill":
      case "update_skill":
      case "delete_skill":
      case "create_job":
      case "update_job":
      case "delete_job":
      case "enable_job":
      case "disable_job":
      case "run_job_now": {
        const result = await this.awaitNativeToolPrivilegeResolution(
          chatId,
          session,
          taskId,
          (requestId) => this.buildNativeToolPrivilegeRequest(session, taskId, call, requestId),
        );
        return toNativeWorkerToolCallResult(result);
      }
      case "list_jobs":
        return await this.workerToolsHandler.listJobs();
      case "get_job": {
        return await this.workerToolsHandler.getJob(call.jobId);
      }
    }

    assertNever(call);
  }

  private async awaitNativeToolPrivilegeResolution(
    chatId: ChatId,
    session: SessionState,
    taskId: string,
    buildRequest: (requestId: string) => NativeToolPrivilegeRequest,
  ): Promise<PrivilegeResolutionResult> {
    const request = buildRequest(randomUUID());
    const activeTask = this.deps.taskCoordinator.findTask(session, taskId);
    if (!activeTask) {
      return failedPrivilegeResult(request.requestId, messages.taskNoLongerActive(chatId));
    }

    if (request.kind === "host_operation" && !isSupportedPrivilegeRequest(request.payload)) {
      return buildUnsupportedPrivilegeResult(request);
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
      return failedPrivilegeResult(request.requestId, messages.anotherPrivilegeRequestPendingForTask());
    }

    return await this.enqueuePrivilegeRequest({
      chatId,
      taskId,
      activeTask,
      request,
      registerResolver: (requestId, resolve) => {
        this.activeTasks.setPendingNativeToolResolver(requestId, resolve);
      },
    });
  }

  private async grantHostDirectoryAccess(
    activeTask: ActiveTaskState,
    request: Extract<PrivilegeRequest, { kind: "host_directory_access" }>,
  ): Promise<PrivilegeResolutionResult> {
    const taskBundle = this.activeTasks.requireHandle(activeTask.taskId).getTaskBundle();
    if (!taskBundle.hostfsVolumeName) {
      return failedPrivilegeResult(
        request.requestId,
        messages.hostDirectoryAccessFailed(request.path, "This task bundle does not have a hostfs mount."),
      );
    }

    const result = await this.deps.hostfsBroker.requestDirectoryAccess(
      taskBundle.bundleId,
      activeTask.taskId,
      request.path,
      request.level,
    );

    if (!result.ok) {
      return failedPrivilegeResult(request.requestId, messages.hostDirectoryAccessFailed(request.path, result.error));
    }

    return approvedPrivilegeResult(request.requestId, `Use the path: ${result.grantPath}`);
  }

  private async resolvePendingHostDirectoryRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "host_directory_access" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<PrivilegeResolutionResult> {
    const activeTask = this.requireSessionActiveTask(session, request.requestId);
    if ("result" in activeTask) {
      return activeTask.result;
    }

    switch (decision) {
      case "deny":
        return deniedPrivilegeResult(request.requestId, messages.hostDirectoryAccessDenied(request.path, request.level));
      case "approve":
      case "approve_once":
      case "approve_worker_session":
        grantTaskHostDirectoryAccess(activeTask.activeTask, request.path, request.level);
        return withHostDirectoryGrantMessage(
          await this.grantHostDirectoryAccess(activeTask.activeTask, request),
          messages.hostDirectoryAccessAllowedForWorkerSession(request.path, request.level),
          "worker_session",
        );
      case "approve_always":
        await this.deps.persistentApprovalStore.allowHostDirectory(request.path, request.level);
        grantTaskHostDirectoryAccess(activeTask.activeTask, request.path, request.level);
        return withHostDirectoryGrantMessage(
          await this.grantHostDirectoryAccess(activeTask.activeTask, request),
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
    if (isTaskHostDirectoryAccessAllowed(activeTask, request.path, request.level)) {
      return withHostDirectoryGrantMessage(
        await this.grantHostDirectoryAccess(activeTask, request),
        messages.hostDirectoryAccessAllowedForWorkerSession(request.path, request.level),
        "worker_session",
      );
    }

    if (this.deps.persistentApprovalStore.isHostDirectoryAlwaysAllowed(request.path, request.level)) {
      return withHostDirectoryGrantMessage(
        await this.grantHostDirectoryAccess(activeTask, request),
        messages.hostDirectoryAccessAllowedFromPersistentConfig(request.path, request.level),
        "always",
      );
    }

    return null;
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
    const taskContext = this.getTaskContext(taskId);
    if (!taskContext) {
      return failedPrivilegeResult(randomUUID(), messages.taskNotActive(taskId));
    }

    const { chatId, activeTask } = taskContext;

    if (options.isTaskGrantAllowed(activeTask)) {
      return approvedPrivilegeResult(randomUUID(), options.sessionMessage, "worker_session");
    }

    const hasConfiguredAutoApproval = await options.isPersistentAllowed();
    if (hasConfiguredAutoApproval && isMcpAutoApprovalAllowed(activeTask, options.serverId)) {
      return approvedPrivilegeResult(randomUUID(), options.persistentMessage, "always");
    }

    return await this.enqueuePrivilegeRequest({
      chatId,
      taskId,
      activeTask,
      request: {
        ...options.buildRequest(randomUUID()),
        confirmsAutoApprovalForTask: hasConfiguredAutoApproval,
      },
      registerResolver: (requestId, resolve) => {
        this.activeTasks.setPendingMcpPrivilegeResolver(requestId, resolve);
      },
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
      grantAutoApprovalForTask: async (task) => await grantMcpAutoApprovalForTask(this.deps.jobApprovalStore, task, request.serverId),
      grantAccess: (task) => grantTaskToolAccess(task, request.serverId, request.toolName),
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
      grantAutoApprovalForTask: async (task) => await grantMcpAutoApprovalForTask(this.deps.jobApprovalStore, task, request.serverId),
      grantAccess: (task) => grantTaskResourceReadAccess(task, request.serverId, request.uri),
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
    const activeTask = this.requireSessionActiveTask(session, request.requestId);
    if ("result" in activeTask) {
      return activeTask.result;
    }

    switch (decision) {
      case "deny":
        return deniedPrivilegeResult(request.requestId, options.deniedMessage);
      case "approve":
      case "approve_once":
        if (request.confirmsAutoApprovalForTask) {
          await options.grantAutoApprovalForTask(activeTask.activeTask);
          return approvedPrivilegeResult(request.requestId, options.persistentMessage, "always");
        }
        return approvedPrivilegeResult(request.requestId, options.onceMessage, "once");
      case "approve_worker_session":
        if (request.confirmsAutoApprovalForTask) {
          await options.grantAutoApprovalForTask(activeTask.activeTask);
          return approvedPrivilegeResult(request.requestId, options.persistentMessage, "always");
        }
        options.grantAccess(activeTask.activeTask);
        return approvedPrivilegeResult(request.requestId, options.sessionMessage, "worker_session");
      case "approve_always":
        await options.persist();
        await options.grantAutoApprovalForTask(activeTask.activeTask);
        return approvedPrivilegeResult(request.requestId, options.alwaysMessage, "always");
      default:
        assertNever(decision);
    }
  }

  private async resolvePendingHttpTokenRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "http_token_use" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<PrivilegeResolutionResult> {
    const activeTask = this.requireSessionActiveTask(session, request.requestId);
    if ("result" in activeTask) {
      return activeTask.result;
    }

    switch (decision) {
      case "deny":
        return deniedPrivilegeResult(request.requestId, messages.httpTokenDenied(request.tokenId, request.host));
      case "approve":
      case "approve_once":
        if (request.confirmsAutoApprovalForTask) {
          await grantHttpTokenAutoApprovalForTask(this.deps.jobApprovalStore, activeTask.activeTask, request.tokenId);
          return approvedPrivilegeResult(
            request.requestId,
            messages.httpTokenAllowedFromPersistentConfig(request.tokenId, request.host),
            "always",
          );
        }
        grantHttpTokenOnce(activeTask.activeTask, request.tokenId, request.host);
        return approvedPrivilegeResult(request.requestId, messages.httpTokenAllowedOnce(request.tokenId, request.host), "once");
      case "approve_worker_session":
        if (request.confirmsAutoApprovalForTask) {
          await grantHttpTokenAutoApprovalForTask(this.deps.jobApprovalStore, activeTask.activeTask, request.tokenId);
          return approvedPrivilegeResult(
            request.requestId,
            messages.httpTokenAllowedFromPersistentConfig(request.tokenId, request.host),
            "always",
          );
        }
        grantHttpTokenSessionAccess(activeTask.activeTask, request.tokenId, request.host);
        return approvedPrivilegeResult(
          request.requestId,
          messages.httpTokenAllowedForWorkerSession(request.tokenId, request.host),
          "worker_session",
        );
      case "approve_always":
        await this.deps.persistentApprovalStore.allowHttpToken(request.tokenId, request.host);
        await grantHttpTokenAutoApprovalForTask(this.deps.jobApprovalStore, activeTask.activeTask, request.tokenId);
        return approvedPrivilegeResult(
          request.requestId,
          messages.httpTokenAllowedAndPersisted(request.tokenId, request.host),
          "always",
        );
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
      return failedPrivilegeResult(request.requestId, messages.taskNoLongerActive(session.chatId));
    }

    if (decision !== "approve") {
      return deniedPrivilegeResult(request.requestId, messages.skillMutationDenied(request.operation, request.skillId));
    }

    try {
      await this.workerToolsHandler.applySkillMutation({
        operation: request.operation,
        skillId: request.skillId,
        name: request.name,
        description: request.description,
        body: request.body,
      });
      return approvedPrivilegeResult(request.requestId, messages.skillMutationApproved(request.operation, request.skillId));
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown skill mutation failure.";
      return failedPrivilegeResult(
        request.requestId,
        messages.skillMutationFailed(request.operation, request.skillId, detail),
      );
    }
  }

  private async resolvePendingJobMutationRequest(
    session: SessionState,
    request: Extract<PrivilegeRequest, { kind: "job_mutation" }>,
    decision: Extract<NormalizedChatEvent, { kind: "approval_response" }>["decision"],
  ): Promise<PrivilegeResolutionResult> {
    if (!session.activeTask) {
      return failedPrivilegeResult(request.requestId, messages.taskNoLongerActive(session.chatId));
    }

    const { operation, jobId } = request.mutation;
    if (decision !== "approve") {
      return deniedPrivilegeResult(request.requestId, messages.jobMutationDenied(operation, jobId));
    }

    try {
      const detail = await this.workerToolsHandler.applyJobMutation(request.mutation);
      return approvedPrivilegeResult(request.requestId, `${messages.jobMutationApproved(operation, jobId)} ${detail}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown job mutation failure.";
      return failedPrivilegeResult(request.requestId, messages.jobMutationFailed(operation, jobId, detail));
    }
  }

  private tryAuthorizeNativeHttpTokenUse(
    activeTask: ActiveTaskState,
    request: Extract<PrivilegeRequest, { kind: "http_token_use" }>,
  ): PrivilegeResolutionResult | null {

    if (activeTask.approvedHttpTokenSessionGrants.some((entry) => entry.tokenId === request.tokenId && entry.host === request.host)) {
      return approvedPrivilegeResult(
        request.requestId,
        messages.httpTokenAllowedForWorkerSession(request.tokenId, request.host),
        "worker_session",
      );
    }

    if (
      isHttpTokenAutoApprovalAllowed(activeTask, request.tokenId)
      && this.deps.persistentApprovalStore.isHttpTokenAlwaysAllowed(request.tokenId, request.host)
    ) {
      return approvedPrivilegeResult(
        request.requestId,
        messages.httpTokenAllowedFromPersistentConfig(request.tokenId, request.host),
        "always",
      );
    }

    const onceGrant = activeTask.approvedHttpTokenOnceGrants.find(
      (entry) => entry.tokenId === request.tokenId && entry.host === request.host && !entry.consumed,
    );
    if (!onceGrant) {
      return null;
    }

    onceGrant.consumed = true;
    return approvedPrivilegeResult(request.requestId, messages.httpTokenAllowedOnce(request.tokenId, request.host), "once");
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

  private buildNativeToolPrivilegeRequest(
    session: SessionState,
    taskId: string,
    call: Extract<WorkerToolPayload, {
      type:
        | "copy_into_share"
        | "copy_out_of_share"
        | "request_http_token"
        | "request_host_directory_access"
        | "create_skill"
        | "update_skill"
        | "delete_skill"
        | "create_job"
        | "update_job"
        | "delete_job"
        | "enable_job"
        | "disable_job"
        | "run_job_now";
    }>,
    requestId: string,
  ): NativeToolPrivilegeRequest {
    switch (call.type) {
      case "copy_into_share":
      case "copy_out_of_share":
        return {
          kind: "host_operation",
          requestId,
          payload: call,
        };
      case "request_http_token":
        return {
          kind: "http_token_use",
          requestId,
          tokenId: call.tokenId,
          host: call.host,
          reason: call.reason,
          confirmsAutoApprovalForTask: this.shouldConfirmHttpTokenAutoApprovalForTask(session, taskId, call.tokenId, call.host),
        };
      case "request_host_directory_access":
        return {
          kind: "host_directory_access",
          requestId,
          path: call.path,
          level: call.level,
        };
      case "create_skill":
        return {
          kind: "skill_mutation",
          requestId,
          operation: "create",
          skillId: call.skillId,
          name: call.name,
          description: call.description,
          body: call.body,
        };
      case "update_skill":
        return {
          kind: "skill_mutation",
          requestId,
          operation: "update",
          skillId: call.skillId,
          name: call.name,
          description: call.description,
          body: call.body,
        };
      case "delete_skill":
        return {
          kind: "skill_mutation",
          requestId,
          operation: "delete",
          skillId: call.skillId,
        };
      case "create_job":
        return {
          kind: "job_mutation",
          requestId,
          mutation: { operation: "create", jobId: call.definition.id, definition: call.definition },
        };
      case "update_job":
        return {
          kind: "job_mutation",
          requestId,
          mutation: { operation: "update", jobId: call.definition.id, definition: call.definition },
        };
      case "delete_job":
        return {
          kind: "job_mutation",
          requestId,
          mutation: { operation: "delete", jobId: call.jobId },
        };
      case "enable_job":
        return {
          kind: "job_mutation",
          requestId,
          mutation: { operation: "enable", jobId: call.jobId },
        };
      case "disable_job":
        return {
          kind: "job_mutation",
          requestId,
          mutation: { operation: "disable", jobId: call.jobId },
        };
      case "run_job_now":
        return {
          kind: "job_mutation",
          requestId,
          mutation: { operation: "run_now", jobId: call.jobId },
        };
      default:
        return assertNever(call);
    }
  }

  private getTaskContext(taskId: string): { session: SessionState; chatId: ChatId; activeTask: ActiveTaskState } | null {
    const session = this.deps.sessionStore.getByTaskId(taskId);
    if (!session) {
      return null;
    }

    const activeTask = this.deps.taskCoordinator.findTask(session, taskId);
    if (!activeTask) {
      return null;
    }

    return {
      session,
      chatId: session.chatId,
      activeTask,
    };
  }

  private requireSessionActiveTask(
    session: SessionState,
    requestId: string,
  ): { activeTask: ActiveTaskState } | { result: PrivilegeResolutionResult } {
    if (!session.activeTask) {
      return {
        result: failedPrivilegeResult(requestId, messages.taskNoLongerActive(session.chatId)),
      };
    }

    return {
      activeTask: session.activeTask,
    };
  }

  private async enqueuePrivilegeRequest<TRequest extends PrivilegeRequest>(input: {
    chatId: ChatId;
    taskId: string;
    activeTask: ActiveTaskState;
    request: TRequest;
    registerResolver: (requestId: string, resolve: (result: PrivilegeResolutionResult) => void) => void;
  }): Promise<PrivilegeResolutionResult> {
    if (input.activeTask.pendingPrivilegeRequest) {
      return failedPrivilegeResult(input.request.requestId, messages.anotherPrivilegeRequestPendingForTask());
    }

    input.activeTask.pendingPrivilegeRequest = input.request;
    input.activeTask.status = "awaiting_privilege_decision";
    const resultPromise = new Promise<PrivilegeResolutionResult>((resolve) => {
      input.registerResolver(input.request.requestId, resolve);
    });
    await this.deps.taskCoordinator.runJobUserVisibleOperation(
      input.chatId,
      input.taskId,
      input.activeTask.taskName,
      async (channel) => {
        await channel.sendPrivilegeRequest(input.chatId, input.request);
      },
    );

    return await resultPromise;
  }
}

export interface TaskFailureHandler {
  failActiveTaskFromEventHandling(session: SessionState, taskId: string, message: string): Promise<void>;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled main agent decision: ${JSON.stringify(value)}`);
}
