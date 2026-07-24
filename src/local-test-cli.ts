import { Command } from "commander";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import {
  defaultCliIo,
  type CliIo,
  configureCliProgram,
  parseIntegerOption,
  runCliProgram,
} from "./command-line.js";
import {
  createIdentifier,
  parseLocalTestOutboundEvent,
} from "./channel/local-test-protocol.js";
import type { ApprovalResponseTarget } from "./types.js";
import { SANDY_MANAGED_CONTAINER_LABEL } from "./sandbox/container-label.js";

type LocalTestCliRuntime = {
  listManagedContainers: () => Promise<ContainerInfo[]>;
  sleep: (delayMs: number) => Promise<void>;
};

type LocalTestCliCommandName =
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

type SpoolRootOption = {
  spoolRoot: string;
};

type MessageIdOption = {
  messageId?: string;
};

type BasicMessageOptions = SpoolRootOption & MessageIdOption & {
  text: string;
  rawText?: string;
};

type AttachmentCommandOptions = SpoolRootOption & MessageIdOption & {
  file: string[];
  text?: string;
  rawText?: string;
};

type ApprovalCommandOptions = SpoolRootOption & MessageIdOption & {
  requestId: string;
  scope: string;
  target: ApprovalResponseTarget;
};

type DenyCommandOptions = SpoolRootOption & MessageIdOption & {
  requestId: string;
  reason?: string;
  target: ApprovalResponseTarget;
};

type SimpleEventOptions = SpoolRootOption & MessageIdOption;

type DirectionCommandOptions = SpoolRootOption & {
  direction: string;
};

type TailCommandOptions = DirectionCommandOptions & {
  limit: number;
};

type WaitForCommandOptions = SpoolRootOption & {
  type: string;
  contains?: string;
  timeoutMs: number;
};

const defaultRuntime: LocalTestCliRuntime = {
  listManagedContainers,
  sleep,
};

const simpleEventCommands: ReadonlyArray<{
  name: LocalTestCliCommandName;
  description: string;
  kind: "cancel_request" | "mark_finished_request" | "danger_report";
}> = [
  {
    name: "cancel",
    description: "Write a cancel_request event.",
    kind: "cancel_request",
  },
  {
    name: "mark-finished",
    description: "Write a mark_finished_request event.",
    kind: "mark_finished_request",
  },
  {
    name: "report-danger",
    description: "Write a danger_report event.",
    kind: "danger_report",
  },
];

export async function runLocalTestCli(
  args: string[],
  io: CliIo = defaultCliIo,
  runtime: LocalTestCliRuntime = defaultRuntime,
): Promise<number> {
  return runCliProgram(createLocalTestProgram(io, runtime), args);
}

