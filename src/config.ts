import {existsSync, readFileSync} from "node:fs";
import {isIP} from "node:net";
import {dirname, isAbsolute, join, resolve} from "node:path";
import * as toml from "@iarna/toml";
import {z} from "zod";
import { resolveDefaultImageReferences, type SandyBuildMetadata, type SandyImageDefaults } from "./build-metadata.js";
import {resolveHomeDirectory} from "./home-directory.js";
import {discoverSkills, type SkillMetadata} from "./skills.js";
import { sandyMcpServerId } from "./subagent/worker-tools.js";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const mcpTransportSchema = z.literal("streamable_http");
const mcpStdioTransportSchema = z.literal("stdio");

const DEFAULT_LOG_LEVEL: z.infer<typeof logLevelSchema> = "info";
const DEFAULT_SHARE_ROOT = "/tmp/sandy-shares";
const DEFAULT_STT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe";
const updateModeSchema = z.enum(["disabled", "relaunch", "exit"]);
const workerPreinstallRefreshSchema = z.enum(["weekly", "manual"]);
const DEFAULT_UPDATE_MODE: z.infer<typeof updateModeSchema> = "disabled";
const DEFAULT_WORKER_PREINSTALL_REFRESH: z.infer<typeof workerPreinstallRefreshSchema> = "weekly";
const workerNetworkModeSchema = z.enum(["public_internet_only", "unrestricted"]);
const DEFAULT_WORKER_NETWORK_MODE: z.infer<typeof workerNetworkModeSchema> = "public_internet_only";

function defaultConfigPath(): string {
  return join(resolveHomeDirectory(), ".config", "sandy", "config.toml");
}

function defaultCodexAuthFilePath(): string {
  return join(resolveHomeDirectory(), ".codex", "auth.json");
}

function normalizeTelegramAllowedUser(value: string | number): string {
  return String(value).trim();
}

const matrixAllowedUserIdSchema = z.string().trim().min(1).regex(/^@.+:.+$/, {
  message: "Matrix allowed_user_id must be a full Matrix user ID like @user:example.org.",
});
function normalizeWorkerNetworkAllowLocalEntry(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("worker.network.allow_local_cidrs entries must not be empty.");
  }

  const [rawAddress, rawPrefix, ...rest] = normalized.split("/");
  const address = rawAddress ?? "";
  const family = isIP(address);
  if (family === 0) {
    throw new Error(`worker.network.allow_local_cidrs entry "${normalized}" must be an IP or CIDR literal.`);
  }
  if (rest.length > 0) {
    throw new Error(`worker.network.allow_local_cidrs entry "${normalized}" must contain at most one slash.`);
  }
  if (rawPrefix === undefined) {
    return normalized;
  }
  if (rawPrefix === "") {
    throw new Error(`worker.network.allow_local_cidrs entry "${normalized}" must not end with an empty prefix.`);
  }

  const prefix = Number(rawPrefix);
  const maxPrefix = family === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(`worker.network.allow_local_cidrs entry "${normalized}" has an invalid prefix length.`);
  }

  return `${address}/${prefix}`;
}

const sandyChannelKindSchema = z.enum(["telegram", "matrix", "local_test"]);

const localTestChannelSchema = z.object({
  spool_root: z.string().min(1),
});

const matrixChannelSchema = z.object({
  homeserver_url: z.string().min(1),
  bot_user_id: matrixAllowedUserIdSchema,
  allowed_user_id: matrixAllowedUserIdSchema,
});

const telegramChannelSchema = z.object({
  bot_token: z.string().min(1),
  allowed_user: z.union([z.string(), z.number().int()])
    .transform(normalizeTelegramAllowedUser)
    .pipe(z.string().min(1)),
});

