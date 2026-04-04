import test from "node:test";
import assert from "node:assert/strict";

test("logger.debugContent writes info logs only when SANDY_DEBUG is true", async () => {
  type LoggerModule = typeof import("./logger.js");
  const originalDebug = process.env.SANDY_DEBUG;
  const originalLevel = process.env.SANDY_LOG_LEVEL;
  const originalConsoleLog = console.log;
  const lines: string[] = [];
  console.log = (line?: unknown) => {
    lines.push(String(line));
  };

  try {
    process.env.SANDY_LOG_LEVEL = "info";
    process.env.SANDY_DEBUG = "true";
    const enabledModule = await import(`./logger.js?enabled=${Date.now()}`) as LoggerModule;
    const { logger } = enabledModule;
    logger.debugContent("test.enabled", {
      text: "hello",
    });

    process.env.SANDY_DEBUG = "false";
    const disabledModule = await import(`./logger.js?disabled=${Date.now()}`) as LoggerModule;
    const { logger: disabledLogger } = disabledModule;
    disabledLogger.debugContent("test.disabled", {
      text: "goodbye",
    });
  } finally {
    console.log = originalConsoleLog;
    if (originalDebug === undefined) {
      delete process.env.SANDY_DEBUG;
    } else {
      process.env.SANDY_DEBUG = originalDebug;
    }
    if (originalLevel === undefined) {
      delete process.env.SANDY_LOG_LEVEL;
    } else {
      process.env.SANDY_LOG_LEVEL = originalLevel;
    }
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
