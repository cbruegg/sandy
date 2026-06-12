import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildMainAgentConfig } from "./app.js";
import { configureLogger, type LogLevel } from "./logger.js";

test("buildMainAgentConfig omits mempalace when unavailable", () => {
  const config = buildMainAgentConfig("/tmp/sandy-config", false);

  assert.deepEqual(config, {});
});

test("buildMainAgentConfig warns when enabled mempalace is unavailable", () => {
  const logs: Array<{ level: LogLevel; event: string; data?: Record<string, unknown> }> = [];
  configureLogger({
    minLevel: "debug",
    outputMode: "split",
    forwardLog: (payload) => {
      logs.push(payload);
    },
  });

  try {
    const config = buildMainAgentConfig("/dev/null", true);

    assert.deepEqual(config, {});
    const logEntry = logs.find((entry) => entry.event === "memory.mempalace_disabled_for_session");
    assert.ok(logEntry);
    assert.equal(logEntry.level, "warn");
    assert.equal(logEntry.data?.["reason"], "mcp_config_unavailable");
  } finally {
    configureLogger({
      minLevel: "info",
      outputMode: "split",
      forwardLog: undefined,
    });
  }
});
