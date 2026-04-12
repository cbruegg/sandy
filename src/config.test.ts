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

[auth]
openai_api_key = "sk-test"
codex_auth_file = "/tmp/codex-auth.json"
`);

  assert.equal(config.telegramBotToken, "telegram-token");
  assert.deepEqual(config.authMode, {
    mode: "codex_auth_file",
    codexAuthFile: "/tmp/codex-auth.json",
  });
  assert.equal(config.sttApiKey, null);
  assert.equal(config.sttBaseUrl, "https://api.openai.com/v1");
  assert.equal(config.sttModel, "gpt-4o-mini-transcribe");
});

test("parseConfigToml enables STT from the config file", () => {
  const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"

[stt]
api_key = "sk-stt"
base_url = "https://transcribe.example/v1/"
model = "custom-transcribe-model"
`);

  assert.equal(config.sttApiKey, "sk-stt");
  assert.equal(config.sttBaseUrl, "https://transcribe.example/v1/");
  assert.equal(config.sttModel, "custom-transcribe-model");
});

test("parseConfigToml falls back to local Docker image defaults when release image metadata is absent", () => {
  const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"
`, "/tmp/sandy-config.toml", {});

  assert.equal(config.workerImage, "sandy-subagent:latest");
  assert.equal(config.mcpSidecarImage, "sandy-mcp-proxy:latest");
});

test("parseConfigToml derives published Docker image defaults from release image metadata", () => {
  const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"
`, "/tmp/sandy-config.toml", {
    SANDY_IMAGE_REGISTRY: "ghcr.io/example",
    SANDY_IMAGE_VERSION: "sha-abcdef0123456789",
  });

  assert.equal(config.workerImage, "ghcr.io/example/sandy-subagent:sha-abcdef0123456789");
  assert.equal(config.mcpSidecarImage, "ghcr.io/example/sandy-mcp-proxy:sha-abcdef0123456789");
});

test("parseConfigToml allows overriding the MCP sidecar image explicitly", () => {
  const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"

[mcp]
sidecar_image = "custom-sidecar:dev"
`, "/tmp/sandy-config.toml", {
    SANDY_IMAGE_REGISTRY: "ghcr.io/example",
    SANDY_IMAGE_VERSION: "sha-abcdef0123456789",
  });

  assert.equal(config.mcpSidecarImage, "custom-sidecar:dev");
});

test("loadConfig reads the path from SANDY_CONFIG_FILE", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-config-"));
  const configFilePath = join(root, "config.toml");

  try {
    await writeFile(configFilePath, `
[telegram]
bot_token = "telegram-token"

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

[mcp.servers.local]
transport = "stdio"
command = "node"
`);
  }, /streamable_http|Invalid input/);
});
