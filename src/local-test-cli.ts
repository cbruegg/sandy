import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  createIdentifier,
  parseLocalTestOutboundEvent,
} from "./channel/local-test-protocol.js";
import { SANDY_MANAGED_CONTAINER_LABEL } from "./sandbox/container-label.js";

type CliIo = {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
};

type LocalTestCliCommand =
  | "send"
  | "attach"
  | "approve"
  | "deny"
  | "cancel"
  | "cancel-all"
  | "mark-finished"
  | "report-danger"
  | "tail"
  | "wait-for"
  | "list-events"
  | "status";

export async function runLocalTestCli(args: string[], io: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
}): Promise<void> {
  const command = parseCommand(args[0]);
  if (!command) {
    throw new Error("Missing local-test command.");
  }

  const options = parseOptions(args.slice(1));
  const spoolRoot = resolveRequiredOption(options, "spool-root");
  await ensureSpoolDirectories(spoolRoot);

  switch (command) {
    case "send":
      await writeInboxEvent(spoolRoot, {
        kind: "user_message",
        messageId: options["message-id"] ?? createIdentifier("message"),
        timestamp: new Date().toISOString(),
        text: resolveRequiredOption(options, "text"),
        rawText: options["raw-text"] ?? options["text"] ?? "",
        attachments: [],
      });
      return;
    case "attach":
      {
        const messageId = resolveStringOption(options, "message-id") ?? createIdentifier("message");
      await writeInboxEvent(spoolRoot, {
        kind: "user_message",
        messageId,
        timestamp: new Date().toISOString(),
        text: options["text"] ?? "",
        rawText: options["raw-text"] ?? options["text"] ?? "",
        attachments: collectMultiOption(options, "file").map((hostPath, index) => ({
          attachmentId: `${messageId}-attachment-${index + 1}`,
          fileName: basename(hostPath),
          hostPath: resolve(hostPath),
        })),
      });
      return;
      }
    case "approve":
      await writeInboxEvent(spoolRoot, {
        kind: "approval_response",
        messageId: options["message-id"] ?? createIdentifier("message"),
        timestamp: new Date().toISOString(),
        decision: mapApprovalScope(resolveStringOption(options, "scope") ?? "once"),
        requestId: resolveRequiredOption(options, "request-id"),
      });
      return;
    case "deny":
      await writeInboxEvent(spoolRoot, {
        kind: "approval_response",
        messageId: options["message-id"] ?? createIdentifier("message"),
        timestamp: new Date().toISOString(),
        decision: "deny",
        requestId: resolveRequiredOption(options, "request-id"),
      });
      return;
    case "cancel":
      await writeSimpleEvent(spoolRoot, "cancel_request", options);
      return;
    case "mark-finished":
      await writeSimpleEvent(spoolRoot, "mark_finished_request", options);
      return;
    case "report-danger":
      await writeSimpleEvent(spoolRoot, "danger_report", options);
      return;
    case "tail":
      printEvents(
        io.stdout,
        await listEvents(
          spoolRoot,
          resolveStringOption(options, "direction") ?? "outbox",
          Number(resolveStringOption(options, "limit") ?? 20),
        ),
      );
      return;
    case "list-events":
      printEvents(io.stdout, await listEvents(spoolRoot, resolveStringOption(options, "direction") ?? "outbox"));
      return;
    case "wait-for":
      await waitForEvent(spoolRoot, options, io.stdout);
      return;
    case "status":
      await printStatus(spoolRoot, options, io.stdout);
      return;
    case "cancel-all":
      await cancelAll(spoolRoot, options, io);
      return;
  }
}

function parseCommand(raw: string | undefined): LocalTestCliCommand | undefined {
  switch (raw) {
    case undefined:
      return undefined;
    case "send":
    case "attach":
    case "approve":
    case "deny":
    case "cancel":
    case "cancel-all":
    case "mark-finished":
    case "report-danger":
    case "status":
    case "tail":
    case "wait-for":
    case "list-events":
      return raw;
    default:
      throw new Error(`Unsupported local-test command: ${raw}`);
  }
}

async function writeSimpleEvent(
  spoolRoot: string,
  kind: "cancel_request" | "mark_finished_request" | "danger_report",
  options: Record<string, string | string[]>,
): Promise<void> {
  await writeInboxEvent(spoolRoot, {
    kind,
    messageId: options["message-id"] ?? createIdentifier("message"),
    timestamp: new Date().toISOString(),
  });
}

function mapApprovalScope(scope: string): "approve_once" | "approve_worker_session" | "approve_always" {
  switch (scope) {
    case "once":
      return "approve_once";
    case "worker_session":
      return "approve_worker_session";
    case "always":
      return "approve_always";
    default:
      throw new Error(`Unsupported approval scope: ${scope}`);
  }
}

async function waitForEvent(
  spoolRoot: string,
  options: Record<string, string | string[]>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const type = resolveRequiredOption(options, "type");
  const contains = resolveStringOption(options, "contains");
  const timeoutMs = Number(resolveStringOption(options, "timeout-ms") ?? 30000);
  const start = Date.now();
  const seen = new Set<string>();

  while (Date.now() - start < timeoutMs) {
    const entries = await readOutboxFiles(spoolRoot);
    for (const entry of entries) {
      if (seen.has(entry.path)) {
        continue;
      }
      seen.add(entry.path);
      const parsed = parseLocalTestOutboundEvent(entry.raw);
      if (parsed.type !== type) {
        continue;
      }
      if (contains && !JSON.stringify(parsed).includes(contains)) {
        continue;
      }
      stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
      return;
    }
    await sleep(100);
  }

  throw new Error(`Timed out waiting for local-test event type ${type}.`);
}

