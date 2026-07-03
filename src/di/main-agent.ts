import type { MainAgentLayerInput, MainAgentLayerResult } from "./types.js";
import { defaultCodexAuthFilePath } from "../config.js";
import { ChatGPTTokenBroker } from "../auth/chatgpt-token-broker.js";
import { CODEX_API_KEY_ENV } from "../codex-client.js";
import { CodexAppServerClient } from "../codex-app-server-client/app-server-client.js";
import { CodexMainAgentController } from "../agent/main-agent-controller.js";
import { buildMainAgentConfig } from "../app.js";
import { MempalaceTaskMemoryContextCollector, NoopTaskMemoryContextCollector } from "../memory/task-memory-context-collector.js";

export async function createMainAgentLayer(input: MainAgentLayerInput): Promise<MainAgentLayerResult> {
  const { config, mainAgentCodexPath, mainAgentAppServer, skillService, hostMcpServerKeys, mempalaceAvailable } = input;

  const tokenBroker: ChatGPTTokenBroker | null = config.authMode.mode === "codex_auth_file"
    && config.authMode.codexAuthStrategy === "external_tokens"
    ? new ChatGPTTokenBroker(defaultCodexAuthFilePath())
    : null;

  const mainAgentConfig = buildMainAgentConfig(config.configDirectory, config.memory.enabled);
  const memoryContextAppServer = mempalaceAvailable
    ? await CodexAppServerClient.createWithAmbientAuth({
      codexPath: mainAgentCodexPath,
      env: config.authMode.mode === "api_key"
        ? { [CODEX_API_KEY_ENV]: config.authMode.openAiApiKey }
        : undefined,
    })
    : null;
  const memoryContextCollector = memoryContextAppServer
    ? new MempalaceTaskMemoryContextCollector(memoryContextAppServer, config.agentModel, mainAgentConfig, skillService)
    : new NoopTaskMemoryContextCollector();

  const mainAgent = new CodexMainAgentController(
    mainAgentAppServer,
    config.agentModel,
    () => skillService.getSkills(),
    hostMcpServerKeys,
    config.httpTokens,
    mainAgentConfig,
    mempalaceAvailable,
  );

  const stop = (): Promise<void> => {
    // mainAgentAppServer is closed by the foundation layer since it owns it.
    memoryContextAppServer?.close();
    return Promise.resolve();
  };

  return {
    name: "main-agent",
    tokenBroker,
    mainAgent,
    memoryContextCollector,
    stop,
  };
}
