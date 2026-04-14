import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfigToml } from "./config.js";

test("parseConfigToml prefers Codex auth file over openai_api_key when both are configured", () => {
  const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[auth]
openai_api_key = "sk-test"
codex_auth_file = "/tmp/codex-auth.json"
`);

  assert.equal(config.telegramBotToken, "telegram-token");
  assert.equal(config.telegramAllowedUser, "123456");
  assert.deepEqual(config.authMode, {
    mode: "codex_auth_file",
    codexAuthFile: "/tmp/codex-auth.json",
  });
  assert.equal(config.sttApiKey, null);
  assert.equal(config.sttBaseUrl, "https://api.openai.com/v1");
  assert.equal(config.sttModel, "gpt-4o-mini-transcribe");
  assert.equal(config.updateMode, "disabled");
  assert.deepEqual(config.workerPreinstall, {
    commands: [],
    refresh: "weekly",
  });
});

test("parseConfigToml accepts numeric telegram allowed_user values", () => {
  const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = 123456

[stt]
api_key = "sk-stt"
base_url = "https://transcribe.example/v1/"
model = "custom-transcribe-model"
`);

  assert.equal(config.sttApiKey, "sk-stt");
  assert.equal(config.telegramAllowedUser, "123456");
  assert.equal(config.sttBaseUrl, "https://transcribe.example/v1/");
  assert.equal(config.sttModel, "custom-transcribe-model");
});

test("parseConfigToml accepts telegram allowed_user usernames", () => {
  const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "@cbruegg"
`);

  assert.equal(config.telegramAllowedUser, "@cbruegg");
});

test("parseConfigToml falls back to local Docker image defaults when release image metadata is absent", () => {
  const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "123456"
`, "/tmp/sandy-config.toml");

  assert.equal(config.workerImage, "sandy-subagent:latest");
  assert.equal(config.mcpSidecarImage, "sandy-mcp-proxy:latest");
});

test("parseConfigToml derives published Docker image defaults from release image metadata", () => {
  const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "123456"
`, "/tmp/sandy-config.toml", {
    imageRegistry: "ghcr.io/example",
    gitRevision: "abcdef0123456789",
  });

  assert.equal(config.workerImage, "ghcr.io/example/sandy-subagent:sha-abcdef0123456789");
  assert.equal(config.mcpSidecarImage, "ghcr.io/example/sandy-mcp-proxy:sha-abcdef0123456789");
});

test("parseConfigToml prefers explicit config image overrides over baked defaults", () => {
  const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[updates]
mode = "disabled"

[worker]
image = "custom-worker:dev"

[mcp]
sidecar_image = "custom-sidecar:dev"
`, "/tmp/sandy-config.toml", {
    imageRegistry: "ghcr.io/example",
    gitRevision: "abcdef0123456789",
  });

  assert.equal(config.workerImage, "custom-worker:dev");
  assert.equal(config.mcpSidecarImage, "custom-sidecar:dev");
  assert.deepEqual(config.explicitImageOverrides, {
    workerImage: true,
    mcpSidecarImage: true,
  });
});

test("parseConfigToml rejects explicit worker image overrides when update mode is relaunch", () => {
  assert.throws(() => {
    parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[updates]
mode = "relaunch"

[worker]
image = "custom-worker:dev"
`);
  }, /\[updates\]\.mode = "disabled"/);
});

test("parseConfigToml rejects explicit MCP sidecar image overrides when update mode is relaunch", () => {
  assert.throws(() => {
    parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[updates]
mode = "relaunch"

[mcp]
sidecar_image = "custom-sidecar:dev"
`);
  }, /\[updates\]\.mode = "disabled"/);
});

