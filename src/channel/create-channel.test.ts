import { test } from "bun:test";
import assert from "node:assert/strict";
import { createChannelAdapter } from "./create-channel.js";
import { TelegramBotApiAdapter } from "./telegram-adapter.js";
import { LocalTestChannelAdapter } from "./local-test-adapter.js";
import { MatrixChannelAdapter } from "./matrix-adapter.js";
import type { SandyConfig } from "../config.js";

function baseConfig(): Omit<SandyConfig, "channel"> {
  return {
    configFilePath: "/tmp/config.toml",
    configDirectory: "/tmp",
    skillsDirectory: null,
    skills: [],
    logLevel: "info",
    workerImage: "sandy-subagent:latest",
    mcpSidecarImage: "sandy-mcp-proxy:latest",
    networkGuardImage: "sandy-network-guard:latest",
    shareRoot: "/tmp/sandy-shares",
    workerPreinstall: {
      commands: [],
      refresh: "weekly",
    },
    workerNetwork: {
      mode: "public_internet_only",
      allowLocalCidrs: [],
    },
    sttApiKey: null,
    sttBaseUrl: "https://api.openai.com/v1",
    sttModel: "gpt-4o-mini-transcribe",
    authMode: {
      mode: "ambient_codex_auth",
    },
    mcpServers: {},
    persistentMcpApprovals: {},
    updateMode: "disabled",
    explicitImageOverrides: {
      workerImage: false,
      mcpSidecarImage: false,
    },
  };
}

test("createChannelAdapter returns the Telegram adapter for telegram configs", () => {
  const adapter = createChannelAdapter({
    ...baseConfig(),
    channel: {
      kind: "telegram",
      telegram: {
        botToken: "telegram-token",
        allowedUser: "@test",
      },
    },
  }, null, null);

  assert.ok(adapter instanceof TelegramBotApiAdapter);
});

test("createChannelAdapter returns the local-test adapter for local_test configs", () => {
  const adapter = createChannelAdapter({
    ...baseConfig(),
    channel: {
      kind: "local_test",
      localTest: {
        spoolRoot: "/tmp/sandy-local-test",
      },
    },
  }, null, null);

  assert.ok(adapter instanceof LocalTestChannelAdapter);
});

test("createChannelAdapter returns the Matrix adapter for matrix configs", () => {
  const adapter = createChannelAdapter({
    ...baseConfig(),
    channel: {
      kind: "matrix",
      matrix: {
        homeserverUrl: "https://matrix.example",
        botUserId: "@sandy:example.org",
        allowedUserId: "@owner:example.org",
      },
    },
  }, null, "matrix-token");

  assert.ok(adapter instanceof MatrixChannelAdapter);
});