function createLocalTestProgram(
  io: CliIo = defaultCliIo,
  runtime: LocalTestCliRuntime = defaultRuntime,
): Command {
  const command = configureCliProgram(new Command("sandy-local-test"), io)
    .description("Send events to and inspect output from Sandy's local-test channel.");

  command
    .command("send")
    .description("Write a user_message event.")
    .requiredOption("--spool-root <path>", "local-test spool root")
    .requiredOption("--text <text>", "message text")
    .option("--raw-text <text>", "raw message text")
    .option("--message-id <id>", "message identifier")
    .action(async (options: BasicMessageOptions) => {
      const spoolRoot = await prepareSpoolRoot(options.spoolRoot);
      await writeInboxEvent(spoolRoot, {
        kind: "user_message",
        messageId: options.messageId ?? createIdentifier("message"),
        timestamp: new Date().toISOString(),
        text: options.text,
        rawText: options.rawText ?? options.text,
        attachments: [],
      });
    });

  command
    .command("attach")
    .description("Write a user_message event with file attachments.")
    .requiredOption("--spool-root <path>", "local-test spool root")
    .requiredOption("--file <path>", "host file to attach", collectOptionValues, [] as string[])
    .option("--text <text>", "message text")
    .option("--raw-text <text>", "raw message text")
    .option("--message-id <id>", "message identifier")
    .action(async (options: AttachmentCommandOptions) => {
      const spoolRoot = await prepareSpoolRoot(options.spoolRoot);
      const messageId = options.messageId ?? createIdentifier("message");
      await writeInboxEvent(spoolRoot, {
        kind: "user_message",
        messageId,
        timestamp: new Date().toISOString(),
        text: options.text ?? "",
        rawText: options.rawText ?? options.text ?? "",
        attachments: options.file.map((hostPath, index) => ({
          attachmentId: `${messageId}-attachment-${index + 1}`,
          fileName: basename(hostPath),
          hostPath: resolve(hostPath),
        })),
      });
    });

  command
    .command("approve")
    .description("Approve a pending request.")
    .requiredOption("--spool-root <path>", "local-test spool root")
    .requiredOption("--request-id <id>", "pending request identifier")
    .requiredOption("--target <target>", "approval target: privilege_request, share_deletion, or task_summary_confirmation")
    .option("--scope <scope>", "approval scope", "once")
    .option("--message-id <id>", "message identifier")
    .action(async (options: ApprovalCommandOptions) => {
      const spoolRoot = await prepareSpoolRoot(options.spoolRoot);
      await writeInboxEvent(spoolRoot, {
        kind: "approval_response",
        messageId: options.messageId ?? createIdentifier("message"),
        timestamp: new Date().toISOString(),
        target: options.target,
        decision: mapApprovalScope(options.scope),
        requestId: options.requestId,
      });
    });

  command
    .command("deny")
    .description("Deny a pending request.")
    .requiredOption("--spool-root <path>", "local-test spool root")
    .requiredOption("--request-id <id>", "pending request identifier")
    .requiredOption("--target <target>", "approval target: privilege_request, share_deletion, or task_summary_confirmation")
    .option("--reason <text>", "optional denial reason")
    .option("--message-id <id>", "message identifier")
    .action(async (options: DenyCommandOptions) => {
      const spoolRoot = await prepareSpoolRoot(options.spoolRoot);
      const event: Record<string, unknown> = {
        kind: "approval_response",
        messageId: options.messageId ?? createIdentifier("message"),
        timestamp: new Date().toISOString(),
        target: options.target,
        decision: "deny",
        requestId: options.requestId,
      };
      if (options.reason) {
        event["reason"] = options.reason;
      }
      await writeInboxEvent(spoolRoot, event);
    });

  for (const simpleCommand of simpleEventCommands) {
    command
      .command(simpleCommand.name)
      .description(simpleCommand.description)
      .requiredOption("--spool-root <path>", "local-test spool root")
      .option("--message-id <id>", "message identifier")
      .action(async (options: SimpleEventOptions) => {
        const spoolRoot = await prepareSpoolRoot(options.spoolRoot);
        await writeSimpleEvent(spoolRoot, simpleCommand.kind, options.messageId);
      });
  }

  command
    .command("tail")
    .description("Print recent inbox or outbox events.")
    .requiredOption("--spool-root <path>", "local-test spool root")
    .option("--direction <direction>", "inbox or outbox", "outbox")
    .option("--limit <count>", "number of events to print", parseIntegerOption, 20)
    .action(async (options: TailCommandOptions) => {
      const spoolRoot = await prepareSpoolRoot(options.spoolRoot);
      printEvents(io.stdout, await listEvents(spoolRoot, options.direction, options.limit));
    });

  command
    .command("list-events")
    .description("Print all inbox or outbox events.")
    .requiredOption("--spool-root <path>", "local-test spool root")
    .option("--direction <direction>", "inbox or outbox", "outbox")
    .action(async (options: DirectionCommandOptions) => {
      const spoolRoot = await prepareSpoolRoot(options.spoolRoot);
      printEvents(io.stdout, await listEvents(spoolRoot, options.direction));
    });

  command
    .command("wait-for")
    .description("Wait for a matching outbox event.")
    .requiredOption("--spool-root <path>", "local-test spool root")
    .requiredOption("--type <type>", "event type to wait for")
    .option("--contains <text>", "substring to match in the event payload")
    .option("--timeout-ms <ms>", "time to wait before failing", parseIntegerOption, 30000)
    .action(async (options: WaitForCommandOptions) => {
      const spoolRoot = await prepareSpoolRoot(options.spoolRoot);
      await waitForEvent(spoolRoot, options, io.stdout);
    });

  command
    .command("status")
    .description("Show local-test spool and managed container status.")
    .requiredOption("--spool-root <path>", "local-test spool root")
    .action(async (options: SpoolRootOption) => {
      const spoolRoot = await prepareSpoolRoot(options.spoolRoot);
      await printStatus(spoolRoot, io.stdout, runtime.listManagedContainers);
    });

  command
    .command("cancel-all")
    .description("Request task cancellation and print remaining managed containers.")
    .requiredOption("--spool-root <path>", "local-test spool root")
    .option("--message-id <id>", "message identifier")
    .action(async (options: SimpleEventOptions) => {
      const spoolRoot = await prepareSpoolRoot(options.spoolRoot);
      await cancelAll(spoolRoot, options.messageId, io, runtime);
    });

  return command;
}