function buildSandyConfigSchema(defaultCodexAuthFilePath: string, defaultImages: SandyImageDefaults) {
  return z.object({
    logging: z.object({
      level: logLevelSchema.default(DEFAULT_LOG_LEVEL),
    }).default({
      level: DEFAULT_LOG_LEVEL,
    }),
    channel: z.object({
      kind: sandyChannelKindSchema.default("telegram"),
      telegram: telegramChannelSchema.optional(),
      matrix: matrixChannelSchema.optional(),
      local_test: localTestChannelSchema.optional(),
    }).superRefine((value, ctx) => {
      if (value.kind === "telegram" && !value.telegram) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["telegram"],
          message: "channel.telegram is required when channel.kind is \"telegram\".",
        });
      }
      if (value.kind === "matrix" && !value.matrix) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["matrix"],
          message: "channel.matrix is required when channel.kind is \"matrix\".",
        });
      }
      if (value.kind === "local_test" && !value.local_test) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["local_test"],
          message: "channel.local_test is required when channel.kind is \"local_test\".",
        });
      }
    }).default({
      kind: "telegram",
    }),
    auth: z.object({
      openai_api_key: z.string().min(1).nullable().optional(),
      codex_auth_file: z.string().min(1).nullable().default(defaultCodexAuthFilePath),
    }).default({
      codex_auth_file: defaultCodexAuthFilePath,
    }),
    agent: z.object({
      model: z.string().min(1).optional(),
    }).optional(),
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
      network: z.object({
        mode: workerNetworkModeSchema.default(DEFAULT_WORKER_NETWORK_MODE),
        allow_local_cidrs: z.array(z.string().transform(normalizeWorkerNetworkAllowLocalEntry))
          .default([]),
      }).default({
        mode: DEFAULT_WORKER_NETWORK_MODE,
        allow_local_cidrs: [],
      }),
    }).default({
      image: defaultImages.workerImage,
      share_root: DEFAULT_SHARE_ROOT,
      preinstall: {
        commands: [],
        refresh: DEFAULT_WORKER_PREINSTALL_REFRESH,
      },
      network: {
        mode: DEFAULT_WORKER_NETWORK_MODE,
        allow_local_cidrs: [],
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
      servers: z.record(z.string(), z.discriminatedUnion("transport", [
        z.object({
          transport: mcpTransportSchema,
          url: z.string().min(1),
          oauth_scopes: z.array(z.string()).default([]),
        }).strict(),
        z.object({
          transport: mcpStdioTransportSchema,
          command: z.string().min(1),
          args: z.array(z.string()).default([]),
          working_directory: z.string().min(1).optional(),
          env: z.record(z.string(), z.string()).default({}),
        }).strict(),
      ])).default({}),
    }).default({
      sidecar_image: defaultImages.sidecarImage,
      servers: {},
    }),
    http: z.object({
      proxy_image: z.string().min(1).default(defaultImages.httpProxyImage),
      tokens: z.record(z.string(), z.object({
        description: z.string().trim().min(1),
        value: z.string().min(1),
      }).strict()).default({}),
    }).default({
      proxy_image: defaultImages.httpProxyImage,
      tokens: {},
    }),
    approvals: z.object({
      mcp: z.record(z.string(), z.object({
        always_allow_tools: z.array(z.string()).default([]),
        always_allow_resources: z.array(z.string()).default([]),
      }).strict()).default({}),
      http: z.record(z.string(), z.object({
        always_allow_hosts: z.array(z.string()).default([]),
      }).strict()).default({}),
    }).default({
      mcp: {},
      http: {},
    }),
    updates: z.object({
      mode: updateModeSchema.default(DEFAULT_UPDATE_MODE),
    }).default({
      mode: DEFAULT_UPDATE_MODE,
    }),
  }).strict();
}

type SandyConfigFile = z.infer<ReturnType<typeof buildSandyConfigSchema>>;
type SandyConfigFileData = SandyConfigFile;

export type McpServerConfig =
  | {
    transport: "streamable_http";
    url: string;
    oauthScopes: string[];
  }
  | {
    transport: "stdio";
    command: string;
    args: string[];
    workingDirectory: string | null;
    env: Record<string, string>;
  };

export type HttpTokenConfig = {
  description: string;
  value: string;
};

