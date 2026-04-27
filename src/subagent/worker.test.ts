import { test } from "bun:test";
import assert from "node:assert/strict";
import { messages } from "../messages.js";
import {
  buildInitialTaskInput,
  buildInitialTaskInputWithCapabilities,
  buildPrivilegeResolutionInput,
  buildTaskSummaryInput,
  parseWorkerToolCall,
  workerToolCallToSubAgentEvent,
} from "./worker.js";
import type { ChannelFormatting, PrivilegeResolutionResult } from "../types.js";
import { parseSubAgentEvent } from "../types.js";

test("buildInitialTaskInput tells the sub-agent where the shared workspace is", () => {
  const formatting: ChannelFormatting = {
    channelId: "telegram",
    markup: "telegram_html",
    allowedTags: ["b", "i", "code", "pre"],
    instructions: "Use simple Telegram HTML.",
  };
  const input = buildInitialTaskInput(
    "Inspect the repository and leave a summary file.",
    "English",
    formatting,
    [{ tokenId: "vid2text", description: "Token for the video transcription API." }],
    "/usr/local/bin/sandy-http-proxy-exec",
  );

  assert.match(input, /\/workspace\/share/);
  assert.match(input, /shared workspace is mounted/);
  assert.match(input, /SANDY_COPY_INTO_SHARE/);
  assert.match(input, /SANDY_SEND_FILE_TO_CHANNEL/);
  assert.match(input, /Schema:/);
  assert.match(input, /Use a tool by emitting exactly one line with no surrounding text/);
  assert.match(input, /Emit Sandy tool calls as assistant messages, not as shell commands or file contents/);
  assert.match(input, /Never combine a Sandy tool call with user-visible text in the same assistant message/);
  assert.match(input, /send the user-visible text first and then send the Sandy tool call by itself in a following assistant message/);
  assert.match(input, /Send a file that already exists in the shared workspace back to the user through the channel adapter/);
  assert.match(input, /SANDY_COMPLETE_TASK/);
  assert.match(input, /Telegram HTML/);
  assert.match(input, /<code>/);
  assert.match(input, /Use English for user-visible replies unless the host provides a later instruction that overrides it\./);
  assert.match(input, /Configured HTTP tokens available to this task:/);
  assert.match(input, /vid2text: Token for the video transcription API\./);
  assert.match(input, /SANDY_REQUEST_HTTP_TOKEN/);
  assert.match(input, /do not ask the user in plain text/i);
  assert.match(input, /Do not run SANDY_REQUEST_HTTP_TOKEN inside bash/i);
  assert.match(input, /sandy-http-proxy-exec/);
  assert.match(input, /always run it through \/usr\/local\/bin\/sandy-http-proxy-exec/i);
  assert.match(input, /placeholder will not be injected/i);
  assert.match(input, /not limited to curl/i);
  assert.match(input, /any executable that respects proxy environment variables/i);
  assert.match(input, /Example pattern: \/usr\/local\/bin\/sandy-http-proxy-exec curl/);
  assert.match(input, /leave a summary file\./);
});

test("buildInitialTaskInputWithCapabilities includes package-manager guidance when detected during init", () => {
  const input = buildInitialTaskInputWithCapabilities(
    "Install dependencies if needed.",
    "Spanish",
    null,
    [
      "Detected JavaScript runtime and package manager: Bun.",
      "Use bun run, bun test, bun install, and bunx for JavaScript or TypeScript tasks in this container.",
      "Detected package manager: zypper.",
      "You can install or update openSUSE Tumbleweed packages in this container with zypper when needed.",
      "Detected package manager: Homebrew.",
      "Use brew for fast-moving CLI and developer tools; the container's brew command runs under the dedicated linuxbrew user automatically.",
    ],
    [{ tokenId: "vid2text", description: "Token for the video transcription API." }],
    "/usr/local/bin/sandy-http-proxy-exec",
  );

  assert.match(input, /Detected JavaScript runtime and package manager: Bun\./);
  assert.match(input, /Use Spanish for user-visible replies unless the host provides a later instruction that overrides it\./);
  assert.match(input, /Use bun run, bun test, bun install, and bunx/);
  assert.match(input, /Detected package manager: zypper\./);
  assert.match(input, /openSUSE Tumbleweed packages/);
  assert.match(input, /Detected package manager: Homebrew\./);
  assert.match(input, /brew command runs under the dedicated linuxbrew user/);
  assert.match(input, /HTTP_PROXY\/HTTPS_PROXY are set only for that process/);
  assert.match(input, /must use \/usr\/local\/bin\/sandy-http-proxy-exec unless the host explicitly tells you otherwise/i);
});

