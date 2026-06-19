import { randomUUID } from "node:crypto";
import { logger } from "../logger.js";
import { messages } from "../messages.js";
import { ActiveTaskRuntimeRegistry } from "./active-task-runtime-registry.js";
import type { OrchestratorCoreDependencies, TaskFailureHandler } from "./shared.js";
import { parseWorkerToolPayload } from "../subagent/worker-tools.js";
import type { NativeWorkerToolCallResult, WorkerToolPayload } from "../subagent/worker-tools.js";
import type { ActiveTaskState, NormalizedChatEvent, PrivilegeRequest, PrivilegeResolutionResult, SessionState } from "../types.js";
import type { ChatId } from "../types.js";
import type { WorkerToolsHandler } from "../subagent/worker-tools-handler.js";
import { assertNever } from "../utils/assert-never.js";
import {
  failedPrivilegeResult,
  isMcpPrivilegeRequest,
  isNativeToolPrivilegeRequest,
  toNativeWorkerToolCallResult,
} from "./privilege-results.js";
import type { NativeToolPrivilegeRequest } from "./privilege-results.js";
import { buildNativeToolPrivilegeRequest } from "./privilege-request-builder.js";
import {
  resolveFileCopyRequest,
  resolveHostDirectoryRequest,
  resolveHttpTokenRequest,
  resolveJobMutationRequest,
  resolveMcpResourceReadRequest,
  resolveMcpToolCallRequest,
  resolveSkillMutationRequest,
} from "./privilege-resolvers.js";
import type { PrivilegeContext } from "./privilege-resolvers.js";
import { authorizeMcpImmediately, tryAuthorizeHostDirectoryAccess, tryAuthorizeNativeHttpTokenUse } from "./privilege-authorizers.js";
import {
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
    reason?: string,
  ): Promise<void>;
}

/**
 * Coordinates privilege handling: dispatching native tool calls, enqueuing privilege
 * requests for user decisions, and applying those decisions. The per-kind decision
 * logic lives in privilege-request-builder, privilege-resolvers, and privilege-authorizers;
 * this class owns the shared request lifecycle and task/channel wiring.
 */
export class OrchestratorPrivilegesImpl implements OrchestratorPrivileges {
  private readonly privilegeContext: PrivilegeContext;

  constructor(
    private readonly deps: Omit<OrchestratorCoreDependencies, "channel">,
    private readonly activeTasks: ActiveTaskRuntimeRegistry,
    private readonly workerToolsHandler: WorkerToolsHandler,
    private readonly taskFailureHandler: TaskFailureHandler,
  ) {
    this.privilegeContext = {
      persistentApprovalStore: deps.persistentApprovalStore,
      jobApprovalStore: deps.jobApprovalStore,
      workerToolsHandler,
    };
  }

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
    reason?: string,
  ): Promise<void> {
    const activeTask = session.visibleTask;
    if (!activeTask) {
      return;
    }

    let result: PrivilegeResolutionResult;
    switch (request.kind) {
      case "mcp_tool_call":
        result = await resolveMcpToolCallRequest(this.privilegeContext, session, request, decision, reason);
        break;
      case "mcp_resource_read":
        result = await resolveMcpResourceReadRequest(this.privilegeContext, session, request, decision, reason);
        break;
      case "http_token_use":
        result = await resolveHttpTokenRequest(this.privilegeContext, session, request, decision, reason);
        break;
      case "host_directory_access":
        result = await resolveHostDirectoryRequest(this.privilegeContext, session, request, decision, reason);
        break;
      case "skill_mutation":
        result = await resolveSkillMutationRequest(this.privilegeContext, session, request, decision, reason);
        break;
      case "job_mutation":
        result = await resolveJobMutationRequest(this.privilegeContext, session, request, decision, reason);
        break;
      case "file_copy":
        result = await resolveFileCopyRequest(this.privilegeContext, request, decision, activeTask.taskId, reason);
        break;
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
    activeTask.pendingPrivilegeRequest = null;
    activeTask.moveToState("running");

    await this.sendPrivilegeResolutionMessage(session.chatId, activeTask.taskId, activeTask.taskName, result);
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
      case "terminate_task":
        return await this.workerToolsHandler.terminateTask({
          task: activeTask,
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
          (requestId) => buildNativeToolPrivilegeRequest(this.deps, session, taskId, call, requestId),
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

    if (request.kind === "http_token_use") {
      const immediateResult = tryAuthorizeNativeHttpTokenUse(this.privilegeContext, activeTask, request);
      if (immediateResult) {
        return immediateResult;
      }
    }

    // Host directory grants require an async hostfs mount, so they are checked separately
    // from the synchronous fast paths above.
    if (request.kind === "host_directory_access") {
      const hostDirectoryResult = await tryAuthorizeHostDirectoryAccess(this.privilegeContext, activeTask, request);
      if (hostDirectoryResult) {
        return hostDirectoryResult;
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

    const authorization = await authorizeMcpImmediately(activeTask, {
      serverId: options.serverId,
      isTaskGrantAllowed: options.isTaskGrantAllowed,
      isPersistentAllowed: options.isPersistentAllowed,
      sessionMessage: options.sessionMessage,
      persistentMessage: options.persistentMessage,
    });
    if (authorization.kind === "resolved") {
      return authorization.result;
    }

    return await this.enqueuePrivilegeRequest({
      chatId,
      taskId,
      activeTask,
      request: {
        ...options.buildRequest(randomUUID()),
        confirmsAutoApprovalForTask: authorization.confirmsAutoApprovalForTask,
      },
      registerResolver: (requestId, resolve) => {
        this.activeTasks.setPendingMcpPrivilegeResolver(requestId, resolve);
      },
    });
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
    input.activeTask.moveToState("awaiting_privilege_decision");
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