export type SandyUpdateMode = z.infer<typeof updateModeSchema>;
type WorkerPreinstallRefreshMode = z.infer<typeof workerPreinstallRefreshSchema>;
type WorkerNetworkMode = z.infer<typeof workerNetworkModeSchema>;
export type WorkerNetworkConfig = {
  mode: WorkerNetworkMode;
  allowLocalCidrs: string[];
};

type SandyAuthMode =
  | { mode: "api_key"; openAiApiKey: string }
  | { mode: "codex_auth_file"; codexAuthFile: string }
  | { mode: "ambient_codex_auth" };

export type SandyConfig = {
  configFilePath: string;
  configDirectory: string;
  skillsDirectory: string | null;
  skills: SkillMetadata[];
  logLevel: z.infer<typeof logLevelSchema>;
  channel:
    | {
      kind: "telegram";
      telegram: {
          botToken: string;
          allowedUser: string;
        };
      }
    | {
      kind: "matrix";
      matrix: {
          homeserverUrl: string;
          botUserId: string;
          allowedUserId: string;
        };
      }
    | {
      kind: "local_test";
      localTest: {
          spoolRoot: string;
        };
      };
  workerImage: string;
  mcpSidecarImage: string;
  httpProxyImage: string;
  networkGuardImage: string;
  shareRoot: string;
  agentModel: string | null;
  workerPreinstall: {
    commands: string[];
    refresh: WorkerPreinstallRefreshMode;
  };
  workerNetwork: WorkerNetworkConfig;
  sttApiKey: string | null;
  sttBaseUrl: string;
  sttModel: string;
  authMode: SandyAuthMode;
  mcpServers: Record<string, McpServerConfig>;
  httpTokens: Record<string, HttpTokenConfig>;
  persistentMcpApprovals: Record<string, string[]>;
  persistentMcpResourceApprovals: Record<string, string[]>;
  persistentHttpApprovals: Record<string, string[]>;
  updateMode: SandyUpdateMode;
  // The resolved image values alone are not enough here because a user may
  // explicitly pin an image to the same string as the baked default. The
  // updater conflict is about explicit configuration intent, not the final
  // resolved value.
  explicitImageOverrides: {
    workerImage: boolean;
    mcpSidecarImage: boolean;
    httpProxyImage: boolean;
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

function resolveMcpWorkingDirectory(configuredPath: string): string {
  const expandedPath = expandHomeShorthand(configuredPath);
  if (!isAbsolute(expandedPath)) {
    throw new Error('mcp.servers.<name>.working_directory must be an absolute path or start with "~".');
  }
  return resolve(expandedPath);
}

function normalizeMcpServerConfig(config: SandyConfigFile["mcp"]["servers"][string]): McpServerConfig {
  if (config.transport === "streamable_http") {
    return {
      transport: config.transport,
      url: config.url,
      oauthScopes: config.oauth_scopes,
    };
  }

  return {
    transport: config.transport,
    command: config.command,
    args: config.args,
    workingDirectory: config.working_directory
      ? resolveMcpWorkingDirectory(config.working_directory)
      : null,
    env: config.env,
  };
}

export function parseConfigToml(
  raw: string,
  configFilePath = defaultConfigPath(),
  buildMetadata?: SandyBuildMetadata,
): SandyConfig {
  const parsedFile = parseConfigTomlFile(raw, buildMetadata);
  const parsed = parsedFile.data;
  const defaultImages = resolveDefaultImageReferences(buildMetadata);
  const configDirectory = dirname(configFilePath);
  const discoveredSkills = discoverSkills(configDirectory);
  const codexAuthFile = resolveCodexAuthFile(parsed.auth.codex_auth_file);
  const rawApiKey = parsed.auth.openai_api_key ?? null;
  const authMode: SandyAuthMode = codexAuthFile
    ? { mode: "codex_auth_file", codexAuthFile }
    : rawApiKey
      ? { mode: "api_key", openAiApiKey: rawApiKey }
      : { mode: "ambient_codex_auth" };

  if (parsed.mcp.servers[sandyMcpServerId]) {
    throw new Error(`mcp.servers.${sandyMcpServerId} is reserved for Sandy's built-in worker tools.`);
  }

  if (parsed.updates.mode !== "disabled"
    && (
      parsedFile.explicitImageOverrides.workerImage
      || parsedFile.explicitImageOverrides.mcpSidecarImage
      || parsedFile.explicitImageOverrides.httpProxyImage
    )) {
    const configuredImages = [
      parsedFile.explicitImageOverrides.workerImage ? "worker.image" : null,
      parsedFile.explicitImageOverrides.mcpSidecarImage ? "mcp.sidecar_image" : null,
      parsedFile.explicitImageOverrides.httpProxyImage ? "http.proxy_image" : null,
    ].filter((value): value is string => value !== null);
    throw new Error(
      `Automatic updates require Sandy-managed Docker image defaults. Explicitly configured ${configuredImages.join(", ")} conflicts with [updates].mode = "${parsed.updates.mode}". Set [updates].mode = "disabled" to keep pinned images.`,
    );
  }

  return {
    configFilePath,
    configDirectory,
    skillsDirectory: discoveredSkills.skillsDirectory,
    skills: discoveredSkills.skills,
    logLevel: parsed.logging.level,
    channel: buildChannelConfig(parsed.channel),
    workerImage: parsed.worker.image,
    mcpSidecarImage: parsed.mcp.sidecar_image,
    httpProxyImage: parsed.http.proxy_image,
    networkGuardImage: defaultImages.networkGuardImage,
    shareRoot: parsed.worker.share_root,
    agentModel: parsed.agent?.model ?? null,
    workerPreinstall: {
      commands: parsed.worker.preinstall.commands,
      refresh: parsed.worker.preinstall.refresh,
    },
    workerNetwork: {
      mode: parsed.worker.network.mode,
      allowLocalCidrs: parsed.worker.network.allow_local_cidrs,
    },
    sttApiKey: parsed.stt.api_key ?? null,
    sttBaseUrl: parsed.stt.base_url,
    sttModel: parsed.stt.model,
    authMode,
    mcpServers: Object.fromEntries(
      Object.entries(parsed.mcp.servers).map(([identifier, server]) => [identifier, normalizeMcpServerConfig(server)]),
    ),
    httpTokens: Object.fromEntries(
      Object.entries(parsed.http.tokens).map(([identifier, token]) => [identifier, {
        description: token.description,
        value: token.value,
      }]),
    ),
    persistentMcpApprovals: Object.fromEntries(
      Object.entries(parsed.approvals.mcp).map(([identifier, approval]) => [identifier, approval.always_allow_tools]),
    ),
    persistentMcpResourceApprovals: Object.fromEntries(
      Object.entries(parsed.approvals.mcp).map(([identifier, approval]) => [identifier, approval.always_allow_resources]),
    ),
    persistentHttpApprovals: Object.fromEntries(
      Object.entries(parsed.approvals.http).map(([identifier, approval]) => [identifier, approval.always_allow_hosts]),
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

function parseConfigTomlFile(
  raw: string,
  buildMetadata?: SandyBuildMetadata,
): {
  data: SandyConfigFileData;
  explicitImageOverrides: {
    workerImage: boolean;
    mcpSidecarImage: boolean;
    httpProxyImage: boolean;
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
    httpProxyImage: hasOwnString(parsedToml, ["http", "proxy_image"]),
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

function buildChannelConfig(channel: SandyConfigFile["channel"]): SandyConfig["channel"] {
  switch (channel.kind) {
    case "telegram":
      return {
        kind: "telegram",
        telegram: {
          botToken: channel.telegram!.bot_token,
          allowedUser: channel.telegram!.allowed_user,
        },
      };
    case "matrix":
      return {
        kind: "matrix",
        matrix: {
          homeserverUrl: channel.matrix!.homeserver_url,
          botUserId: channel.matrix!.bot_user_id,
          allowedUserId: channel.matrix!.allowed_user_id,
        },
      };
    case "local_test":
      return {
        kind: "local_test",
        localTest: {
          spoolRoot: channel.local_test!.spool_root,
        },
      };
  }
}

export function normalizeParsedToml(value: unknown): unknown {
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
