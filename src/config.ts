import {existsSync, readFileSync} from "node:fs";
import {homedir} from "node:os";
import {dirname, join, resolve} from "node:path";
import * as toml from "@iarna/toml";
import {z} from "zod";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const mcpTransportSchema = z.enum(["streamable_http", "stdio"]);

const DEFAULT_LOG_LEVEL: z.infer<typeof logLevelSchema> = "info";
const DEFAULT_DEBUG_LOGGING_ENABLED = false;
const DEFAULT_WORKER_IMAGE = "sandy-subagent:latest";
const DEFAULT_SHARE_ROOT = "/tmp/sandy-shares";
const DEFAULT_STT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";

function defaultConfigPath(): string {
  return join(homedir(), ".config", "sandy", "config.toml");
}

function defaultCodexAuthFilePath(): string {
  return join(homedir(), ".codex", "auth.json");
}

function buildSandyConfigSchema(defaultCodexAuthFilePath: string) {
  return z.object({
    logging: z.object({
      level: logLevelSchema.default(DEFAULT_LOG_LEVEL),
      debug: z.boolean().default(DEFAULT_DEBUG_LOGGING_ENABLED),
    }).default({
      level: DEFAULT_LOG_LEVEL,
      debug: DEFAULT_DEBUG_LOGGING_ENABLED,
    }),
    telegram: z.object({
      bot_token: z.string().min(1),
    }),
    auth: z.object({
      openai_api_key: z.string().min(1).nullable().optional(),
      codex_auth_file: z.string().min(1).nullable().default(defaultCodexAuthFilePath),
    }).default({
      codex_auth_file: defaultCodexAuthFilePath,
    }),
    worker: z.object({
      image: z.string().min(1).default(DEFAULT_WORKER_IMAGE),
      share_root: z.string().min(1).default(DEFAULT_SHARE_ROOT),
    }).default({
      image: DEFAULT_WORKER_IMAGE,
      share_root: DEFAULT_SHARE_ROOT,
    }),
    stt: z.object({
      api_key: z.string().min(1).nullable().optional(),
      base_url: z.string().min(1).default(DEFAULT_STT_BASE_URL),
      model: z.string().min(1).default(DEFAULT_STT_MODEL),
    }).default({
      base_url: DEFAULT_STT_BASE_URL,
      model: DEFAULT_STT_MODEL,
    }),
    mcp: z.object({
      servers: z.record(z.string(), z.object({
        transport: mcpTransportSchema,
        url: z.string().min(1).optional(),
        command: z.string().min(1).optional(),
        args: z.array(z.string()).default([]),
        env: z.record(z.string(), z.string()).default({}),
        oauth_scopes: z.array(z.string()).default([]),
      }).strict()).default({}),
    }).default({
      servers: {},
    }),
    approvals: z.object({
      mcp: z.record(z.string(), z.object({
        always_allow_tools: z.array(z.string()).default([]),
      }).strict()).default({}),
    }).default({
      mcp: {},
    }),
  }).strict();
}

type SandyConfigFile = z.infer<ReturnType<typeof buildSandyConfigSchema>>;
export type SandyConfigFileData = SandyConfigFile;

export type McpServerConfig = {
  transport: "streamable_http" | "stdio";
  url: string | null;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  oauthScopes: string[];
};

type SandyConfig = {
  configFilePath: string;
  configDirectory: string;
  logLevel: z.infer<typeof logLevelSchema>;
  debugLoggingEnabled: boolean;
  telegramBotToken: string;
  openAiApiKey: string | null;
  codexAuthFile: string | null;
  workerImage: string;
  shareRoot: string;
  sttApiKey: string | null;
  sttBaseUrl: string;
  sttModel: string;
  authMode: "api_key" | "codex_auth_file" | "ambient_codex_auth";
  mcpServers: Record<string, McpServerConfig>;
  persistentMcpApprovals: Record<string, string[]>;
};

type EnvSource = NodeJS.ProcessEnv;

function resolveConfigPath(env: EnvSource): string {
  const configured = env.SANDY_CONFIG_FILE?.trim();
  if (configured) {
    return resolve(configured);
  }
  return defaultConfigPath();
}

function resolveCodexAuthFile(configuredPath: string | null | undefined): string | null {
  if (configuredPath) {
    const resolvedPath = resolve(configuredPath);
    if (resolvedPath !== defaultCodexAuthFilePath()) {
      return resolvedPath;
    }
    return existsSync(resolvedPath) ? resolvedPath : null;
  }
  return null;
}

function normalizeMcpServerConfig(config: SandyConfigFile["mcp"]["servers"][string]): McpServerConfig {
  if (config.transport === "streamable_http" && !config.url) {
    throw new Error("MCP streamable_http servers require a url.");
  }
  if (config.transport === "stdio" && !config.command) {
    throw new Error("MCP stdio servers require a command.");
  }

  return {
    transport: config.transport,
    url: config.url ?? null,
    command: config.command ?? null,
    args: config.args,
    env: config.env,
    oauthScopes: config.oauth_scopes,
  };
}

export function parseConfigToml(raw: string, configFilePath = defaultConfigPath()): SandyConfig {
  const parsed = parseConfigTomlFile(raw);
  const codexAuthFile = resolveCodexAuthFile(parsed.auth.codex_auth_file);
  const rawApiKey = parsed.auth.openai_api_key ?? null;
  const openAiApiKey = codexAuthFile ? null : rawApiKey;
  const authMode = codexAuthFile ? "codex_auth_file" : rawApiKey ? "api_key" : "ambient_codex_auth";

  return {
    configFilePath,
    configDirectory: dirname(configFilePath),
    logLevel: parsed.logging.level,
    debugLoggingEnabled: parsed.logging.debug,
    telegramBotToken: parsed.telegram.bot_token,
    openAiApiKey,
    codexAuthFile,
    workerImage: parsed.worker.image,
    shareRoot: parsed.worker.share_root,
    sttApiKey: parsed.stt.api_key ?? null,
    sttBaseUrl: parsed.stt.base_url,
    sttModel: parsed.stt.model,
    authMode,
    mcpServers: Object.fromEntries(
      Object.entries(parsed.mcp.servers).map(([identifier, server]) => [identifier, normalizeMcpServerConfig(server)]),
    ),
    persistentMcpApprovals: Object.fromEntries(
      Object.entries(parsed.approvals.mcp).map(([identifier, approval]) => [identifier, approval.always_allow_tools]),
    ),
  };
}

export function loadConfig(env: EnvSource = process.env): SandyConfig {
  const configFilePath = resolveConfigPath(env);
  let raw: string;

  try {
    raw = readFileSync(configFilePath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown config file read failure.";
    throw new Error(`Failed to read Sandy config from ${configFilePath}: ${detail}`, { cause: error });
  }

  try {
    return parseConfigToml(raw, configFilePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown config parse failure.";
    throw new Error(`Invalid Sandy config at ${configFilePath}: ${detail}`, { cause: error });
  }
}

export function renderConfigToml(value: SandyConfigFile): string {
  return toml.stringify(removeNulls(value) as toml.JsonMap);
}

export function parseConfigTomlFile(raw: string): SandyConfigFileData {
  return buildSandyConfigSchema(defaultCodexAuthFilePath()).parse(normalizeParsedToml(toml.parse(raw)));
}

function removeNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => removeNulls(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, removeNulls(entry)]),
  );
}

function normalizeParsedToml(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeParsedToml(entry));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeParsedToml(entry)]),
  );
}
