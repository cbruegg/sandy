import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
  assert.equal(config.codexAuthFile, "/tmp/codex-auth.json");
  assert.equal(config.openAiApiKey, null);
  assert.equal(config.authMode, "codex_auth_file");
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
    assert.deepEqual(config.mcpServers.todoist, {
      transport: "streamable_http",
      url: "https://todoist.example/mcp",
      command: null,
      args: [],
      env: {},
      oauthScopes: ["data:read"],
    });
    assert.deepEqual(config.persistentMcpApprovals.todoist, ["list_projects"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseConfigToml expands the default codex auth path when present", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-config-"));
  const fakeHome = await mkdtemp(join(root, "home-"));
  const authDir = join(fakeHome, ".codex");
  const authFilePath = join(authDir, "auth.json");
  const originalHome = process.env.HOME;

  try {
    await mkdir(authDir, { recursive: true });
    await writeFile(authFilePath, "{}");
    process.env.HOME = fakeHome;
    const config = parseConfigToml(`
[telegram]
bot_token = "telegram-token"
`);

    assert.equal(config.codexAuthFile, join(homedir(), ".codex", "auth.json"));
    assert.equal(config.authMode, "codex_auth_file");
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(root, { recursive: true, force: true });
  }
});
