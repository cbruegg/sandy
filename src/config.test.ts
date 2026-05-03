import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfigToml } from "./config.js";

test("parseConfigToml prefers Codex auth file over openai_api_key when both are configured", () => {
  const config = parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[auth]
openai_api_key = "sk-test"
codex_auth_file = "/tmp/codex-auth.json"
`);

  assert.equal(config.channel.kind, "telegram");
  assert.equal(config.channel.telegram.botToken, "telegram-token");
  assert.equal(config.channel.telegram.allowedUser, "123456");
  assert.deepEqual(config.authMode, {
    mode: "codex_auth_file",
    codexAuthFile: "/tmp/codex-auth.json",
  });
  assert.equal(config.sttApiKey, null);
  assert.equal(config.sttBaseUrl, "https://api.openai.com/v1");
  assert.equal(config.sttModel, "gpt-4o-mini-transcribe");
  assert.equal(config.agentModel, null);
  assert.equal(config.updateMode, "disabled");
  assert.deepEqual(config.workerPreinstall, {
    commands: [],
    refresh: "weekly",
  });
  assert.deepEqual(config.workerNetwork, {
    mode: "public_internet_only",
    allowLocalCidrs: [],
  });
});

test("parseConfigToml accepts numeric telegram allowed_user values", () => {
  const config = parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = 123456

[stt]
api_key = "sk-stt"
base_url = "https://transcribe.example/v1/"
model = "custom-transcribe-model"
`);

  assert.equal(config.sttApiKey, "sk-stt");
  assert.equal(config.channel.kind, "telegram");
  assert.equal(config.channel.telegram.allowedUser, "123456");
  assert.equal(config.sttBaseUrl, "https://transcribe.example/v1/");
  assert.equal(config.sttModel, "custom-transcribe-model");
  assert.equal(config.agentModel, null);
});

test("parseConfigToml accepts a custom agent model", () => {
  const config = parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[agent]
model = "gpt-5.5"
`);

  assert.equal(config.agentModel, "gpt-5.5");
});

test("parseConfigToml accepts telegram allowed_user usernames", () => {
  const config = parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "@cbruegg"
`);

  assert.equal(config.channel.kind, "telegram");
  assert.equal(config.channel.telegram.allowedUser, "@cbruegg");
});

test("parseConfigToml accepts matrix channel config", () => {
  const config = parseConfigToml(`
[channel]
kind = "matrix"

[channel.matrix]
homeserver_url = "https://matrix.example"
bot_user_id = "@sandy:example.org"
allowed_user_id = "@cbruegg:example.org"
`);

  assert.equal(config.channel.kind, "matrix");
  assert.equal(config.channel.matrix.homeserverUrl, "https://matrix.example");
  assert.equal(config.channel.matrix.botUserId, "@sandy:example.org");
  assert.equal(config.channel.matrix.allowedUserId, "@cbruegg:example.org");
});

test("parseConfigToml rejects invalid matrix bot_user_id values", () => {
  assert.throws(() => {
    parseConfigToml(`
[channel]
kind = "matrix"

[channel.matrix]
homeserver_url = "https://matrix.example"
bot_user_id = "sandy"
allowed_user_id = "@cbruegg:example.org"
`);
  }, /Matrix/);
});

test("parseConfigToml rejects invalid matrix allowed_user_id values", () => {
  assert.throws(() => {
    parseConfigToml(`
[channel]
kind = "matrix"

[channel.matrix]
homeserver_url = "https://matrix.example"
bot_user_id = "@sandy:example.org"
allowed_user_id = "cbruegg"
`);
  }, /Matrix allowed_user_id/);
});

test("parseConfigToml falls back to local Docker image defaults when release image metadata is absent", () => {
  const config = parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"
`, "/tmp/sandy-config.toml");

  assert.equal(config.workerImage, "sandy-subagent:latest");
  assert.equal(config.mcpSidecarImage, "sandy-mcp-proxy:latest");
  assert.equal(config.httpProxyImage, "sandy-http-proxy:latest");
  assert.equal(config.networkGuardImage, "sandy-network-guard:latest");
});

test("parseConfigToml derives published Docker image defaults from release image metadata", () => {
  const config = parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"
`, "/tmp/sandy-config.toml", {
    imageRegistry: "ghcr.io/example",
    gitRevision: "abcdef0123456789",
  });

  assert.equal(config.workerImage, "ghcr.io/example/sandy-subagent:sha-abcdef0123456789");
  assert.equal(config.mcpSidecarImage, "ghcr.io/example/sandy-mcp-proxy:sha-abcdef0123456789");
  assert.equal(config.httpProxyImage, "ghcr.io/example/sandy-http-proxy:sha-abcdef0123456789");
  assert.equal(config.networkGuardImage, "ghcr.io/example/sandy-network-guard:sha-abcdef0123456789");
});

