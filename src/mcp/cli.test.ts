import { test } from "bun:test";
import assert from "node:assert/strict";
import { createMcpCommand, runMcpCommand } from "./cli.js";

test("mcp CLI prints help for unknown subcommands", async () => {
  const output = { stdout: "", stderr: "" };
  const exitCode = await runMcpCommand(["bogus"], createTestIo(output));
  assert.equal(exitCode, 1);
  assert.match(output.stderr, /error: unknown command 'bogus'/);
  assert.match(output.stderr, /Usage: mcp/);
});

test("mcp CLI prints help when a required argument is missing", async () => {
  const output = { stdout: "", stderr: "" };
  const exitCode = await runMcpCommand(["status"], createTestIo(output));
  assert.equal(exitCode, 1);
  assert.match(output.stderr, /missing required argument 'serverId'/);
  assert.match(output.stderr, /Usage: mcp status/);
});

test("mcp CLI dispatches the list command", async () => {
  let called = false;
  const output = { stdout: "", stderr: "" };
  const exitCode = await createMcpCommand(createTestIo(output), {
    list: async () => {
      called = true;
      output.stdout += "todoist\tstreamable_http\thttps://todoist.example/mcp\n";
    },
    status: async () => {
      throw new Error("unexpected status");
    },
    login: async () => {
      throw new Error("unexpected login");
    },
    logout: async () => {
      throw new Error("unexpected logout");
    },
  }).parseAsync(["list"], { from: "user" }).then(() => 0);
  assert.equal(exitCode, 0);
  assert.equal(called, true);
  assert.match(output.stdout, /todoist/);
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
