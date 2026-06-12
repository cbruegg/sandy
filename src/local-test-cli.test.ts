import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runLocalTestCli } from "./local-test-cli.js";

const inboxEventSchema = z.object({
  kind: z.string(),
  chatId: z.string().optional(),
  text: z.string().optional(),
  decision: z.string().optional(),
}).passthrough();

test("local-test CLI writes conformant user_message events", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-local-cli-"));
  try {
    await runLocalTestCli(["send", "--spool-root", root, "--text", "hello"]);
    const files = await readdir(join(root, "inbox"));
    assert.equal(files.length, 1);
    const event = inboxEventSchema.parse(JSON.parse(await readFile(join(root, "inbox", files[0]!), "utf8")) as unknown);
    assert.equal(event.kind, "user_message");
    assert.equal(event.chatId, undefined);
    assert.equal(event.text, "hello");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-test CLI writes approval and denial events", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-local-cli-"));
  try {
    await runLocalTestCli(["approve", "--spool-root", root, "--request-id", "req-1", "--scope", "worker_session"]);
    await runLocalTestCli(["deny", "--spool-root", root, "--request-id", "req-2"]);
    const files = (await readdir(join(root, "inbox"))).sort();
    assert.equal(files.length, 2);
    const decisions = await Promise.all(
      files.map(async (file) => {
        const event = inboxEventSchema.parse(JSON.parse(await readFile(join(root, "inbox", file), "utf8")) as unknown);
        return event.decision;
      }),
    );
    assert.deepEqual(decisions.sort(), ["approve_worker_session", "deny"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-test CLI writes mark-finished events", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-local-cli-"));
  try {
    await runLocalTestCli(["mark-finished", "--spool-root", root]);
    const files = await readdir(join(root, "inbox"));
    assert.equal(files.length, 1);
    const event = inboxEventSchema.parse(JSON.parse(await readFile(join(root, "inbox", files[0]!), "utf8")) as unknown);
    assert.equal(event.kind, "mark_finished_request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-test CLI rejects unknown commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-local-cli-"));
  try {
    await assert.rejects(
      runLocalTestCli(["typo", "--spool-root", root]),
      /Unsupported local-test command: typo/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-test CLI cancel-all writes a cancel_request event", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-local-cli-"));
  try {
    await runLocalTestCli(["cancel-all", "--spool-root", root], createTestIo(), createTestRuntime());
    const files = await readdir(join(root, "inbox"));
    assert.equal(files.length, 1);
    const event = inboxEventSchema.parse(JSON.parse(await readFile(join(root, "inbox", files[0]!), "utf8")) as unknown);
    assert.equal(event.kind, "cancel_request");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-test CLI status shows container status header and managed count", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandy-local-cli-"));
  try {
    let output = "";
    const io = {
      stdout: { write: (s: string) => { output += s; return true; } } as unknown as NodeJS.WriteStream,
      stderr: { write: () => true } as unknown as NodeJS.WriteStream,
    };
    await runLocalTestCli(["status", "--spool-root", root], io, createTestRuntime());
    assert.ok(output.includes("=== Sandy Container Status ==="), "Should show container status header");
    assert.ok(output.includes("Spool root:"), "Should show spool root");
    assert.ok(output.includes("Managed containers:"), "Should show managed container count");
    // When no containers exist, status shows "(none)"
    if (output.includes("(none)")) {
      // expected for clean environments
    } else {
      // When containers exist, status shows container IDs and names
      assert.ok(output.match(/[0-9a-f]{12}/), "Should show container ID prefix");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createTestIo(output?: { stdout: string; stderr: string }) {
  return {
    stdout: {
      write: (s: string) => {
        if (output) output.stdout += s;
        return true;
      },
    } as unknown as NodeJS.WriteStream,
    stderr: {
      write: (s: string) => {
        if (output) output.stderr += s;
        return true;
      },
    } as unknown as NodeJS.WriteStream,
  };
}

function createTestRuntime() {
  return {
    listManagedContainers: () => Promise.resolve([]),
    sleep: (_delayMs: number) => Promise.resolve(),
  };
}
