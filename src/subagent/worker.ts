import { type Input } from "@openai/codex-sdk";
import { isHeartbeatFreshSync } from "../sandbox/heartbeat.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { CODEX_API_KEY_ENV, SANDY_CODEX_PATH_ENV } from "../codex-client.js";
import { configureLogger, logger } from "../logger.js";
import { type HostCommand, type SubAgentEvent } from "../types.js";
import {
  buildInitialTaskInput,
  buildPrivilegeResolutionInput,
  buildTaskBecameInteractiveInput,
  type ImageAttachment,
} from "./worker-prompt.js";
import { AppServerWorkerSession, streamAppServerTurn } from "./worker-app-server.js";
import {
  applyWorkerCodexConfigPatch,
  workerCodexHomePath,
} from "./worker-codex-config.js";
import { writeSubAgentEvent } from "./subagent-event-writer.js";


type WorkerCommandProcessorOptions = {
  sendEvent: (event: SubAgentEvent) => void;
  env: NodeJS.ProcessEnv;
  applyWorkerCodexConfigPatch: typeof applyWorkerCodexConfigPatch;
  startAppServerWorkerSession: typeof AppServerWorkerSession.start;
  onShutdown: () => void;
};

type WorkerCommandProcessor = {
  handleLine: (line: string) => Promise<void>;
  shutdown: () => void;
};

function assertTaskStarted(taskStarted: boolean, commandType: HostCommand["type"]): void {
  if (!taskStarted) {
    throw new Error(`${commandType} command received before start_task`);
  }
}

function parseHostCommand(raw: string): HostCommand {
  const parsed = JSON.parse(raw) as HostCommand;
  if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") {
    throw new Error("Invalid host command.");
  }
  return parsed;
}

function joinTaskSections(taskBrief: string, text: string): string {
  const sections = [taskBrief.trim(), text.trim()].filter((section) => section.length > 0);
  return sections.join("\n\n");
}

function buildAppServerInputWithImages(text: string, images: ImageAttachment[]): Input {
  return [
    ...(text.trim() ? [{ type: "text" as const, text: text.trim() }] : []),
    ...images.map((image) => ({ type: "local_image" as const, path: image.sharePath })),
  ];
}

function requireConfiguredCodexPath(env: NodeJS.ProcessEnv): string {
  const codexPath = env[SANDY_CODEX_PATH_ENV]?.trim();
  if (!codexPath) {
    throw new Error("SANDY_CODEX_PATH must be configured for app-server workers.");
  }
  return codexPath;
}



function createWorkerCommandProcessor(options: WorkerCommandProcessorOptions): WorkerCommandProcessor {
  let appServerSession: AppServerWorkerSession | null = null;
  let currentAbort: AbortController | null = null;
  let turnQueue: Promise<void> = Promise.resolve();
  let commandQueue: Promise<void> = Promise.resolve();
  let taskStarted = false;

  const requireAppServerSession = (): AppServerWorkerSession => {
    if (!appServerSession) {
      throw new Error("App-server has not been initialized.");
    }
    return appServerSession;
  };

  const enqueueAppServerTurn = (input: Input): void => {
    turnQueue = turnQueue.then(async () => {
      currentAbort = new AbortController();
      try {
        await requireAppServerSession().streamTurn(input, currentAbort.signal);
      } finally {
        currentAbort = null;
      }
    }).catch((error) => {
      options.sendEvent({
        type: "task_error",
        message: error instanceof Error ? error.message : "Sub-agent worker turn failed.",
      });
    });
  };

  const enqueueAppServerMarkedFinish = (): void => {
    turnQueue = turnQueue.then(async () => {
      currentAbort = new AbortController();
      try {
        await requireAppServerSession().emitTaskSummary();
        options.sendEvent({ type: "task_done" });
      } finally {
        currentAbort = null;
      }
    }).catch((error) => {
      options.sendEvent({
        type: "task_error",
        message: error instanceof Error ? error.message : "Sub-agent worker finalization failed.",
      });
    });
  };

  const sendUserMessageToAppServer = async (input: Input): Promise<void> => {
    const session = requireAppServerSession();
    const steered = await session.steerActiveTurn(input);
    if (!steered) {
      enqueueAppServerTurn(input);
    }
  };

  const handleCommandLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const command = parseHostCommand(trimmed);
      switch (command.type) {
        case "start_task": {
          if (taskStarted) {
            throw new Error("start_task command received after task already started");
          }
          for (const [name, value] of Object.entries(command.environment)) {
            options.env[name] = value;
          }
          if (command.httpProxyUrl) {
            options.env["SANDY_HTTP_PROXY_URL"] = command.httpProxyUrl;
          }
          if (command.codexConfigToml) {
            await mkdir(workerCodexHomePath, { recursive: true });
            await writeFile(join(workerCodexHomePath, "config.toml"), command.codexConfigToml, "utf8");
          }
          await options.applyWorkerCodexConfigPatch();
          switch (command.config.auth.mode) {
            case "ambient_api_key":
              options.env[CODEX_API_KEY_ENV] = command.config.auth.openAiApiKey;
              break;
            case "ambient_auth_file":
            case "external_tokens":
              delete options.env[CODEX_API_KEY_ENV];
              break;
          }

          const codexPath = requireConfiguredCodexPath(options.env);
          const authMode = command.config.auth.mode === "external_tokens"
            ? { kind: "external_tokens" as const, initialTokens: command.config.auth.tokens }
            : { kind: "ambient" as const };
          appServerSession = await options.startAppServerWorkerSession({
            codexPath,
            authMode,
            model: command.config.codexModel ?? undefined,
            sendEvent: options.sendEvent,
          });

          taskStarted = true;
          const initialInput = buildInitialTaskInput(
            joinTaskSections(command.taskBrief, command.input.text),
            command.taskLanguage,
            command.config.channelFormatting,
            command.config.httpTokens,
            command.config.httpProxyWrapper,
            command.input.images,
          );
          enqueueAppServerTurn(initialInput);
          break;
        }
        case "user_message":
          assertTaskStarted(taskStarted, command.type);
          await sendUserMessageToAppServer(buildAppServerInputWithImages(command.input.text, command.input.images));
          break;
        case "task_became_interactive":
          assertTaskStarted(taskStarted, command.type);
          enqueueAppServerTurn(buildAppServerInputWithImages(buildTaskBecameInteractiveInput(), []));
          break;
        case "privilege_result":
          assertTaskStarted(taskStarted, command.type);
          enqueueAppServerTurn(buildAppServerInputWithImages(buildPrivilegeResolutionInput(command.result), []));
          break;
        case "mark_finished":
          assertTaskStarted(taskStarted, command.type);
          enqueueAppServerMarkedFinish();
          break;
        case "cancel":
          currentAbort?.abort();
          appServerSession?.cancelPendingAuthRefresh();
          appServerSession?.close();
          options.onShutdown();
          break;
        case "chatgpt_auth_refresh_result": {
          appServerSession?.handleAuthRefreshResult(command.tokens);
          break;
        }
      }
    } catch (error) {
      options.sendEvent({
        type: "task_error",
        message: error instanceof Error ? error.message : "Failed to parse host command.",
      });
    }
  };

  const shutdown = (): void => {
    currentAbort?.abort();
    appServerSession?.cancelPendingAuthRefresh();
    appServerSession?.close();
    options.onShutdown();
  };

  return {
    handleLine: (line: string) => {
      commandQueue = commandQueue.then(() => handleCommandLine(line)).catch((error) => {
        logger.error("worker.command_queue_failed", error, "Worker command queue failed.");
      });
      return commandQueue;
    },
    shutdown,
  };
}