test("buildPrivilegeResolutionInput explains the host privilege result to the sub-agent", () => {
  const result: PrivilegeResolutionResult = {
    requestId: "req-1",
    outcome: "approved",
    message: "Copied /tmp/input.txt into the shared workspace.",
  };

  const input = buildPrivilegeResolutionInput(result);

  assert.match(input, /req-1/);
  assert.match(input, /approved/);
  assert.match(input, /Copied \/tmp\/input.txt into the shared workspace\./);
  assert.match(input, /Continue the task from here\./);
});

test("buildTaskSummaryInput requests a host-facing handoff summary", () => {
  const input = buildTaskSummaryInput();

  assert.match(input, /host-facing handoff summary/);
  assert.match(input, /Do not emit any Sandy tool calls/);
  assert.match(input, /Artifacts:/);
});

test("mcpToolProgress includes payloads for completed MCP calls", () => {
  assert.equal(
    messages.mcpToolProgress("completed", "filesystem", "read_file", { path: "/tmp/report.txt" }),
    'MCP completed: filesystem.read_file {"path":"/tmp/report.txt"}',
  );
});

test("commandProgress formats command execution updates", () => {
  assert.equal(
    messages.commandProgress("completed", "npm test", null),
    "Command completed: npm test",
  );
});

test("nextPlannedStep formats todo-list progress updates", () => {
  assert.equal(
    messages.nextPlannedStep("Run the final verification"),
    "Next planned step: Run the final verification",
  );
});

test("parseWorkerToolCall parses privilege-escalated worker tools", () => {
  const call = parseWorkerToolCall(
    'SANDY_COPY_OUT_OF_SHARE {"sourcePath":"/workspace/share/random_numbers.txt","targetPath":"~/Downloads/random_numbers.txt","reason":"Deliver the generated file."}',
  );

  assert.equal(call?.tool, "copy_out_of_share");
  assert.equal(call?.definition.requiresPrivilegeEscalation, true);
  assert.deepEqual(call?.payload, {
    type: "copy_out_of_share",
    sourcePath: "/workspace/share/random_numbers.txt",
    targetPath: "~/Downloads/random_numbers.txt",
    reason: "Deliver the generated file.",
  });
});

test("parseWorkerToolCall throws a helpful error for invalid payloads", () => {
  assert.throws(
    () => parseWorkerToolCall(
      'SANDY_COPY_OUT_OF_SHARE {"source":"random_numbers.txt","destinationPath":"~/Downloads/random_numbers.txt"}',
    ),
    /Invalid copy_out_of_share tool payload|Payload:/,
  );
});

test("workerToolCallToSubAgentEvent converts non-privileged tools generically", () => {
  const call = parseWorkerToolCall(
    'SANDY_SEND_FILE_TO_CHANNEL {"path":"/workspace/share/result.txt","caption":"Generated result file."}',
  );

  const event = workerToolCallToSubAgentEvent(call!);

  assert.deepEqual(event, {
    type: "tool_call",
    call: {
      type: "send_file_to_channel",
      path: "/workspace/share/result.txt",
      caption: "Generated result file.",
    },
  });
});

test("workerToolCallToSubAgentEvent converts privileged tools into tool-call events", () => {
  const call = parseWorkerToolCall(
    'SANDY_COPY_OUT_OF_SHARE {"sourcePath":"/workspace/share/result.txt","targetPath":"~/Downloads/result.txt","reason":"Deliver the generated file."}',
  );

  const event = workerToolCallToSubAgentEvent(call!);

  assert.deepEqual(event, {
    type: "tool_call",
    call: {
      type: "copy_out_of_share",
      sourcePath: "/workspace/share/result.txt",
      targetPath: "~/Downloads/result.txt",
      reason: "Deliver the generated file.",
    },
  });
});

test("workerToolCallToSubAgentEvent converts explicit completion signals into task_done events", () => {
  const call = parseWorkerToolCall("SANDY_COMPLETE_TASK {}");

  const event = workerToolCallToSubAgentEvent(call!);

  assert.deepEqual(event, {
    type: "task_done",
  });
});

test("parseSubAgentEvent accepts tool-call events", () => {
  const event = parseSubAgentEvent(
    '{"type":"tool_call","call":{"type":"send_file_to_channel","path":"/workspace/share/result.txt","caption":"Generated result file."}}',
  );

  assert.deepEqual(event, {
    type: "tool_call",
    call: {
      type: "send_file_to_channel",
      path: "/workspace/share/result.txt",
      caption: "Generated result file.",
    },
  });
});

test("parseSubAgentEvent accepts task-summary events", () => {
  const event = parseSubAgentEvent('{"type":"task_summary","summary":"Task completed successfully"}');

  assert.deepEqual(event, {
    type: "task_summary",
    summary: "Task completed successfully",
  });
});
