import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as toml from "@iarna/toml";
import {
  applyWorkerCodexConfigPatch,
  buildWorkerCodexConfigPatch,
  workerCodexHomePath,
} from "./worker-codex-config.js";

test("buildWorkerCodexConfigPatch maps the live worker PATH and configured model into Codex config", () => {
  assert.deepEqual(
    buildWorkerCodexConfigPatch({
      PATH: "/root/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin",
      SANDY_CODEX_MODEL: "gpt-5.4-mini",
    }),
    {
      model: "gpt-5.4-mini",
      shell_environment_policy: {
        set: {
          PATH: "/root/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/usr/bin:/bin",
        },
      },
    },
  );

  assert.deepEqual(buildWorkerCodexConfigPatch({
    SANDY_CODEX_MODEL: "gpt-5.4-mini",
  }), {
    model: "gpt-5.4-mini",
  });

  assert.equal(buildWorkerCodexConfigPatch({}), undefined);
});

test("applyWorkerCodexConfigPatch preserves seeded MCP config while adding shell environment policy and model", async () => {
  const rootHome = await mkdtemp(join(tmpdir(), "sandy-worker-home-"));
  const codexHome = join(rootHome, ".codex");
  const configPath = join(codexHome, "config.toml");
  assert.equal(workerCodexHomePath, "/root/.codex");
  await mkdir(codexHome, { recursive: true });
  await writeFile(configPath, toml.stringify({
    mcp_servers: {
      todoist: {
        url: "http://sandy-mcp-proxy:8080/mcp/tasks/task-1/servers/todoist",
        bearer_token_env_var: "SANDY_MCP_PROXY_TOKEN",
      },
    },
  }), "utf8");

  await applyWorkerCodexConfigPatch({
    PATH: "/root/.bun/bin:/usr/bin:/bin",
    SANDY_CODEX_MODEL: "gpt-5.4-mini",
  }, codexHome);

  const parsed = toml.parse(await readFile(configPath, "utf8")) as {
    model: string;
    mcp_servers: Record<string, { url: string; bearer_token_env_var: string }>;
    shell_environment_policy: { set: { PATH: string } };
  };

  assert.equal(parsed.model, "gpt-5.4-mini");
  assert.deepEqual(parsed.mcp_servers, {
    todoist: {
      url: "http://sandy-mcp-proxy:8080/mcp/tasks/task-1/servers/todoist",
      bearer_token_env_var: "SANDY_MCP_PROXY_TOKEN",
    },
  });
  assert.deepEqual(parsed.shell_environment_policy, {
    set: {
      PATH: "/root/.bun/bin:/usr/bin:/bin",
    },
  });
});

test("applyWorkerCodexConfigPatch creates the worker Codex home when no seed was mounted", async () => {
  const rootHome = await mkdtemp(join(tmpdir(), "sandy-worker-home-"));
  const codexHome = join(rootHome, ".codex");
  const configPath = join(codexHome, "config.toml");

  await applyWorkerCodexConfigPatch({
    PATH: "/root/.bun/bin:/usr/bin:/bin",
    SANDY_CODEX_MODEL: "gpt-5.4-mini",
  }, codexHome);

  const parsed = toml.parse(await readFile(configPath, "utf8")) as {
    model: string;
    shell_environment_policy: { set: { PATH: string } };
  };

  assert.equal(parsed.model, "gpt-5.4-mini");
  assert.deepEqual(parsed.shell_environment_policy, {
    set: {
      PATH: "/root/.bun/bin:/usr/bin:/bin",
    },
  });
});