export async function main(): Promise<void> {
  configureLogger({
    forwardLog: (payload) => {
      writeSubAgentEvent({
        type: "worker_log",
        level: payload.level,
        event: payload.event,
        data: payload.data,
      });
    },
  });

  const input = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  let shutdownResolver: (() => void) | null = null;
  const waitForShutdown = new Promise<void>((resolve) => {
    shutdownResolver = resolve;
  });

  // Keep the worker process alive after a turn finishes so the host can reply
  // to privilege requests and send follow-up task input over stdin.
  process.stdin.resume();

  writeSubAgentEvent({ type: "worker_connected" });

  let shutdownStarted = false;
  const finishShutdown = (): void => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    shutdownResolver?.();
    process.exit(0);
  };

  const processor = createWorkerCommandProcessor({
    sendEvent: writeSubAgentEvent,
    env: process.env,
    applyWorkerCodexConfigPatch,
    startAppServerWorkerSession: async (options) => await AppServerWorkerSession.start(options),
    onShutdown: finishShutdown,
  });

  const doShutdown = (reason: string): void => {
    if (shutdownStarted) {
      return;
    }
    logger.info("worker.shutting_down", { reason });
    processor.shutdown();
  };

  input.on("line", (line) => {
    void processor.handleLine(line);
  });

  input.on("close", () => {
    doShutdown("stdin_closed");
  });

  // Watch the controller heartbeat file. If the host process dies without
  // closing stdin (e.g. SIGKILL), the heartbeat will stop being refreshed
  // and the container will self-terminate.
  const heartbeatPath = process.env["SANDY_CONTROLLER_HEARTBEAT_PATH"];
  const heartbeatTimeoutMs = Number(process.env["SANDY_CONTROLLER_HEARTBEAT_TIMEOUT_MS"] ?? 30_000);

  if (heartbeatPath) {
    // Poll at half the timeout so we notice a stale heartbeat promptly
    // without checking more frequently than necessary.
    const pollIntervalMs = Math.min(heartbeatTimeoutMs / 2, 5_000);
    const interval = setInterval(() => {
      try {
        if (!isHeartbeatFreshSync(heartbeatPath, heartbeatTimeoutMs)) {
          doShutdown("heartbeat_stale");
        }
      } catch {
        // File missing — controller directory may be gone.
        doShutdown("heartbeat_missing");
      }
    }, pollIntervalMs);
    interval.unref();
  }

  await waitForShutdown;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export {
  createWorkerCommandProcessor,
  streamAppServerTurn,
};
export {
  buildInitialTaskInput,
  buildInitialTaskInputWithCapabilities,
  buildPrivilegeResolutionInput,
  buildTaskBecameInteractiveInput,
  buildTaskSummaryInput,
} from "./worker-prompt.js";
