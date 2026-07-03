/**
 * Shared input and result types for the DI layer factories.
 *
 * Each layer factory takes an explicitly typed input object and returns a
 * result object containing the constructed services plus an optional `stop()`
 * method for teardown.  `app.ts` calls the factories in dependency order,
 * then starts services, and finally assembles a composite shutdown.
 */

import type { SandyConfig } from "../config.js";
import type { ChannelAdapter } from "../channel/channel-adapter.js";
import type { ChannelDestinationStore } from "../channel/channel-destination-store.js";
import type { CertificateAuthority } from "../http/ca.js";
import type { ChatGPTTokenBroker } from "../auth/chatgpt-token-broker.js";
import type { TaskMemoryContextCollector } from "../memory/task-memory-context-collector.js";
import type { CodexMainAgentController } from "../agent/main-agent-controller.js";
import type { CodexAppServerClient } from "../codex-app-server-client/app-server-client.js";
import type { ProxyAccess } from "../proxy-access.js";
import type { ProxyAuthService } from "../http/proxy-auth-service.js";
import type { HttpTokenAuthorizer } from "../http/token-authorizer.js";
import type { McpWorkerLaunchConfigBuilder } from "../mcp/worker-launch-config-builder.js";
import type { HostMcpServerRegistry } from "../mcp/host-server-registry.js";
import type { InMemorySessionStore } from "../session/in-memory-session-store.js";
import type { TomlPersistentApprovalStore } from "../privilege/persistent-approval-store.js";
import type { JobApprovalStore } from "../jobs/job-approval-store.js";
import type { JobStore } from "../jobs/job-store.js";
import type { SkillService } from "../skills.js";
import type { SandyOrchestrator } from "../orchestrator/index.js";
import type { OrchestratorPrivilegesImpl } from "../orchestrator/privileges.js";
import type { OrchestratorTaskLifecycleImpl } from "../orchestrator/task-lifecycle.js";
import type { TaskCoordinator } from "../orchestrator/task-coordinator.js";
import type { ActiveTaskRuntimeRegistry } from "../orchestrator/active-task-runtime-registry.js";
import type { WorkerToolsHandler } from "../subagent/worker-tools-handler.js";
import type { DockerSandboxRunner } from "../sandbox/docker-sandbox-runner.js";
import type { McpSidecarManager } from "../mcp/sidecar-manager.js";
import type { SelfUpdateCoordinator } from "../update/self-update.js";
import type { HostfsBroker } from "../hostfs/hostfs-broker.js";
import type { HostfsServices } from "../hostfs/index.js";
import type { WorkerImageManager } from "../worker-image-manager.js";
import type { JobCleanupService } from "../jobs/job-cleanup.js";
import type { JobScheduler } from "../jobs/job-scheduler.js";
import type { ScheduledJobService } from "../jobs/job-service.js";
import type { TranscriptionProvider } from "../transcription/transcription-provider.js";

// ---------------------------------------------------------------------------
// Foundation
// ---------------------------------------------------------------------------

