import test from "node:test";
import assert from "node:assert/strict";
import { configureLogger, logger } from "./logger.js";

test("logger.debugContent writes info logs only when debug content logging is enabled", () => {
  const originalConsoleLog = console.log;
  const lines: string[] = [];
  console.log = (line?: unknown) => {
    lines.push(String(line));
  };

  try {
    configureLogger({
      minLevel: "info",
      debugContentEnabled: true,
    });
    logger.debugContent("test.enabled", {
      text: "hello",
    });

    configureLogger({
      minLevel: "info",
      debugContentEnabled: false,
    });
    logger.debugContent("test.disabled", {
      text: "goodbye",
    });
  } finally {
    console.log = originalConsoleLog;
    configureLogger({
      minLevel: "info",
      debugContentEnabled: false,
    });
  }

  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]) as {
    level: string;
    event: string;
    data: { text: string };
  };
  assert.equal(payload.level, "info");
  assert.equal(payload.event, "test.enabled");
  assert.equal(payload.data.text, "hello");
});
