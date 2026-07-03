import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Input } from "@openai/codex-sdk";
import type { AgentClient, AuthRefreshCallback, AppServerEvent, ServerRequestHandler } from "../codex-app-server-client/app-server-client.js";
import type { ThreadStartParams } from "../codex-app-server-client/generated/v2";
import { SkillService } from "../skills.js";
import { MempalaceTaskMemoryContextCollector } from "./task-memory-context-collector.js";

class RecordingAgentClient implements AgentClient {
  public readonly inputs: Input[] = [];

  startThread(_profile: ThreadStartParams): Promise<string> {
    return Promise.resolve("thread-1");
  }

  async *streamTurn(
    _threadId: string,
    input: Input,
    _onAuthRefresh: AuthRefreshCallback,
    _abortSignal?: AbortSignal,
    _onServerRequest?: ServerRequestHandler,
  ): AsyncGenerator<AppServerEvent> {
    this.inputs.push(input);
    yield {
      method: "item/completed",
      params: { item: { type: "agentMessage", text: "none", id: "item-1", phase: null, memoryCitation: null }, threadId: "thread-1", turnId: "turn-1", completedAtMs: 0 },
    };
    yield {
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", items: [], itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null } },
    };
  }
}

test("MempalaceTaskMemoryContextCollector includes resolved skill details in prompt", async () => {
  const configDirectory = mkdtempSync(join(import.meta.dirname, "../../tmp/sandy-memory-test-"));
  await mkdir(join(configDirectory, "skills", "report-skill"), { recursive: true });
  await writeFile(
    join(configDirectory, "skills", "report-skill", "SKILL.md"),
    [
      "---",
      "name: Report Skill",
      "description: Generate scheduled reports.",
      "---",
      "",
      "Use the private dashboard and summarize only important changes.",
    ].join("\n"),
    "utf8",
  );
  const appServer = new RecordingAgentClient();
  const collector = new MempalaceTaskMemoryContextCollector(
    appServer,
    null,
    {},
    new SkillService(configDirectory),
  );

  await collector.collectForJobTask({
    job: {
      id: "weekly-report",
      name: "Weekly report",
      enabled: true,
      schedule: { kind: "cron", expression: "0 9 * * 1" },
      skillId: "report-skill",
    },
    workspacePath: null,
  });

  const input = appServer.inputs[0];
  assert.ok(Array.isArray(input));
  const text = input[0]?.type === "text" ? input[0].text : "";
  assert.match(text, /- skill name: Report Skill/);
  assert.match(text, /- skill description: Generate scheduled reports\./);
  assert.match(text, /Use the private dashboard and summarize only important changes\./);
});
