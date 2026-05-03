import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateOAuthStateFilesForStartup } from "./oauth-state-validator.js";

test("validateOAuthStateFilesForStartup rejects OAuth state files without tokens", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "sandy-oauth-state-"));
  const oauthDirectory = join(configDirectory, "oauth");
  const stateFilePath = join(oauthDirectory, "todoist.json");

  try {
    await mkdir(oauthDirectory, { recursive: true });
    await writeFile(stateFilePath, JSON.stringify({
      configuredServerUrl: "https://todoist.example/mcp",
      discoveryState: {
        authorizationServerUrl: "https://todoist.com",
      },
    }), "utf8");

    await assert.rejects(
      () => validateOAuthStateFilesForStartup(configDirectory, {
        todoist: {
          transport: "streamable_http",
          url: "https://todoist.example/mcp",
          oauthScopes: ["data:read"],
        },
      }),
      /Run "sandy mcp login todoist" before starting Sandy/,
    );
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("validateOAuthStateFilesForStartup accepts OAuth state files with tokens", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "sandy-oauth-state-"));
  const oauthDirectory = join(configDirectory, "oauth");
  const stateFilePath = join(oauthDirectory, "todoist.json");

  try {
    await mkdir(oauthDirectory, { recursive: true });
    await writeFile(stateFilePath, JSON.stringify({
      configuredServerUrl: "https://todoist.example/mcp",
      tokens: {
        access_token: "token-1",
        token_type: "Bearer",
      },
    }), "utf8");

    await validateOAuthStateFilesForStartup(configDirectory, {
      todoist: {
        transport: "streamable_http",
        url: "https://todoist.example/mcp",
        oauthScopes: ["data:read"],
      },
    });
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("validateOAuthStateFilesForStartup ignores missing state files", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "sandy-oauth-state-"));

  try {
    await validateOAuthStateFilesForStartup(configDirectory, {
      todoist: {
        transport: "streamable_http",
        url: "https://todoist.example/mcp",
        oauthScopes: ["data:read"],
      },
    });
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});

test("validateOAuthStateFilesForStartup ignores stdio MCP servers", async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), "sandy-oauth-state-"));

  try {
    await validateOAuthStateFilesForStartup(configDirectory, {
      spotify: {
        transport: "stdio",
        command: "node",
        args: ["build/index.js"],
        cwd: null,
        env: {},
      },
    });
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
});
