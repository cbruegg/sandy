import { test } from "bun:test";
import assert from "node:assert/strict";
import { createMainProgram } from "./main-cli.js";

test("main CLI starts the app when no args are provided", async () => {
  let started = false;
  const command = createMainProgram({
    startApp: async () => {
      started = true;
    },
  }, createTestIo({ stdout: "", stderr: "" }));

  await command.parseAsync([], { from: "user" });
  assert.equal(started, true);
});

test("main CLI prints help without starting the app", async () => {
  let started = false;
  const output = { stdout: "", stderr: "" };
  const command = createMainProgram({
    startApp: async () => {
      started = true;
    },
  }, createTestIo(output));

  await command.parseAsync(["--help"], { from: "user" });
  assert.equal(started, false);
  assert.match(output.stdout, /Usage: sandy/);
});

function createTestIo(output: { stdout: string; stderr: string }) {
  return {
    stdout: {
      write: (text: string) => {
        output.stdout += text;
        return true;
      },
    } as unknown as NodeJS.WriteStream,
    stderr: {
      write: (text: string) => {
        output.stderr += text;
        return true;
      },
    } as unknown as NodeJS.WriteStream,
  };
}
