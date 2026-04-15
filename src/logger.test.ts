import { test } from "bun:test";
import assert from "node:assert/strict";
import { configureLogger, logger } from "./logger.js";

test("logger.debugContent writes debug logs only when logging level is debug", () => {
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const lines: string[] = [];
  console.log = (line?: unknown) => {
    lines.push(String(line));
  };
  console.error = (line?: unknown) => {
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
    console.error = originalConsoleError;
    configureLogger({
      minLevel: "info",
      outputMode: "split",
    });
  }

  assert.equal(lines.length, 1);
  const firstLine = lines[0];
  assert.ok(firstLine);
  const payload = JSON.parse(firstLine) as {
    level: string;
    event: string;
    data: { text: string };
  };
  assert.equal(payload.level, "debug");
  assert.equal(payload.event, "test.enabled");
  assert.equal(payload.data.text, "hello");
});

test("logger can route info logs to stderr", () => {
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  console.log = (line?: unknown) => {
    stdoutLines.push(String(line));
  };
  console.error = (line?: unknown) => {
    stderrLines.push(String(line));
  };

  try {
    configureLogger({
      minLevel: "info",
      outputMode: "stderr",
    });
    logger.info("test.stderr_info");
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    configureLogger({
      minLevel: "info",
      outputMode: "split",
    });
  }

  assert.equal(stdoutLines.length, 0);
  assert.equal(stderrLines.length, 1);
  const payload = JSON.parse(stderrLines[0] ?? "{}") as {
    level: string;
    event: string;
  };
  assert.equal(payload.level, "info");
  assert.equal(payload.event, "test.stderr_info");
});
