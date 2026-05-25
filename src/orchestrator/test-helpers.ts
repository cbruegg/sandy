import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { MainAgentController } from "../agent/main-agent-controller.js";
import type { ChannelAdapter } from "../channel/channel-adapter.js";
import { createNoopHostfsBroker } from "../hostfs/hostfs-broker.js";
import type { HostfsBroker } from "../hostfs/hostfs-broker.js";
import { SandyOrchestrator } from "./index.js";
import type { PersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import { createNoopPersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import type { PrivilegeBroker, SupportedPrivilegeRequest } from "../privilege/privilege-broker.js";
import { createNoopTaskBundleAssignmentRegistry } from "../sandbox/task-bundle-assignment-registry.js";
import type { TaskBundleAssignmentLookup } from "../sandbox/task-bundle-assignment-registry.js";
import type { LaunchTaskRequest, SandboxHandle, SandboxRunner } from "../sandbox/sandbox-runner.js";
import { InMemorySessionStore } from "../session/in-memory-session-store.js";
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

const testFormatting: ChannelFormatting = {
  channelId: "telegram",
  markup: "telegram_html",
  allowedTags: ["b", "i", "code", "pre"],
  instructions: "Use simple Telegram HTML.",
};

export function expectDefined<T>(value: T | null | undefined, message: string): NonNullable<T> {
  assert.notEqual(value, undefined, message);
  assert.notEqual(value, null, message);
  return value as NonNullable<T>;
}

export class RecordingChannel implements ChannelAdapter {
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
  public markFinishedCalls = 0;
  public closeCalls = 0;
  public readonly cancellations: string[] = [];

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

class FakeSandboxRunner implements SandboxRunner {
  public readonly launches: LaunchTaskRequest[] = [];
  public readonly handle = new FakeSandboxHandle();
  public onEvent: ((event: SubAgentEvent) => Promise<void>) | null = null;
  public readonly deletedTaskShares: string[] = [];
  public shareInspections = new Map<string, { isEmpty: boolean; summary: string | null }>();

  launchTask(request: LaunchTaskRequest, onEvent: (event: SubAgentEvent) => Promise<void>): Promise<SandboxHandle> {
    this.launches.push(request);
    this.onEvent = onEvent;
    return Promise.resolve(this.handle);
  }

  async emit(event: SubAgentEvent): Promise<void> {
    if (!this.onEvent) {
      throw new Error("No task is active.");
    }
    await this.onEvent(event);
  }

  inspectTaskShare(taskId: string): Promise<{ isEmpty: boolean; summary: string | null }> {
    return Promise.resolve(this.shareInspections.get(taskId) ?? { isEmpty: true, summary: null });
  }

  deleteTaskShare(taskId: string): Promise<void> {
    this.deletedTaskShares.push(taskId);
    return Promise.resolve();
  }

  getTaskSharePath(taskId: string): string {
    return `/tmp/${taskId}`;
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

export function createTestOrchestrator(options: {
  channel?: RecordingChannel;
  mainAgent: MainAgentController;
  sandboxRunner?: FakeSandboxRunner;
  sessionStore?: InMemorySessionStore;
  privilegeBroker?: PrivilegeBroker;
  persistentApprovalStore?: PersistentApprovalStore;
  hostfsBroker?: HostfsBroker;
  taskBundleAssignmentRegistry?: TaskBundleAssignmentLookup;
}) {
  const channel = options.channel ?? new RecordingChannel();
  const runner = options.sandboxRunner ?? new FakeSandboxRunner();
  const store = options.sessionStore ?? new InMemorySessionStore();
  const privilegeBroker = options.privilegeBroker ?? new FakePrivilegeBroker();
  const orchestrator = new SandyOrchestrator({
    channel,
    mainAgent: options.mainAgent,
    sandboxRunner: runner,
    buildWorkerStartConfig: createTestWorkerStartConfig,
    sessionStore: store,
    privilegeBroker,
    persistentApprovalStore: options.persistentApprovalStore ?? createNoopPersistentApprovalStore(),
    hostfsBroker: options.hostfsBroker ?? createNoopHostfsBroker(),
    taskBundleAssignmentRegistry: options.taskBundleAssignmentRegistry ?? createNoopTaskBundleAssignmentRegistry(),
  });

  return {
    orchestrator,
    channel,
    runner,
    store,
    privilegeBroker,
  };
}
