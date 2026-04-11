import test from "node:test";
import assert from "node:assert/strict";
import { configureLogger, logger } from "./logger.js";

test("logger.debugContent writes debug logs only when logging level is debug", () => {
  const originalConsoleLog = console.log;
  const lines: string[] = [];
  console.log = (line?: unknown) => {
    lines.push(String(line));
  };

  try {
    configureLogger({
      minLevel: "debug",
    });
    logger.debugContent("test.enabled", {
      text: "hello",
    });

    configureLogger({
      minLevel: "info",
    });
    logger.debugContent("test.disabled", {
      text: "goodbye",
    });
  } finally {
    console.log = originalConsoleLog;
    configureLogger({
      minLevel: "info",
    });
  }

  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]) as {
    level: string;
    event: string;
    data: { text: string };
  };
  assert.equal(payload.level, "debug");
  assert.equal(payload.event, "test.enabled");
  assert.equal(payload.data.text, "hello");
});
