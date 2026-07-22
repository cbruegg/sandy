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

function completedTurn(turnId: string): AppServerEvent {
  return {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: turnId, items: [], itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null } },
  };
}

class ConcurrentRecordingAgentClient implements AgentClient {
  readonly startedTurns: number[] = [];
  activeTurns = 0;
  maxActiveTurns = 0;
  private releaseFirstTurn: (() => void) | null = null;

  startThread(_profile: ThreadStartParams): Promise<string> {
    return Promise.resolve("thread-1");
  }

  async *streamTurn(
    _threadId: string,
    _input: Input,
    _onAuthRefresh: AuthRefreshCallback,
    _abortSignal?: AbortSignal,
    _onServerRequest?: ServerRequestHandler,
  ): AsyncGenerator<AppServerEvent> {
    this.startedTurns.push(this.startedTurns.length + 1);
    this.activeTurns += 1;
    this.maxActiveTurns = Math.max(this.maxActiveTurns, this.activeTurns);
    try {
      if (this.startedTurns.length === 1) {
        await new Promise<void>((resolve) => {
          this.releaseFirstTurn = resolve;
        });
      }
      yield completedTurn(`turn-${this.startedTurns.length}`);
    } finally {
      this.activeTurns -= 1;
    }
  }

  releaseFirst(): void {
    assert.ok(this.releaseFirstTurn);
    this.releaseFirstTurn();
  }
}

class TimeoutThenCompleteAgentClient implements AgentClient {
  callCount = 0;

  startThread(_profile: ThreadStartParams): Promise<string> {
    return Promise.resolve("thread-1");
  }

  async *streamTurn(
    _threadId: string,
    _input: Input,
    _onAuthRefresh: AuthRefreshCallback,
    abortSignal?: AbortSignal,
    _onServerRequest?: ServerRequestHandler,
  ): AsyncGenerator<AppServerEvent> {
    this.callCount += 1;
    if (this.callCount === 1) {
      await new Promise<void>((resolve) => {
        abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    yield completedTurn(`turn-${this.callCount}`);
  }
}

function createJob(id: string) {
  return {
    id,
    name: id,
    enabled: true,
    schedule: { kind: "cron" as const, expression: "0 9 * * *" },
    skillId: "missing-skill",
  };
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

test("MempalaceTaskMemoryContextCollector serializes concurrent collections", async () => {
  const configDirectory = mkdtempSync(join(import.meta.dirname, "../../tmp/sandy-memory-queue-test-"));
  const appServer = new ConcurrentRecordingAgentClient();
  const collector = new MempalaceTaskMemoryContextCollector(
    appServer,
    null,
    {},
    new SkillService(configDirectory),
  );

  const first = collector.collectForJobTask({ job: createJob("job-1"), workspacePath: null });
  const second = collector.collectForJobTask({ job: createJob("job-2"), workspacePath: null });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(appServer.startedTurns, [1]);
  appServer.releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(appServer.startedTurns, [1, 2]);
  assert.equal(appServer.maxActiveTurns, 1);
});

test("MempalaceTaskMemoryContextCollector times out a stuck collection and advances the queue", async () => {
  const configDirectory = mkdtempSync(join(import.meta.dirname, "../../tmp/sandy-memory-timeout-test-"));
  const appServer = new TimeoutThenCompleteAgentClient();
  const collector = new MempalaceTaskMemoryContextCollector(
    appServer,
    null,
    {},
    new SkillService(configDirectory),
    10,
  );

  const first = collector.collectForJobTask({ job: createJob("job-1"), workspacePath: null });
  const second = collector.collectForJobTask({ job: createJob("job-2"), workspacePath: null });

  assert.equal(await first, null);
  assert.equal(await second, null);
  assert.equal(appServer.callCount, 2);
});