export type FoundationLayerResult = {
  readonly name: "foundation";
  readonly config: SandyConfig;
  readonly sandyCacheRoot: string;
  readonly controllerControlDir: string;
  readonly stopControllerHeartbeat: () => Promise<void>;
  readonly workerImageManager: WorkerImageManager;
  readonly mainAgentCodexPath: string;
  readonly workerCodexBinaryPath: string;
  readonly initialWorkerImage: string;
  readonly mainAgentAppServer: CodexAppServerClient;
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export type ChannelLayerInput = {
  readonly config: SandyConfig;
  readonly transcriptionProvider: TranscriptionProvider | null;
  readonly matrixAccessToken: string | null;
};

export type ChannelLayerResult = {
  readonly name: "channel";
  readonly rawChannel: ChannelAdapter;
  readonly channel: ChannelAdapter;
  readonly destinationStore: ChannelDestinationStore;
  readonly channelFormatting: ReturnType<ChannelAdapter["getFormatting"]>;
  readonly triggerFatalChannelError: (error: unknown, source: string) => void;
  readonly fatalErrorPromise: Promise<never>;
  /** Set the composite shutdown function so the channel can trigger it on fatal errors. */
  readonly setShutdown: (fn: () => Promise<void>) => void;
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Core stores
// ---------------------------------------------------------------------------

export type CoreStoresInput = {
  readonly config: SandyConfig;
};

export type CoreStoresResult = {
  readonly name: "core-stores";
  readonly sessionStore: InMemorySessionStore;
  readonly persistentApprovalStore: TomlPersistentApprovalStore;
  readonly jobApprovalStore: JobApprovalStore;
  readonly skillService: SkillService;
  readonly jobStore: JobStore;
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// HTTP proxy
// ---------------------------------------------------------------------------

export type HttpProxyLayerInput = {
  readonly config: SandyConfig;
  readonly sessionStore: InMemorySessionStore;
  readonly persistentApprovalStore: TomlPersistentApprovalStore;
};

export type HttpProxyLayerResult = {
  readonly name: "http-proxy";
  readonly proxyAccess: ProxyAccess;
  readonly httpTokensEnabled: boolean;
  readonly certificateAuthority: CertificateAuthority | null;
  readonly httpTokenAuthorizer: HttpTokenAuthorizer;
  readonly proxyAuthService: ProxyAuthService | null;
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Hostfs
// ---------------------------------------------------------------------------

export type HostfsLayerResult = {
  readonly name: "hostfs";
  readonly hostfsServices: HostfsServices | null;
  readonly hostfsBroker: HostfsBroker;
  readonly createHostfsVolume: ((bundleId: string) => Promise<string | null>) | undefined;
  readonly removeHostfsVolume: ((bundleId: string) => Promise<void>) | undefined;
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// MCP infrastructure (constructed before sandbox/orchestrator)
// ---------------------------------------------------------------------------

export type McpInfrastructureLayerInput = {
  readonly config: SandyConfig;
  readonly proxyAccess: ProxyAccess;
};

export type McpInfrastructureLayerResult = {
  readonly name: "mcp-infrastructure";
  readonly hostMcpRegistry: HostMcpServerRegistry;
  readonly mcpWorkerLaunchConfigBuilder: McpWorkerLaunchConfigBuilder;
  readonly workerNetworkName: string;
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export type SandboxLayerInput = {
  readonly config: SandyConfig;
  readonly workerImageManager: WorkerImageManager;
  readonly controllerControlDir: string;
  readonly workerCodexBinaryPath: string;
  readonly skillService: SkillService;
  readonly certificateAuthority: CertificateAuthority | null;
  readonly proxyAuthService: ProxyAuthService | null;
  readonly proxyAccess: ProxyAccess;
  readonly createHostfsVolume: ((bundleId: string) => Promise<string | null>) | undefined;
  readonly removeHostfsVolume: ((bundleId: string) => Promise<void>) | undefined;
  readonly mcpWorkerLaunchConfigBuilder: McpWorkerLaunchConfigBuilder;
  readonly workerNetworkName: string;
};

export type SandboxLayerResult = {
  readonly name: "sandbox";
  readonly sandboxRunner: DockerSandboxRunner;
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Main agent
// ---------------------------------------------------------------------------

export type MainAgentLayerInput = {
  readonly config: SandyConfig;
  readonly mainAgentAppServer: CodexAppServerClient;
  readonly skillService: SkillService;
  readonly hostMcpServerKeys: string[];
  readonly mempalaceAvailable: boolean;
};

export type MainAgentLayerResult = {
  readonly name: "main-agent";
  readonly tokenBroker: ChatGPTTokenBroker | null;
  readonly mainAgent: CodexMainAgentController;
  readonly memoryContextCollector: TaskMemoryContextCollector;
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Orchestrator (+ jobs, worker tools)
// ---------------------------------------------------------------------------

export type OrchestratorLayerInput = {
  readonly config: SandyConfig;
  readonly channel: ChannelAdapter;
  readonly destinationStore: ChannelDestinationStore;
  readonly channelFormatting: NonNullable<ReturnType<ChannelAdapter["getFormatting"]>>;
  readonly sessionStore: InMemorySessionStore;
  readonly persistentApprovalStore: TomlPersistentApprovalStore;
  readonly jobApprovalStore: JobApprovalStore;
  readonly skillService: SkillService;
  readonly jobStore: JobStore;
  readonly mainAgent: CodexMainAgentController;
  readonly memoryContextCollector: TaskMemoryContextCollector;
  readonly tokenBroker: ChatGPTTokenBroker | null;
  readonly sandboxRunner: DockerSandboxRunner;
  readonly hostfsBroker: HostfsBroker;
};

export type OrchestratorLayerResult = {
  readonly name: "orchestrator";
  readonly activeTaskRuntimes: ActiveTaskRuntimeRegistry;
  readonly taskCoordinator: TaskCoordinator;
  readonly orchestratorCoreDeps: import("../orchestrator/shared.js").OrchestratorCoreDependencies;
  readonly taskLifecycle: OrchestratorTaskLifecycleImpl;
  readonly jobScheduler: JobScheduler;
  readonly jobService: ScheduledJobService;
  readonly workerToolsHandler: WorkerToolsHandler;
  readonly privileges: OrchestratorPrivilegesImpl;
  readonly orchestrator: SandyOrchestrator;
  readonly jobCleanupService: JobCleanupService;
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// MCP sidecar (constructed after orchestrator)
// ---------------------------------------------------------------------------

export type McpSidecarLayerInput = {
  readonly config: SandyConfig;
  readonly controllerControlDir: string;
  readonly workerNetworkName: string;
  readonly orchestrator: SandyOrchestrator;
  readonly hostMcpRegistry: HostMcpServerRegistry;
  readonly proxyAccess: ProxyAccess;
};

export type McpSidecarLayerResult = {
  readonly name: "mcp-sidecar";
  readonly sidecarManager: McpSidecarManager;
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Self-update
// ---------------------------------------------------------------------------

export type SelfUpdateLayerInput = {
  readonly config: SandyConfig;
  readonly sessionStore: InMemorySessionStore;
  readonly channel: ChannelAdapter;
  readonly shutdown: () => Promise<void>;
};

export type SelfUpdateLayerResult = {
  readonly name: "self-update";
  readonly updateCoordinator: SelfUpdateCoordinator;
  stop(): Promise<void>;
};
