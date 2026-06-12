import type { MainAgentLayerInput, MainAgentLayerResult } from "./types.js";
import { defaultCodexAuthFilePath } from "../config.js";
import { ChatGPTTokenBroker } from "../auth/chatgpt-token-broker.js";
import { CodexMainAgentController } from "../agent/main-agent-controller.js";
import { buildMainAgentConfig } from "../app.js";

export function createMainAgentLayer(input: MainAgentLayerInput): MainAgentLayerResult {
  const { config, mainAgentAppServer, skillService, hostMcpServerKeys, mempalaceAvailable } = input;

  const tokenBroker: ChatGPTTokenBroker | null = config.authMode.mode === "codex_auth_file"
    && config.authMode.codexAuthStrategy === "external_tokens"
    ? new ChatGPTTokenBroker(defaultCodexAuthFilePath())
    : null;

  const mainAgentConfig = buildMainAgentConfig(config.configDirectory, config.memory.enabled);

  const mainAgent = new CodexMainAgentController(
    mainAgentAppServer,
    config.agentModel,
    () => skillService.getSkills(),
    hostMcpServerKeys,
    config.httpTokens,
    mainAgentConfig,
    mempalaceAvailable,
  );

  const stop = async (): Promise<void> => {
    // mainAgentAppServer is closed by the foundation layer since it owns it.
  };

  return {
    name: "main-agent",
    tokenBroker,
    mainAgent,
    stop,
  };
}