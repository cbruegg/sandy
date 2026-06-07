import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MainAgentController } from "../agent/main-agent-controller.js";
import type { ChannelAdapter } from "../channel/channel-adapter.js";
import { ImplicitChannelDestinationStore } from "../channel/channel-destination-store.js";
import { createNoopHostfsBroker } from "../hostfs/hostfs-broker.js";
import type { HostfsBroker } from "../hostfs/hostfs-broker.js";
import { SandyOrchestrator } from "./index.js";
import type { PersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import { createNoopPersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import type { PrivilegeBroker, SupportedPrivilegeRequest } from "../privilege/privilege-broker.js";
import type { LaunchTaskRequest, SandboxHandle, SandboxRunner, SandboxTaskBundle } from "../sandbox/sandbox-runner.js";
import { InMemorySessionStore } from "../session/in-memory-session-store.js";
import { OrchestratorPrivilegesImpl } from "./privileges.js";
import { ActiveTaskRuntimeRegistry } from "./active-task-runtime-registry.js";
import type { OrchestratorCoreDependencies } from "./shared.js";
import { OrchestratorTaskLifecycleImpl } from "./task-lifecycle.js";
import { TaskCoordinator } from "./task-coordinator.js";
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
import { SkillService } from "../skills.js";
import { WorkerToolsHandler } from "./worker-tools-handler.js";
import { JobApprovalStore } from "../jobs/job-approval-store.js";
import type { JobService } from "../jobs/job-service.js";
import type { JobDefinition, JobMutationRequest } from "../jobs/job-types.js";

const testFormatting: ChannelFormatting = {
  channelId: "telegram",
  markup: "telegram_markdown",
  allowedTags: [],
  instructions: "Use simple Markdown.",
};

export function expectDefined<T>(value: T | null | undefined, message: string): NonNullable<T> {
  assert.notEqual(value, undefined, message);
  assert.notEqual(value, null, message);
  return value as NonNullable<T>;
}

export class RecordingChannel implements ChannelAdapter {
  readonly destinationStore = new ImplicitChannelDestinationStore("test-chat");
  public readonly sentTexts: Array<{ chatId: string; text: string }> = [];
  public readonly taskUpdates: Array<{ chatId: string; text: string }> = [];
  public readonly sentFiles: Array<{ chatId: string; filePath: string; caption?: string }> = [];
  public readonly privilegeRequests: Array<{ chatId: string; request: PrivilegeRequest }> = [];
  public readonly shareDeletionRequests: Array<{ chatId: string; requestId: string; taskName: string; summary: string }> = [];
  public readonly savedAttachments: Array<{ chatId: string; attachments: MessageAttachment[]; targetDirectory: string }> = [];
  public sendFileError: Error | null = null;

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  getFormatting(): ChannelFormatting {
    return testFormatting;
  }

  saveAttachments(chatId: string, attachments: MessageAttachment[], targetDirectory: string): Promise<SavedAttachment[]> {
    this.savedAttachments.push({ chatId, attachments, targetDirectory });
    return Promise.resolve(attachments.map((attachment, index) => ({
      attachmentId: attachment.attachmentId,
      kind: attachment.kind,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      hostPath: resolve(targetDirectory, `${index + 1}-${attachment.fileName}`),
    })));
  }

  sendFile(chatId: string, filePath: string, caption?: string): Promise<void> {
    if (this.sendFileError) {
      return Promise.reject(this.sendFileError);
    }
    this.sentFiles.push({ chatId, filePath, caption });
    return Promise.resolve();
  }

  sendText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
    return Promise.resolve();
  }

  sendTaskUpdate(chatId: string, text: string): Promise<void> {
    this.taskUpdates.push({ chatId, text });
    return Promise.resolve();
  }

  sendReportableText(chatId: string, text: string): Promise<void> {
    this.sentTexts.push({ chatId, text });
    return Promise.resolve();
  }

  sendPrivilegeRequest(chatId: string, request: PrivilegeRequest): Promise<void> {
    this.privilegeRequests.push({ chatId, request });
    return Promise.resolve();
  }

  sendShareDeletionRequest(chatId: string, requestId: string, taskName: string, summary: string): Promise<void> {
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
  public taskSharePath = "";
  public taskBundle: SandboxTaskBundle = { bundleId: "fake-bundle", hostfsVolumeName: null };
  public markFinishedCalls = 0;
  public closeCalls = 0;
  public readonly cancellations: string[] = [];

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
    const taskSharePath = `/tmp/${request.taskId}`;
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

export class FakePrivilegeBroker implements PrivilegeBroker {
  public readonly appliedRequests: Array<{ request: SupportedPrivilegeRequest; taskId: string; taskSharePath: string }> = [];

  apply(request: SupportedPrivilegeRequest, context: { taskId: string; taskSharePath: string }): Promise<{ outcome: "approved"; message: string }> {
    this.appliedRequests.push({ request, taskId: context.taskId, taskSharePath: context.taskSharePath });
    return Promise.resolve({
      outcome: "approved",
      message: `Applied ${request.type}.`,
    });
  }
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
  mainAgent: MainAgentController;
  sandboxRunner?: FakeSandboxRunner;
  sessionStore?: InMemorySessionStore;
  privilegeBroker?: PrivilegeBroker;
  persistentApprovalStore?: PersistentApprovalStore;
  hostfsBroker?: HostfsBroker;
  skillService?: SkillService;
  taskCoordinator?: TaskCoordinator;
}) {
  const channel = options.channel ?? new RecordingChannel();
  const runner = options.sandboxRunner ?? new FakeSandboxRunner();
  const store = options.sessionStore ?? new InMemorySessionStore();
  const privilegeBroker = options.privilegeBroker ?? new FakePrivilegeBroker();
  const skillService = options.skillService ?? new SkillService(mkdtempSync(join(tmpdir(), "sandy-test-config-")));
  const taskCoordinator = options.taskCoordinator ?? new TaskCoordinator(store, channel);
  const coreDeps: OrchestratorCoreDependencies = {
    channel,
    mainAgent: options.mainAgent,
    sandboxRunner: runner,
    buildWorkerStartConfig: () => Promise.resolve(createTestWorkerStartConfig()),
    sessionStore: store,
    privilegeBroker,
    persistentApprovalStore: options.persistentApprovalStore ?? createNoopPersistentApprovalStore(),
    jobApprovalStore: new JobApprovalStore(mkdtempSync(join(tmpdir(), "sandy-job-approvals-"))),
    hostfsBroker: options.hostfsBroker ?? createNoopHostfsBroker(),
    skillService,
    taskCoordinator,
  };
  const activeTaskRuntimes = new ActiveTaskRuntimeRegistry();
  const taskLifecycle = new OrchestratorTaskLifecycleImpl(coreDeps, activeTaskRuntimes, channel.getFormatting());
  const jobService = new FakeJobService();
  const workerToolsHandler = new WorkerToolsHandler(skillService, jobService);
  const privileges = new OrchestratorPrivilegesImpl(coreDeps, activeTaskRuntimes, workerToolsHandler, taskLifecycle);
  const orchestrator = new SandyOrchestrator({
    ...coreDeps,
    channelFormatting: channel.getFormatting(),
    taskLifecycle,
    privileges,
  });

  return {
    orchestrator,
    channel,
    runner,
    store,
    privilegeBroker,
    activeTaskRuntimes,
    skillService,
    taskCoordinator,
    taskLifecycle,
    privileges,
  };
}
