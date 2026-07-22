import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MainAgentController } from "../agent/main-agent-controller.js";
import type { ChannelAdapter } from "../channel/channel-adapter.js";
import { ImplicitChannelDestinationStore, type ChannelDestinationStore } from "../channel/channel-destination-store.js";
import { createNoopHostfsBroker } from "../hostfs/hostfs-broker.js";
import type { HostfsBroker } from "../hostfs/hostfs-broker.js";
import { SandyOrchestrator } from "./index.js";
import type { PersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import { createNoopPersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import type { LaunchTaskRequest, SandboxHandle, SandboxRunner, SandboxTaskBundle } from "../sandbox/sandbox-runner.js";
import { InMemorySessionStore } from "../session/in-memory-session-store.js";
import { OrchestratorPrivilegesImpl } from "./privileges.js";
import { ActiveTaskRuntimeRegistry } from "./active-task-runtime-registry.js";
import type { OrchestratorCoreDependencies } from "./shared.js";
import { OrchestratorTaskLifecycleImpl } from "./task-lifecycle.js";
import { TaskCoordinator } from "./task-coordinator.js";
import { CommentaryBufferManager } from "./commentary-buffer-manager.js";
import type {
  ChannelFormatting,
  DecideContext,
  MainAgentDecision,
  MessageAttachment,
  PrivilegeRequest,
  PrivilegeResolutionResult,
  SavedAttachment,
  SubAgentEvent,
  TaskInputPayload,
  WorkerStartConfig,
} from "../types.js";
import type { ChatId } from "../types.js";
import { SkillService } from "../skills.js";
import { WorkerToolsHandler } from "../subagent/worker-tools-handler.js";
import type { FileCopyWorkerToolPayload } from "../subagent/worker-tools.js";
import { JobApprovalStore, type JobApprovalStoreApi } from "../jobs/job-approval-store.js";
import type { JobService } from "../jobs/job-service.js";
import type { JobDefinition } from "../jobs/job-validation.js";
import type { JobMutationRequest } from "../jobs/job-types.js";
import { NoopTaskMemoryContextCollector, type TaskMemoryContextCollector } from "../memory/task-memory-context-collector.js";

const testFormatting: ChannelFormatting = {
  channelId: "telegram",
  markup: "markdown",
  allowedTags: [],
  instructions: "Use simple Markdown.",
};

export function expectDefined<T>(value: T | null | undefined, message: string): NonNullable<T> {
  assert.notEqual(value, undefined, message);
  assert.notEqual(value, null, message);
  return value as NonNullable<T>;
}

export class RecordingChannel implements ChannelAdapter {
  private readonly lastUserInteractionTimestamps = new Map<ChatId, string>();
  public readonly sentTexts: Array<{ chatId: ChatId; text: string }> = [];
  public readonly taskUpdates: Array<{ chatId: ChatId; text: string }> = [];
  public readonly sentFiles: Array<{ chatId: ChatId; filePath: string; caption?: string }> = [];
  public readonly privilegeRequests: Array<{ chatId: ChatId; request: PrivilegeRequest }> = [];
  public readonly denialReasonPrompts: Array<{ chatId: ChatId; request: PrivilegeRequest }> = [];
  public readonly shareDeletionRequests: Array<{ chatId: ChatId; requestId: string; taskName: string; summary: string }> = [];
  public readonly taskSummaryConfirmationRequests: Array<{ chatId: ChatId; requestId: string; taskName: string }> = [];
  public readonly savedAttachments: Array<{ chatId: ChatId; attachments: MessageAttachment[]; targetDirectory: string }> = [];
  public saveAttachmentsError: Error | null = null;
  public sendFileError: Error | null = null;
  public sendTaskUpdateError: Error | null = null;

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  getFormatting(): ChannelFormatting {
    return testFormatting;
  }

  getLastUserInteractionTimestamp(chatId: ChatId): string | null {
    return this.lastUserInteractionTimestamps.get(chatId) ?? null;
  }

  recordUserInteraction(chatId: ChatId, timestamp: string): void {
    this.lastUserInteractionTimestamps.set(chatId, timestamp);
  }

  saveAttachments(chatId: ChatId, attachments: MessageAttachment[], targetDirectory: string): Promise<SavedAttachment[]> {
    if (this.saveAttachmentsError) {
      const error = this.saveAttachmentsError;
      this.saveAttachmentsError = null;
      return Promise.reject(error);
    }
    this.savedAttachments.push({ chatId, attachments, targetDirectory });
    return Promise.resolve(attachments.map((attachment, index) => ({
      attachmentId: attachment.attachmentId,
      kind: attachment.kind,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      hostPath: resolve(targetDirectory, `${index + 1}-${attachment.fileName}`),
    })));
  }

  sendFile(chatId: ChatId, filePath: string, caption?: string): Promise<void> {
    if (this.sendFileError) {
      return Promise.reject(this.sendFileError);
    }
    this.sentFiles.push({ chatId, filePath, caption });
    return Promise.resolve();
  }

  sendText(chatId: ChatId, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
    return Promise.resolve();
  }

  sendTaskUpdate(chatId: ChatId, text: string): Promise<void> {
    if (this.sendTaskUpdateError) {
      return Promise.reject(this.sendTaskUpdateError);
    }
    this.taskUpdates.push({ chatId, text });
    return Promise.resolve();
  }

  sendReportableText(chatId: ChatId, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
    return Promise.resolve();
  }

  sendTaskSummaryConfirmationRequest(chatId: ChatId, requestId: string, taskName: string): Promise<void> {
    this.taskSummaryConfirmationRequests.push({ chatId, requestId, taskName });
    return Promise.resolve();
  }

  sendPrivilegeRequest(chatId: ChatId, request: PrivilegeRequest): Promise<void> {
    this.privilegeRequests.push({ chatId, request });
    return Promise.resolve();
  }

  askForDenialReason(chatId: ChatId, request: PrivilegeRequest): Promise<void> {
    this.denialReasonPrompts.push({ chatId, request });
    return Promise.resolve();
  }

  sendShareDeletionRequest(chatId: ChatId, requestId: string, taskName: string, summary: string): Promise<void> {
    this.shareDeletionRequests.push({ chatId, requestId, taskName, summary });
    return Promise.resolve();
  }
}

export class StubMainAgent implements MainAgentController {
  public readonly contexts: DecideContext[] = [];

  constructor(private readonly decision: MainAgentDecision) {}

  decide(context: DecideContext): Promise<MainAgentDecision> {
    this.contexts.push(context);
    return Promise.resolve(this.decision);
  }
}

export class SequenceMainAgent implements MainAgentController {
  private index = 0;
  public readonly contexts: DecideContext[] = [];

  constructor(private readonly decisions: MainAgentDecision[]) {}

  decide(context: DecideContext): Promise<MainAgentDecision> {
    this.contexts.push(context);
    const decision = this.decisions[this.index] ?? this.decisions.at(-1);
    if (!decision) {
      throw new Error("No main-agent decision configured.");
    }
    this.index += 1;
    return Promise.resolve(decision);
  }
}

export function contextTexts(context: DecideContext): string[] {
  return context.newVisibleEntries.map((entry) => entry.text ?? "");
}

function createTestWorkerStartConfig(): WorkerStartConfig {
  return {
    auth: { mode: "ambient_auth_file" },
    codexModel: null,
    channelFormatting: testFormatting,
    httpTokens: [],
    httpProxyWrapper: null,
  };
}

class FakeSandboxHandle implements SandboxHandle {
  public readonly userMessages: TaskInputPayload[] = [];
  public readonly privilegeResults: PrivilegeResolutionResult[] = [];
  public interactiveNotices = 0;
  public taskSharePath = "";
  public taskBundle: SandboxTaskBundle = { bundleId: "fake-bundle", hostfsVolumeName: null };
  public markFinishedCalls = 0;
  public closeCalls = 0;
  public readonly cancellations: string[] = [];
  public closeError: Error | null = null;

  getTaskSharePath(): string {
    if (!this.taskSharePath) {
      throw new Error("No task share path is registered.");
    }
    return this.taskSharePath;
  }

  getTaskBundle(): SandboxTaskBundle {
    return this.taskBundle;
  }

  sendUserMessage(input: TaskInputPayload): Promise<void> {
    this.userMessages.push(input);
    return Promise.resolve();
  }

  notifyTaskBecameInteractive(): Promise<void> {
    this.interactiveNotices += 1;
    return Promise.resolve();
  }

  resolvePrivilege(result: PrivilegeResolutionResult): Promise<void> {
    this.privilegeResults.push(result);
    return Promise.resolve();
  }

  markFinished(): Promise<void> {
    this.markFinishedCalls += 1;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) {
      const error = this.closeError;
      this.closeError = null;
      return Promise.reject(error);
    }
    return Promise.resolve();
  }

  cancel(reason: string): Promise<void> {
    this.cancellations.push(reason);
    return Promise.resolve();
  }
}

type RecordedLaunch = Omit<LaunchTaskRequest, "prepareStartInput"> & {
  taskBrief: string;
  initialInput: TaskInputPayload;
};

class FakeSandboxRunner implements SandboxRunner {
  public readonly launches: RecordedLaunch[] = [];
  public handle = new FakeSandboxHandle();
  public readonly handles = new Map<string, FakeSandboxHandle>();
  public readonly onEvents = new Map<string, (event: SubAgentEvent) => Promise<void>>();
  public readonly deletedTaskShares: string[] = [];
  public readonly launchedTaskShares: string[] = [];
  public shareInspections = new Map<string, { isEmpty: boolean; summary: string | null }>();
  private readonly taskSharePaths = new Map<string, string>();

  async launchTask(request: LaunchTaskRequest, onEvent: (event: SubAgentEvent) => Promise<void>): Promise<SandboxHandle> {
    const handle = new FakeSandboxHandle();
    const taskSharePath = resolve(import.meta.dirname, "../../tmp", request.taskId);
    const startInput = await request.prepareStartInput(taskSharePath);
    this.launches.push({
      chatId: request.chatId,
      taskId: request.taskId,
      taskName: request.taskName,
      taskLanguage: request.taskLanguage,
      channelFormatting: request.channelFormatting,
      workerStartConfig: request.workerStartConfig,
      taskBrief: startInput.taskBrief,
      initialInput: startInput.initialInput,
    });
    this.onEvents.set(request.taskId, onEvent);
    this.launchedTaskShares.push(request.taskId);
    this.taskSharePaths.set(request.taskId, taskSharePath);
    handle.taskSharePath = taskSharePath;
    this.handles.set(request.taskId, handle);
    this.handle = handle;
    return handle;
  }

  async emit(event: SubAgentEvent, taskId?: string): Promise<void> {
    const resolvedTaskId = taskId ?? this.launches.at(-1)?.taskId;
    if (!resolvedTaskId) {
      throw new Error("No task is active.");
    }
    const onEvent = this.onEvents.get(resolvedTaskId);
    if (!onEvent) {
      throw new Error(`Task ${resolvedTaskId} is not active.`);
    }
    await onEvent(event);
  }

  inspectTaskShare(taskId: string): Promise<{ isEmpty: boolean; summary: string | null }> {
    return Promise.resolve(this.shareInspections.get(taskId) ?? { isEmpty: true, summary: null });
  }

  deleteTaskShare(taskId: string): Promise<void> {
    this.deletedTaskShares.push(taskId);
    this.taskSharePaths.delete(taskId);
    return Promise.resolve();
  }

}

/** In-memory JobApprovalStore for tests that need predictable job-scoped persistence without file I/O. */
export class InMemoryJobApprovalStore implements JobApprovalStoreApi {
  private readonly taskPolicies = new Map<string, { autoApproveMcpServers: string[]; autoApproveHttpTokens: string[] }>();

  getTaskPolicy(jobId: string): Promise<{ autoApproveMcpServers: string[]; autoApproveHttpTokens: string[] }> {
    const taskPolicy = this.taskPolicies.get(jobId);
    return Promise.resolve({
      autoApproveMcpServers: [...(taskPolicy?.autoApproveMcpServers ?? [])],
      autoApproveHttpTokens: [...(taskPolicy?.autoApproveHttpTokens ?? [])],
    });
  }

  saveTaskPolicy(jobId: string, taskPolicy: { autoApproveMcpServers: string[]; autoApproveHttpTokens: string[] }): Promise<void> {
    this.taskPolicies.set(jobId, {
      autoApproveMcpServers: Array.from(new Set(taskPolicy.autoApproveMcpServers)).sort(),
      autoApproveHttpTokens: Array.from(new Set(taskPolicy.autoApproveHttpTokens)).sort(),
    });
    return Promise.resolve();
  }
}

export class FileCopySpy {
  public readonly appliedRequests: Array<{ request: FileCopyWorkerToolPayload; taskId: string; taskSharePath: string }> = [];
}

class FakeJobService implements JobService {
  public readonly jobs = new Map<string, JobDefinition>();
  public started = false;

  start(): Promise<void> {
    this.started = true;
    return Promise.resolve();
  }

  stop(): void {
    this.started = false;
  }

  listJobs(): Promise<JobDefinition[]> {
    return Promise.resolve(Array.from(this.jobs.values()));
  }

  getJob(jobId: string): Promise<JobDefinition | null> {
    return Promise.resolve(this.jobs.get(jobId) ?? null);
  }

  applyMutation(mutation: JobMutationRequest): Promise<string> {
    switch (mutation.operation) {
      case "create":
      case "update": {
        if (!mutation.definition) throw new Error("Job definition is required.");
        this.jobs.set(mutation.jobId, mutation.definition);
        return Promise.resolve(`Updated job ${mutation.jobId}.`);
      }
      case "delete": {
        this.jobs.delete(mutation.jobId);
        return Promise.resolve(`Deleted job ${mutation.jobId}.`);
      }
      case "enable": {
        const job = this.jobs.get(mutation.jobId);
        if (job) job.enabled = true;
        return Promise.resolve(`Enabled job ${mutation.jobId}.`);
      }
      case "disable": {
        const job = this.jobs.get(mutation.jobId);
        if (job) job.enabled = false;
        return Promise.resolve(`Disabled job ${mutation.jobId}.`);
      }
      case "run_now":
        return Promise.resolve(`Launched task for job ${mutation.jobId}.`);
      default:
        throw new Error(`Unexpected job mutation operation: ${String(mutation.operation)}`);
    }
  }
}

export function createTestOrchestrator(options: {
  channel?: RecordingChannel;
  destinationStore?: ChannelDestinationStore;
  mainAgent: MainAgentController;
  sandboxRunner?: FakeSandboxRunner;
  autoDeleteTaskShares?: boolean;
  sessionStore?: InMemorySessionStore;
  persistentApprovalStore?: PersistentApprovalStore;
  hostfsBroker?: HostfsBroker;
  skillService?: SkillService;
  memoryContextCollector?: TaskMemoryContextCollector;
  taskCoordinator?: TaskCoordinator;
  commentaryBuffer?: CommentaryBufferManager;
  jobApprovalStore?: JobApprovalStoreApi;
  fileCopySpy?: FileCopySpy;
}) {
  const channel = options.channel ?? new RecordingChannel();
  const destinationStore = options.destinationStore ?? new ImplicitChannelDestinationStore("test-chat");
  const runner = options.sandboxRunner ?? new FakeSandboxRunner();
  const store = options.sessionStore ?? new InMemorySessionStore();
  const fileCopySpy = options.fileCopySpy ?? new FileCopySpy();
  const skillService = options.skillService ?? new SkillService(mkdtempSync(join(tmpdir(), "sandy-test-config-")));
  const activeTaskRuntimes = new ActiveTaskRuntimeRegistry();
  const taskCoordinator = options.taskCoordinator ?? new TaskCoordinator({
    sessionStore: store,
    channel,
    onJobTaskBecameInteractive: async (taskId) => {
      await activeTaskRuntimes.notifyTaskBecameInteractive(taskId);
    },
  });
  const commentaryBuffer = options.commentaryBuffer ?? new CommentaryBufferManager(
    async (taskId, chatId, text) => {
      const task = store.getOrCreate(chatId).findTask(taskId)?.task;
      if (!task) {
        return;
      }
      await taskCoordinator.runJobUserVisibleOperation(chatId, taskId, task.taskName, async (taskChannel) => {
        await taskChannel.sendTaskUpdate(chatId, text);
      });
    },
  );
  const coreDeps: OrchestratorCoreDependencies = {
    mainAgent: options.mainAgent,
    sandboxRunner: runner,
    autoDeleteTaskShares: options.autoDeleteTaskShares ?? false,
    buildWorkerStartConfig: () => Promise.resolve(createTestWorkerStartConfig()),
    sessionStore: store,
    persistentApprovalStore: options.persistentApprovalStore ?? createNoopPersistentApprovalStore(),
    jobApprovalStore: options.jobApprovalStore ?? new JobApprovalStore(mkdtempSync(join(tmpdir(), "sandy-job-approvals-"))),
    hostfsBroker: options.hostfsBroker ?? createNoopHostfsBroker(),
    skillService,
    memoryContextCollector: options.memoryContextCollector ?? new NoopTaskMemoryContextCollector(),
    taskCoordinator,
    commentaryBuffer,
  };
  const taskLifecycle = new OrchestratorTaskLifecycleImpl(coreDeps, activeTaskRuntimes, channel.getFormatting(), channel);
  const jobService = new FakeJobService();
  const workerToolsHandler = new WorkerToolsHandler({
    jobService,
    skillService,
    hostfsBroker: coreDeps.hostfsBroker,
    getTaskSharePath: (taskId) => activeTaskRuntimes.requireHandle(taskId).getTaskSharePath(),
    getTaskBundle: (taskId) => activeTaskRuntimes.requireHandle(taskId).getTaskBundle(),
    runUserVisibleOperation: async ({ chatId, taskId, taskName, operation }) => {
      await taskCoordinator.runJobUserVisibleOperation(chatId, taskId, taskName, operation);
    },
    markTaskFinished: (taskId) => taskLifecycle.markActiveTaskFinished(taskId),
  });
  const originalApplyFileCopy = workerToolsHandler.applyFileCopy.bind(workerToolsHandler);
  workerToolsHandler.applyFileCopy = async (request, input) => {
    fileCopySpy.appliedRequests.push({
      request,
      taskId: input.taskId,
      taskSharePath: activeTaskRuntimes.requireHandle(input.taskId).getTaskSharePath(),
    });
    return await originalApplyFileCopy(request, input);
  };
  const privileges = new OrchestratorPrivilegesImpl(coreDeps, activeTaskRuntimes, workerToolsHandler, taskLifecycle);
  const orchestrator = new SandyOrchestrator({
    ...coreDeps,
    channel,
    destinationStore,
    channelFormatting: channel.getFormatting(),
    taskLifecycle,
    privileges,
  });

  return {
    orchestrator,
    channel,
    runner,
    store,
    fileCopySpy,
    activeTaskRuntimes,
    skillService,
    taskCoordinator,
    commentaryBuffer,
    taskLifecycle,
    privileges,
  };
}