function printEvents(stdout: NodeJS.WriteStream, events: unknown[]): void {
  stdout.write(`${JSON.stringify(events, null, 2)}\n`);
}

async function listEvents(spoolRoot: string, direction: string, limit?: number): Promise<unknown[]> {
  const entries = direction === "inbox"
    ? await readInboxFiles(spoolRoot)
    : await readOutboxFiles(spoolRoot);
  const selected = limit ? entries.slice(-limit) : entries;
  return selected.map((entry) => parseUnknownJson(entry.raw));
}

async function readInboxFiles(spoolRoot: string): Promise<Array<{ path: string; raw: string }>> {
  return readJsonFiles(join(spoolRoot, "inbox"));
}

async function readOutboxFiles(spoolRoot: string): Promise<Array<{ path: string; raw: string }>> {
  return readJsonFiles(join(spoolRoot, "outbox"));
}

async function readJsonFiles(root: string): Promise<Array<{ path: string; raw: string }>> {
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const results: Array<{ path: string; raw: string }> = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    results.push({
      path,
      raw: await readFile(path, "utf8"),
    });
  }
  return results;
}

async function writeInboxEvent(spoolRoot: string, event: object): Promise<void> {
  const inboxRoot = join(spoolRoot, "inbox");
  await mkdir(inboxRoot, { recursive: true });
  const fileName = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${createIdentifier("inbound")}.json`;
  const targetPath = join(inboxRoot, fileName);
  const tempPath = `${targetPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(event)}\n`, "utf8");
  await rename(tempPath, targetPath);
}

async function ensureSpoolDirectories(spoolRoot: string): Promise<void> {
  await Promise.all([
    mkdir(join(spoolRoot, "inbox"), { recursive: true }),
    mkdir(join(spoolRoot, "inbox-processed"), { recursive: true }),
    mkdir(join(spoolRoot, "outbox"), { recursive: true }),
  ]);
}

function parseOptions(args: string[]): Record<string, string | string[]> {
  const options: Record<string, string | string[]> = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      options[key] = "true";
      continue;
    }
    const existing = options[key];
    if (existing === undefined) {
      options[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      options[key] = [existing, value];
    }
    index += 1;
  }
  return options;
}

function resolveRequiredOption(options: Record<string, string | string[]>, key: string): string {
  const value = options[key];
  if (!value || Array.isArray(value)) {
    throw new Error(`Missing required option --${key}.`);
  }
  return value;
}

function collectMultiOption(options: Record<string, string | string[]>, key: string): string[] {
  const value = options[key];
  if (!value) {
    throw new Error(`Missing required option --${key}.`);
  }
  return Array.isArray(value) ? value : [value];
}

function resolveStringOption(options: Record<string, string | string[]>, key: string): string | null {
  const value = options[key];
  if (!value) {
    return null;
  }
  if (Array.isArray(value)) {
    throw new Error(`Expected exactly one value for --${key}.`);
  }
  return value;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function parseUnknownJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

// ---- status command ----

async function printStatus(
  spoolRoot: string,
  _options: Record<string, string | string[]>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const containers = await listManagedContainers();

  const lines: string[] = [];
  lines.push(`=== Sandy Container Status ===`);
  lines.push(`Spool root: ${spoolRoot}`);
  lines.push(`Managed containers: ${containers.length}`);
  lines.push("");

  if (containers.length === 0) {
    lines.push("  (none)");
  } else {
    for (const c of containers) {
      lines.push(`  ${c.id.slice(0, 12)}  ${c.image.padEnd(32)} ${c.name}`);
    }
  }

  stdout.write(lines.join("\n") + "\n");
}

// ---- cancel-all command ----

async function cancelAll(
  spoolRoot: string,
  options: Record<string, string | string[]>,
  io: CliIo,
): Promise<void> {
  io.stdout.write("Sending cancel_request for active task...\n");
  await writeSimpleEvent(spoolRoot, "cancel_request", options);

  // Give Sandy a moment to process the cancel and emit task_update.
  await sleep(500);

  io.stdout.write("\nDocker containers remaining:\n");
  const remaining = await listManagedContainers();
  if (remaining.length === 0) {
    io.stdout.write("  (none)\n");
  } else {
    for (const c of remaining) {
      io.stdout.write(`  ${c.id.slice(0, 12)}  ${c.image.padEnd(30)} ${c.name}\n`);
    }
    io.stdout.write(`\n  ${remaining.length} container(s) still running.\n`);
    io.stdout.write("  Run 'status' to check task state, or stop Sandy to clean up standbys.\n");
  }
}

// ---- Docker helpers ----

type ContainerInfo = { id: string; image: string; name: string };

async function listManagedContainers(): Promise<ContainerInfo[]> {
  return new Promise((resolve) => {
    const child = spawn("docker", [
      "ps",
      "--filter", `label=${SANDY_MANAGED_CONTAINER_LABEL}`,
      "--format", "{{.ID}}|{{.Image}}|{{.Names}}",
    ], { stdio: ["ignore", "pipe", "ignore"] });

    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });

    child.on("error", () => resolve([]));
    child.on("exit", () => {
      const lines = stdout.trim().split("\n").filter((l) => l.length > 0);
      const containers = lines.map((line) => {
        const [id, image, name] = line.split("|");
        return { id: id!, image: image!, name: name! };
      });
      resolve(containers);
    });
  });
}