async function writeSimpleEvent(
  spoolRoot: string,
  kind: "cancel_request" | "mark_finished_request" | "danger_report",
  messageId: string | undefined,
): Promise<void> {
  await writeInboxEvent(spoolRoot, {
    kind,
    messageId: messageId ?? createIdentifier("message"),
    timestamp: new Date().toISOString(),
  });
}

function mapApprovalScope(scope: string): "approve_once" | "approve_worker_session" | "approve_for_job" | "approve_always" {
  switch (scope) {
    case "once":
      return "approve_once";
    case "worker_session":
      return "approve_worker_session";
    case "job":
      return "approve_for_job";
    case "always":
      return "approve_always";
    default:
      throw new Error(`Unsupported approval scope: ${scope}`);
  }
}

async function waitForEvent(
  spoolRoot: string,
  options: WaitForCommandOptions,
  stdout: Pick<NodeJS.WriteStream, "write">,
): Promise<void> {
  const start = Date.now();
  const seen = new Set<string>();

  while (Date.now() - start < options.timeoutMs) {
    const entries = await readOutboxFiles(spoolRoot);
    for (const entry of entries) {
      if (seen.has(entry.path)) {
        continue;
      }
      seen.add(entry.path);
      const parsed = parseLocalTestOutboundEvent(entry.raw);
      if (parsed.type !== options.type) {
        continue;
      }
      if (options.contains && !JSON.stringify(parsed).includes(options.contains)) {
        continue;
      }
      stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
      return;
    }
    await sleep(100);
  }

  throw new Error(`Timed out waiting for local-test event type ${options.type}.`);
}

function printEvents(stdout: Pick<NodeJS.WriteStream, "write">, events: unknown[]): void {
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

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function parseUnknownJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

async function printStatus(
  spoolRoot: string,
  stdout: Pick<NodeJS.WriteStream, "write">,
  listContainers: () => Promise<ContainerInfo[]>,
): Promise<void> {
  const containers = await listContainers();

  const lines: string[] = [];
  lines.push("=== Sandy Container Status ===");
  lines.push(`Spool root: ${spoolRoot}`);
  lines.push(`Managed containers: ${containers.length}`);
  lines.push("");

  if (containers.length === 0) {
    lines.push("  (none)");
  } else {
    for (const container of containers) {
      lines.push(`  ${container.id.slice(0, 12)}  ${container.image.padEnd(32)} ${container.name}`);
    }
  }

  stdout.write(`${lines.join("\n")}\n`);
}

async function cancelAll(
  spoolRoot: string,
  messageId: string | undefined,
  io: CliIo,
  runtime: LocalTestCliRuntime,
): Promise<void> {
  io.stdout.write("Sending cancel_request for active task...\n");
  await writeSimpleEvent(spoolRoot, "cancel_request", messageId);

  await runtime.sleep(500);

  io.stdout.write("\nDocker containers remaining:\n");
  const remaining = await runtime.listManagedContainers();
  if (remaining.length === 0) {
    io.stdout.write("  (none)\n");
  } else {
    for (const container of remaining) {
      io.stdout.write(`  ${container.id.slice(0, 12)}  ${container.image.padEnd(30)} ${container.name}\n`);
    }
    io.stdout.write(`\n  ${remaining.length} container(s) still running.\n`);
    io.stdout.write("  Run 'status' to check task state, or stop Sandy to clean up standbys.\n");
  }
}

async function prepareSpoolRoot(spoolRoot: string): Promise<string> {
  const resolvedSpoolRoot = resolve(spoolRoot);
  await ensureSpoolDirectories(resolvedSpoolRoot);
  return resolvedSpoolRoot;
}

function collectOptionValues(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

type ContainerInfo = { id: string; image: string; name: string };

async function listManagedContainers(): Promise<ContainerInfo[]> {
  return new Promise((resolveContainers) => {
    const child = spawn("docker", [
      "ps",
      "--filter", `label=${SANDY_MANAGED_CONTAINER_LABEL}`,
      "--format", "{{.ID}}|{{.Image}}|{{.Names}}",
    ], { stdio: ["ignore", "pipe", "ignore"] });

    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });

    child.on("error", () => resolveContainers([]));
    child.on("exit", () => {
      const lines = stdout.trim().split("\n").filter((line) => line.length > 0);
      const containers = lines.map((line) => {
        const [id, image, name] = line.split("|");
        return { id: id!, image: image!, name: name! };
      });
      resolveContainers(containers);
    });
  });
}