test("parseConfigToml prefers explicit config image overrides over baked defaults", () => {
  const config = parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[updates]
mode = "disabled"

[worker]
image = "custom-worker:dev"

[mcp]
sidecar_image = "custom-sidecar:dev"

[http]
proxy_image = "custom-http-proxy:dev"
`, "/tmp/sandy-config.toml", {
    imageRegistry: "ghcr.io/example",
    gitRevision: "abcdef0123456789",
  });

  assert.equal(config.workerImage, "custom-worker:dev");
  assert.equal(config.mcpSidecarImage, "custom-sidecar:dev");
  assert.equal(config.httpProxyImage, "custom-http-proxy:dev");
  assert.deepEqual(config.explicitImageOverrides, {
    workerImage: true,
    mcpSidecarImage: true,
    httpProxyImage: true,
  });
});

test("parseConfigToml rejects explicit worker image overrides when update mode is relaunch", () => {
  assert.throws(() => {
    parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
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
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[updates]
mode = "relaunch"

[mcp]
sidecar_image = "custom-sidecar:dev"
`);
  }, /\[updates\]\.mode = "disabled"/);
});

test("parseConfigToml rejects explicit HTTP proxy image overrides when update mode is relaunch", () => {
  assert.throws(() => {
    parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[updates]
mode = "relaunch"

[http]
proxy_image = "custom-http-proxy:dev"
`);
  }, /\[updates\]\.mode = "disabled"/);
});

test("parseConfigToml rejects explicit image overrides when update mode is exit", () => {
  assert.throws(() => {
    parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
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
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[updates]
mode = "disabled"

[worker]
image = "custom-worker:dev"

[mcp]
sidecar_image = "custom-sidecar:dev"

[http]
proxy_image = "custom-http-proxy:dev"
`);

  assert.equal(config.updateMode, "disabled");
  assert.equal(config.workerImage, "custom-worker:dev");
  assert.equal(config.mcpSidecarImage, "custom-sidecar:dev");
  assert.equal(config.httpProxyImage, "custom-http-proxy:dev");
});

test("parseConfigToml keeps HTTP tokens separate from persistent host approvals", () => {
  const config = parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[http.tokens.api_key]
description = "API key for api.example.com"
value = "secret"

[approvals.http.api_key]
always_allow_hosts = ["api.example.com"]
`);

  assert.deepEqual(config.httpTokens, {
    api_key: { description: "API key for api.example.com", value: "secret" },
  });
  assert.deepEqual(config.persistentHttpApprovals, {
    api_key: ["api.example.com"],
  });
});

test("parseConfigToml requires descriptions for configured HTTP tokens", () => {
  assert.throws(() => {
    parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[http.tokens.api_key]
value = "secret"
`);
  }, /description/);
});

test("parseConfigToml parses worker preinstall config", () => {
  const config = parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
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

test("parseConfigToml parses worker network config", () => {
  const config = parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[worker.network]
allow_local_cidrs = ["192.168.1.0/24", "10.0.0.15", "fd00::/8"]
`);

  assert.deepEqual(config.workerNetwork, {
    mode: "public_internet_only",
    allowLocalCidrs: ["192.168.1.0/24", "10.0.0.15", "fd00::/8"],
  });
});

test("parseConfigToml rejects hostnames in worker network allow_local_cidrs", () => {
  assert.throws(() => {
    parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[worker.network]
allow_local_cidrs = ["raspinas"]
`);
  }, /must be an IP or CIDR literal/);
});

