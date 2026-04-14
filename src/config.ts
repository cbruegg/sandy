import {existsSync, readFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import * as toml from "@iarna/toml";
import {z} from "zod";
import { resolveDefaultImageReferences, type SandyBuildMetadata, type SandyImageDefaults } from "./build-metadata.js";
import {resolveHomeDirectory} from "./home-directory.js";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const mcpTransportSchema = z.literal("streamable_http");

const DEFAULT_LOG_LEVEL: z.infer<typeof logLevelSchema> = "info";
const DEFAULT_SHARE_ROOT = "/tmp/sandy-shares";
const DEFAULT_STT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";
const updateModeSchema = z.enum(["disabled", "relaunch", "exit"]);
const workerPreinstallRefreshSchema = z.enum(["weekly", "manual"]);
const DEFAULT_UPDATE_MODE: z.infer<typeof updateModeSchema> = "disabled";
const DEFAULT_WORKER_PREINSTALL_REFRESH: z.infer<typeof workerPreinstallRefreshSchema> = "weekly";

function defaultConfigPath(): string {
  return join(resolveHomeDirectory(), ".config", "sandy", "config.toml");
}

function defaultCodexAuthFilePath(): string {
  return join(resolveHomeDirectory(), ".codex", "auth.json");
}

function buildSandyConfigSchema(defaultCodexAuthFilePath: string, defaultImages: SandyImageDefaults) {
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
      preinstall: z.object({
        commands: z.array(z.string().trim().min(1)).default([]),
        refresh: workerPreinstallRefreshSchema.default(DEFAULT_WORKER_PREINSTALL_REFRESH),
      }).default({
        commands: [],
        refresh: DEFAULT_WORKER_PREINSTALL_REFRESH,
      }),
    }).default({
      image: defaultImages.workerImage,
      share_root: DEFAULT_SHARE_ROOT,
      preinstall: {
        commands: [],
        refresh: DEFAULT_WORKER_PREINSTALL_REFRESH,
      },
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
    updates: z.object({
      mode: updateModeSchema.default(DEFAULT_UPDATE_MODE),
    }).default({
      mode: DEFAULT_UPDATE_MODE,
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

export type SandyUpdateMode = z.infer<typeof updateModeSchema>;
type WorkerPreinstallRefreshMode = z.infer<typeof workerPreinstallRefreshSchema>;

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
  workerPreinstall: {
    commands: string[];
    refresh: WorkerPreinstallRefreshMode;
  };
  sttApiKey: string | null;
  sttBaseUrl: string;
  sttModel: string;
  authMode: SandyAuthMode;
  mcpServers: Record<string, McpServerConfig>;
  persistentMcpApprovals: Record<string, string[]>;
  updateMode: SandyUpdateMode;
  // The resolved image values alone are not enough here because a user may
  // explicitly pin an image to the same string as the baked default. The
  // updater conflict is about explicit configuration intent, not the final
  // resolved value.
  explicitImageOverrides: {
    workerImage: boolean;
    mcpSidecarImage: boolean;
  };
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

export function parseConfigToml(
  raw: string,
  configFilePath = defaultConfigPath(),
  buildMetadata?: SandyBuildMetadata,
): SandyConfig {
  const parsedFile = parseConfigTomlFile(raw, buildMetadata);
  const parsed = parsedFile.data;
  const codexAuthFile = resolveCodexAuthFile(parsed.auth.codex_auth_file);
  const rawApiKey = parsed.auth.openai_api_key ?? null;
  const authMode: SandyAuthMode = codexAuthFile
    ? { mode: "codex_auth_file", codexAuthFile }
    : rawApiKey
      ? { mode: "api_key", openAiApiKey: rawApiKey }
      : { mode: "ambient_codex_auth" };

  if (parsed.updates.mode !== "disabled"
    && (parsedFile.explicitImageOverrides.workerImage || parsedFile.explicitImageOverrides.mcpSidecarImage)) {
    const configuredImages = [
      parsedFile.explicitImageOverrides.workerImage ? "worker.image" : null,
      parsedFile.explicitImageOverrides.mcpSidecarImage ? "mcp.sidecar_image" : null,
    ].filter((value): value is string => value !== null);
    throw new Error(
      `Automatic updates require Sandy-managed Docker image defaults. Explicitly configured ${configuredImages.join(", ")} conflicts with [updates].mode = "${parsed.updates.mode}". Set [updates].mode = "disabled" to keep pinned images.`,
    );
  }

  return {
    configFilePath,
    configDirectory: dirname(configFilePath),
    logLevel: parsed.logging.level,
    telegramBotToken: parsed.telegram.bot_token,
    workerImage: parsed.worker.image,
    mcpSidecarImage: parsed.mcp.sidecar_image,
    shareRoot: parsed.worker.share_root,
    workerPreinstall: {
      commands: parsed.worker.preinstall.commands,
      refresh: parsed.worker.preinstall.refresh,
    },
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
    updateMode: parsed.updates.mode,
    explicitImageOverrides: parsedFile.explicitImageOverrides,
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

export function parseConfigTomlFile(
  raw: string,
  buildMetadata?: SandyBuildMetadata,
): {
  data: SandyConfigFileData;
  explicitImageOverrides: {
    workerImage: boolean;
    mcpSidecarImage: boolean;
  };
} {
  // @iarna/toml attaches symbol-keyed metadata to parsed table objects.
  // Zod record schemas treat those symbols as keys and reject the value,
  // so normalize the tree into plain string-keyed objects before parsing.
  const parsedToml = normalizeParsedToml(toml.parse(raw));
  // Track whether the config file explicitly set these fields. Comparing only
  // resolved values would miss the case where a user pins an image to the same
  // string as the baked default, which still needs to disable auto-updates.
  const explicitImageOverrides = {
    workerImage: hasOwnString(parsedToml, ["worker", "image"]),
    mcpSidecarImage: hasOwnString(parsedToml, ["mcp", "sidecar_image"]),
  };

  return {
    data: buildSandyConfigSchema(
      defaultCodexAuthFilePath(),
      resolveDefaultImageReferences(buildMetadata),
    ).parse(parsedToml),
    explicitImageOverrides,
  };
}

function hasOwnString(value: unknown, path: string[]): boolean {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return false;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string";
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
