import {existsSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import * as toml from "@iarna/toml";
import {z} from "zod";
import {resolveHomeDirectory} from "./home-directory.js";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const mcpTransportSchema = z.literal("streamable_http");

const DEFAULT_LOG_LEVEL: z.infer<typeof logLevelSchema> = "info";
const DEFAULT_SHARE_ROOT = "/tmp/sandy-shares";
const DEFAULT_STT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";
const LOCAL_DEFAULT_WORKER_IMAGE = "sandy-subagent:latest";
const LOCAL_DEFAULT_SIDECAR_IMAGE = "sandy-mcp-proxy:latest";

function defaultConfigPath(): string {
  return join(resolveHomeDirectory(), ".config", "sandy", "config.toml");
}

function defaultCodexAuthFilePath(): string {
  return join(resolveHomeDirectory(), ".codex", "auth.json");
}

function resolveDefaultImageReferences(env: EnvSource): {
  workerImage: string;
  sidecarImage: string;
} {
  const registry = env["SANDY_IMAGE_REGISTRY"]?.trim();
  const version = env["SANDY_IMAGE_VERSION"]?.trim();

  if (!registry || !version) {
    return {
      workerImage: LOCAL_DEFAULT_WORKER_IMAGE,
      sidecarImage: LOCAL_DEFAULT_SIDECAR_IMAGE,
    };
  }

  return {
    workerImage: `${registry}/sandy-subagent:${version}`,
    sidecarImage: `${registry}/sandy-mcp-proxy:${version}`,
  };
}

function buildSandyConfigSchema(defaultCodexAuthFilePath: string, defaultImages: {
  workerImage: string;
  sidecarImage: string;
}) {
  return z.object({
    logging: z.object({
      level: logLevelSchema.default(DEFAULT_LOG_LEVEL),
    }).default({
      level: DEFAULT_LOG_LEVEL,
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
      image: z.string().min(1).default(defaultImages.workerImage),
      share_root: z.string().min(1).default(DEFAULT_SHARE_ROOT),
    }).default({
      image: defaultImages.workerImage,
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
      sidecar_image: z.string().min(1).default(defaultImages.sidecarImage),
      servers: z.record(z.string(), z.object({
        transport: mcpTransportSchema,
        url: z.string().min(1).optional(),
        command: z.string().min(1).optional(),
        args: z.array(z.string()).default([]),
        env: z.record(z.string(), z.string()).default({}),
        oauth_scopes: z.array(z.string()).default([]),
      }).strict()).default({}),
    }).default({
      sidecar_image: defaultImages.sidecarImage,
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
  transport: "streamable_http";
  url: string;
  oauthScopes: string[];
};

type SandyAuthMode =
  | { mode: "api_key"; openAiApiKey: string }
  | { mode: "codex_auth_file"; codexAuthFile: string }
  | { mode: "ambient_codex_auth" };

type SandyConfig = {
  configFilePath: string;
  configDirectory: string;
  logLevel: z.infer<typeof logLevelSchema>;
  telegramBotToken: string;
  workerImage: string;
  mcpSidecarImage: string;
  shareRoot: string;
  sttApiKey: string | null;
  sttBaseUrl: string;
  sttModel: string;
  authMode: SandyAuthMode;
  mcpServers: Record<string, McpServerConfig>;
  persistentMcpApprovals: Record<string, string[]>;
};

type EnvSource = NodeJS.ProcessEnv;

function resolveConfigPath(env: EnvSource): string {
  const configured = env["SANDY_CONFIG_FILE"]?.trim();
  if (configured) {
    return resolve(configured);
  }
  return defaultConfigPath();
}

function expandHomeShorthand(path: string): string {
  if (path === "~") {
    return resolveHomeDirectory();
  }
  if (path.startsWith("~/")) {
    return join(resolveHomeDirectory(), path.slice(2));
  }
  return path;
}

function resolveCodexAuthFile(configuredPath: string | null | undefined): string | null {
  if (configuredPath) {
    const resolvedPath = resolve(expandHomeShorthand(configuredPath));
    if (resolvedPath !== defaultCodexAuthFilePath()) {
      return resolvedPath;
    }
    return existsSync(resolvedPath) ? resolvedPath : null;
  }
  return null;
}

function normalizeMcpServerConfig(config: SandyConfigFile["mcp"]["servers"][string]): McpServerConfig {
  if (!config.url) {
    throw new Error("MCP streamable_http servers require a url.");
  }

  return {
    transport: config.transport,
    url: config.url,
    oauthScopes: config.oauth_scopes,
  };
}

export function parseConfigToml(raw: string, configFilePath = defaultConfigPath(), env: EnvSource = process.env): SandyConfig {
  const parsed = parseConfigTomlFile(raw, env);
  const codexAuthFile = resolveCodexAuthFile(parsed.auth.codex_auth_file);
  const rawApiKey = parsed.auth.openai_api_key ?? null;
  const authMode: SandyAuthMode = codexAuthFile
    ? { mode: "codex_auth_file", codexAuthFile }
    : rawApiKey
      ? { mode: "api_key", openAiApiKey: rawApiKey }
      : { mode: "ambient_codex_auth" };

  return {
    configFilePath,
    configDirectory: dirname(configFilePath),
    logLevel: parsed.logging.level,
    telegramBotToken: parsed.telegram.bot_token,
    workerImage: parsed.worker.image,
    mcpSidecarImage: parsed.mcp.sidecar_image,
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
    return parseConfigToml(raw, configFilePath, env);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown config parse failure.";
    throw new Error(`Invalid Sandy config at ${configFilePath}: ${detail}`, { cause: error });
  }
}

export function renderConfigToml(value: SandyConfigFile): string {
  return toml.stringify(removeNulls(value) as toml.JsonMap);
}

export function parseConfigTomlFile(raw: string, env: EnvSource = process.env): SandyConfigFileData {
  // @iarna/toml attaches symbol-keyed metadata to parsed table objects.
  // Zod record schemas treat those symbols as keys and reject the value,
  // so normalize the tree into plain string-keyed objects before parsing.
  return buildSandyConfigSchema(
    defaultCodexAuthFilePath(),
    resolveDefaultImageReferences(env),
  ).parse(normalizeParsedToml(toml.parse(raw)));
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
