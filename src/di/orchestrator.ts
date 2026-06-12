import type { OrchestratorLayerInput, OrchestratorLayerResult } from "./types.js";
import type { SandyAuthMode, HttpTokenConfig } from "../config.js";
import type { ChannelFormatting, WorkerStartConfig } from "../types.js";
import type { WorkerAuthConfig } from "../types.js";
import { SandyOrchestrator } from "../orchestrator/index.js";
import { OrchestratorPrivilegesImpl } from "../orchestrator/privileges.js";
import { ActiveTaskRuntimeRegistry } from "../orchestrator/active-task-runtime-registry.js";
import { OrchestratorTaskLifecycleImpl } from "../orchestrator/task-lifecycle.js";
import { TaskCoordinator } from "../orchestrator/task-coordinator.js";
import { PrivilegeBrokerImpl } from "../privilege/privilege-broker.js";
import { WorkerToolsHandler } from "../subagent/worker-tools-handler.js";
import { JobScheduler } from "../jobs/job-scheduler.js";
import { ScheduledJobService } from "../jobs/job-service.js";
import { logger } from "../logger.js";

async function buildWorkerStartConfig(
  authMode: SandyAuthMode,
  agentModel: string | null,
  httpTokens: Record<string, HttpTokenConfig>,
  tokenBroker: import("../auth/chatgpt-token-broker.js").ChatGPTTokenBroker | null,
  channelFormatting: ChannelFormatting | null,
): Promise<WorkerStartConfig> {
  let auth: WorkerAuthConfig;

  if (authMode.mode === "api_key") {
    auth = { mode: "ambient_api_key", openAiApiKey: authMode.openAiApiKey };
  } else if (tokenBroker) {
    try {
      auth = {
        mode: "external_tokens",
        tokens: await tokenBroker.getInitialTokens(),
      };
    } catch (error) {
      logger.error("token_broker.worker_launch_tokens_failed", error, "Unknown error");
      auth = { mode: "ambient_auth_file" };
    }
  } else {
    auth = { mode: "ambient_auth_file" };
  }

  const httpTokensEnabled = Object.keys(httpTokens).length > 0;

  return {
    auth,
    codexModel: agentModel,
    channelFormatting,
    httpTokens: Object.entries(httpTokens).map(([tokenId, token]) => ({
      tokenId,
      description: token.description,
    })),
    httpProxyWrapper: httpTokensEnabled ? "/usr/local/bin/sandy-http-proxy-exec" : null,
  };
}

export function createOrchestratorLayer(input: OrchestratorLayerInput): OrchestratorLayerResult {
  const {
    config,
    channel,
    channelFormatting,
    sessionStore,
    persistentApprovalStore,
    jobApprovalStore,
    skillService,
    jobStore,
    mainAgent,
    tokenBroker,
    sandboxRunner,
    hostfsBroker,
  } = input;

  const refreshChatGPTTokens = async (_taskId: string, previousAccountId: string | null) => {
    if (!tokenBroker) return null;
    try {
      return await tokenBroker.refreshTokens(previousAccountId);
    } catch (error) {
      logger.error("token_broker.refresh_failed", error, "Unknown error");
      return null;
    }
  };

  const activeTaskRuntimes = new ActiveTaskRuntimeRegistry();
  const taskCoordinator = new TaskCoordinator({
    sessionStore,
    channel,
    onJobTaskBecameInteractive: async (taskId) => {
      await activeTaskRuntimes.notifyTaskBecameInteractive(taskId);
    },
  });

  const privilegeBroker = new PrivilegeBrokerImpl();
  const orchestratorCoreDeps = {
    mainAgent,
    sandboxRunner,
    buildWorkerStartConfig: () => buildWorkerStartConfig(
      config.authMode,
      config.agentModel,
      config.httpTokens,
      tokenBroker,
      channelFormatting,
    ),
    refreshChatGPTTokens,
    sessionStore,
    privilegeBroker,
    persistentApprovalStore,
    jobApprovalStore,
    hostfsBroker,
    skillService,
    taskCoordinator,
  };

  const taskLifecycle = new OrchestratorTaskLifecycleImpl(
    orchestratorCoreDeps,
    activeTaskRuntimes,
    channelFormatting,
    channel,
  );

  const jobScheduler = new JobScheduler(jobStore, async (job, workspacePath) => {
    const chatId = await channel.destinationStore.getDefaultChatId();
    if (!chatId) {
      throw new Error(`Cannot launch scheduled job ${job.id}: no default chat destination is known yet.`);
    }
    return await taskLifecycle.launchJobTask(job, chatId, workspacePath);
  });

  const jobService = new ScheduledJobService(jobStore, jobScheduler);

  const workerToolsHandler = new WorkerToolsHandler({
    jobService,
    getTaskSharePath: (taskId) => activeTaskRuntimes.requireHandle(taskId).getTaskSharePath(),
    runUserVisibleOperation: async ({ chatId, taskId, taskName, operation }) => {
      await taskCoordinator.runJobUserVisibleOperation(chatId, taskId, taskName, operation);
    },
  });

  const privileges = new OrchestratorPrivilegesImpl(
    orchestratorCoreDeps,
    activeTaskRuntimes,
    workerToolsHandler,
    jobService,
    taskLifecycle,
  );

  const orchestrator = new SandyOrchestrator({
    ...orchestratorCoreDeps,
    channel,
    channelFormatting,
    taskLifecycle,
    privileges,
  });

  const stop = (): Promise<void> => {
    jobScheduler.stop();
    return Promise.resolve();
  };

  return {
    name: "orchestrator",
    activeTaskRuntimes,
    taskCoordinator,
    orchestratorCoreDeps,
    privilegeBroker,
    taskLifecycle,
    jobScheduler,
    jobService,
    workerToolsHandler,
    privileges,
    orchestrator,
    stop,
  };
}