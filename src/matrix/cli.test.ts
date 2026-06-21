import { test } from "bun:test";
import assert from "node:assert/strict";
import { createMatrixCommand, runMatrixCommand } from "./cli.js";

test("matrix CLI prints help for unknown subcommands", async () => {
  const output = { stdout: "", stderr: "" };
  const exitCode = await runMatrixCommand(["bogus"], createTestIo(output));
  assert.equal(exitCode, 1);
  assert.match(output.stderr, /error: unknown command 'bogus'/);
  assert.match(output.stderr, /Usage: matrix/);
});

test("matrix CLI prints help for unknown verify subcommands", async () => {
  const output = { stdout: "", stderr: "" };
  const exitCode = await runMatrixCommand(["verify", "bogus"], createTestIo(output));
  assert.equal(exitCode, 1);
  assert.match(output.stderr, /error: unknown command 'bogus'/);
  assert.match(output.stderr, /Usage: matrix verify/);
});

test("matrix CLI uses the default login device name", async () => {
  let receivedDeviceName: string | null = null;
  const command = createMatrixCommand(createTestIo({ stdout: "", stderr: "" }), {
    status: async () => {
      throw new Error("unexpected status");
    },
    login: async (deviceName: string) => {
      receivedDeviceName = deviceName;
    },
    logout: async () => {
      throw new Error("unexpected logout");
    },
    verifyStatus: async () => {
      throw new Error("unexpected verify status");
    },
    verifyRecoveryKey: async () => {
      throw new Error("unexpected verify recovery-key");
    },
  });

  await command.parseAsync(["login"], { from: "user" });
  assert.equal(receivedDeviceName, "Sandy");
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