test("parseConfigToml rejects empty worker network CIDR prefixes", () => {
  assert.throws(() => {
    parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[worker.network]
allow_local_cidrs = ["10.0.0.5/"]
`);
  }, /must not end with an empty prefix/);
});

test("parseConfigToml rejects blank worker preinstall commands", () => {
  assert.throws(() => {
    parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
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
  const skillsDirectory = join(root, "skills");
  const todoistSkillDirectory = join(skillsDirectory, "todoist");

  try {
    await mkdir(todoistSkillDirectory, { recursive: true });
    await writeFile(configFilePath, `
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[mcp.servers.todoist]
transport = "streamable_http"
url = "https://todoist.example/mcp"
oauth_scopes = ["data:read"]

[approvals.mcp.todoist]
always_allow_tools = ["list_projects"]
`);
    await writeFile(join(todoistSkillDirectory, "SKILL.md"), `---
name: Adding task to Todoist
description: When the user asks you to add a task to Todoist, use this skill.
---

Use the Todoist MCP.
`);

    const config = loadConfig({
      SANDY_CONFIG_FILE: configFilePath,
    });

    assert.equal(config.configFilePath, configFilePath);
    assert.equal(config.channel.kind, "telegram");
    assert.equal(config.channel.telegram.botToken, "telegram-token");
    assert.equal(config.channel.telegram.allowedUser, "123456");
    assert.deepEqual(config.mcpServers["todoist"], {
      transport: "streamable_http",
      url: "https://todoist.example/mcp",
      oauthScopes: ["data:read"],
    });
    assert.deepEqual(config.persistentMcpApprovals["todoist"], ["list_projects"]);
    assert.equal(config.workerImage, "sandy-subagent:latest");
    assert.equal(config.mcpSidecarImage, "sandy-mcp-proxy:latest");
    assert.equal(config.httpProxyImage, "sandy-http-proxy:latest");
    assert.equal(config.skillsDirectory, skillsDirectory);
    assert.deepEqual(config.skills, [{
      name: "Adding task to Todoist",
      description: "When the user asks you to add a task to Todoist, use this skill.",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseConfigToml expands the default codex auth path when present", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-config-"));
  const fakeHome = await mkdtemp(join(root, "home-"));
  const authDir = join(fakeHome, ".codex");
  const authFilePath = join(authDir, "auth.json");

  try {
    await mkdir(authDir, { recursive: true });
    await writeFile(authFilePath, "{}");
    const config = parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"
`, undefined, undefined, {
      HOME: fakeHome,
    });

    assert.deepEqual(config.authMode, {
      mode: "codex_auth_file",
      codexAuthFile: authFilePath,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseConfigToml expands tilde-prefixed codex auth paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-config-"));
  const fakeHome = await mkdtemp(join(root, "home-"));
  const authDir = join(fakeHome, ".codex");
  const authFilePath = join(authDir, "auth.json");

  try {
    await mkdir(authDir, { recursive: true });
    await writeFile(authFilePath, "{}");

    const config = parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[auth]
codex_auth_file = "~/.codex/auth.json"
`, undefined, undefined, {
      HOME: fakeHome,
    });

    assert.deepEqual(config.authMode, {
      mode: "codex_auth_file",
      codexAuthFile: authFilePath,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseConfigToml accepts stdio MCP servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-config-"));
  const configFilePath = join(root, "config.toml");
  const localMcpDirectory = join(root, "tools", "local-mcp");

  try {
    const config = parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[mcp.servers.local]
transport = "stdio"
command = "node"
args = ["build/index.js"]
working_directory = "${localMcpDirectory}"

[mcp.servers.local.env]
FOO = "bar"
`, configFilePath);

    assert.deepEqual(config.mcpServers["local"], {
      transport: "stdio",
      command: "node",
      args: ["build/index.js"],
      workingDirectory: localMcpDirectory,
      env: {
        FOO: "bar",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseConfigToml expands tilde-prefixed stdio working_directory values", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-config-"));
  const fakeHome = await mkdtemp(join(root, "home-"));
  const workingDirectory = join(fakeHome, "mcp", "spotify");

  try {
    const config = parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[mcp.servers.spotify]
transport = "stdio"
command = "node"
working_directory = "~/mcp/spotify"
`, undefined, undefined, {
      HOME: fakeHome,
    });

    assert.deepEqual(config.mcpServers["spotify"], {
      transport: "stdio",
      command: "node",
      args: [],
      workingDirectory,
      env: {},
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseConfigToml rejects relative stdio working_directory values", () => {
  assert.throws(() => {
    parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "123456"

[mcp.servers.local]
transport = "stdio"
command = "node"
working_directory = "./tools/local-mcp"
`);
  }, /working_directory must be an absolute path/);
});

test("parseConfigToml rejects a missing telegram allowed_user", () => {
  assert.throws(() => {
    parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
`);
  }, /allowed_user|Invalid input/);
});

test("parseConfigToml rejects a blank telegram allowed_user", () => {
  assert.throws(() => {
    parseConfigToml(`
[channel]
kind = "telegram"

[channel.telegram]
bot_token = "telegram-token"
allowed_user = "   "
`);
  }, /allowed_user|Too small|Invalid input/);
});

test("parseConfigToml accepts local_test channel config without telegram settings", () => {
  const config = parseConfigToml(`
[channel]
kind = "local_test"

[channel.local_test]
spool_root = "/tmp/sandy-local-test"
`);

  assert.deepEqual(config.channel, {
    kind: "local_test",
    localTest: {
      spoolRoot: "/tmp/sandy-local-test",
    },
  });
});