test("parseConfigToml rejects explicit image overrides when update mode is exit", () => {
  assert.throws(() => {
    parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[updates]
mode = "exit"

[worker]
image = "custom-worker:dev"
`);
  }, /\[updates\]\.mode = "disabled"/);
});

test("parseConfigToml allows pinned Docker images when update mode is disabled explicitly", () => {
  const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[updates]
mode = "disabled"

[worker]
image = "custom-worker:dev"

[mcp]
sidecar_image = "custom-sidecar:dev"
`);

  assert.equal(config.updateMode, "disabled");
  assert.equal(config.workerImage, "custom-worker:dev");
  assert.equal(config.mcpSidecarImage, "custom-sidecar:dev");
});

test("parseConfigToml parses worker preinstall config", () => {
  const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[worker.preinstall]
commands = ["zypper --non-interactive install jq", "brew install gh"]
refresh = "manual"
`);

  assert.deepEqual(config.workerPreinstall, {
    commands: [
      "zypper --non-interactive install jq",
      "brew install gh",
    ],
    refresh: "manual",
  });
});

test("parseConfigToml rejects blank worker preinstall commands", () => {
  assert.throws(() => {
    parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[worker.preinstall]
commands = ["   "]
`);
  }, /Invalid input|Too small/);
});

test("loadConfig reads the path from SANDY_CONFIG_FILE", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-config-"));
  const configFilePath = join(root, "config.toml");

  try {
    await writeFile(configFilePath, `
[telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[mcp.servers.todoist]
transport = "streamable_http"
url = "https://todoist.example/mcp"
oauth_scopes = ["data:read"]

[approvals.mcp.todoist]
always_allow_tools = ["list_projects"]
`);

    const config = loadConfig({
      SANDY_CONFIG_FILE: configFilePath,
    });

    assert.equal(config.configFilePath, configFilePath);
    assert.equal(config.telegramBotToken, "telegram-token");
    assert.equal(config.telegramAllowedUser, "123456");
    assert.deepEqual(config.mcpServers["todoist"], {
      transport: "streamable_http",
      url: "https://todoist.example/mcp",
      oauthScopes: ["data:read"],
    });
    assert.deepEqual(config.persistentMcpApprovals["todoist"], ["list_projects"]);
    assert.equal(config.workerImage, "sandy-subagent:latest");
    assert.equal(config.mcpSidecarImage, "sandy-mcp-proxy:latest");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseConfigToml expands the default codex auth path when present", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-config-"));
  const fakeHome = await mkdtemp(join(root, "home-"));
  const authDir = join(fakeHome, ".codex");
  const authFilePath = join(authDir, "auth.json");
  const originalHome = process.env["HOME"];

  try {
    await mkdir(authDir, { recursive: true });
    await writeFile(authFilePath, "{}");
    process.env["HOME"] = fakeHome;
    const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "123456"
`);

    assert.deepEqual(config.authMode, {
      mode: "codex_auth_file",
      codexAuthFile: authFilePath,
    });
  } finally {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("parseConfigToml expands tilde-prefixed codex auth paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-config-"));
  const fakeHome = await mkdtemp(join(root, "home-"));
  const authDir = join(fakeHome, ".codex");
  const authFilePath = join(authDir, "auth.json");
  const originalHome = process.env["HOME"];

  try {
    await mkdir(authDir, { recursive: true });
    await writeFile(authFilePath, "{}");
    process.env["HOME"] = fakeHome;

    const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[auth]
codex_auth_file = "~/.codex/auth.json"
`);

    assert.deepEqual(config.authMode, {
      mode: "codex_auth_file",
      codexAuthFile: authFilePath,
    });
  } finally {
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("parseConfigToml rejects stdio MCP servers", () => {
  assert.throws(() => {
    parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[mcp.servers.local]
transport = "stdio"
command = "node"
`);
  }, /streamable_http|Invalid input/);
});

test("parseConfigToml rejects a missing telegram allowed_user", () => {
  assert.throws(() => {
    parseConfigToml(`
[telegram]
bot_token = "telegram-token"
`);
  }, /allowed_user|Invalid input/);
});

test("parseConfigToml rejects a blank telegram allowed_user", () => {
  assert.throws(() => {
    parseConfigToml(`
[telegram]
bot_token = "telegram-token"
allowed_user = "   "
`);
  }, /allowed_user|Too small|Invalid input/);
});
