import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialTaskInput,
  buildPrivilegeResolutionInput,
  parsePrivilegeRequestMessage,
} from "./subagent/worker.js";
import type { ChannelFormatting, PrivilegeResolutionResult } from "./types.js";

test("buildInitialTaskInput tells the sub-agent where the shared workspace is", () => {
  const formatting: ChannelFormatting = {
    channel: "telegram",
    markup: "telegram_html",
    allowedTags: ["b", "i", "code", "pre"],
    instructions: "Use simple Telegram HTML.",
  };
  const input = buildInitialTaskInput("Inspect the repository and leave a summary file.", formatting);

  assert.match(input, /\/workspace\/share/);
  assert.match(input, /shared workspace is mounted/);
  assert.match(input, /SANDY_PRIVILEGE_REQUEST/);
  assert.match(input, /copy_into_share/);
  assert.match(input, /Telegram HTML/);
  assert.match(input, /<code>/);
  assert.match(input, /leave a summary file\./);
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

test("parsePrivilegeRequestMessage accepts only the exact supported JSON payload shape", () => {
  const request = parsePrivilegeRequestMessage(
    'SANDY_PRIVILEGE_REQUEST {"type":"copy_out_of_share","sourcePath":"/workspace/share/random_numbers.txt","targetPath":"~/Downloads/random_numbers.txt","reason":"Deliver the generated file."}',
  );

  assert.equal(request?.type, "copy_out_of_share");
  assert.equal(request?.sourcePath, "/workspace/share/random_numbers.txt");
  assert.equal(request?.targetPath, "~/Downloads/random_numbers.txt");
  assert.equal(request?.reason, "Deliver the generated file.");
});

test("parsePrivilegeRequestMessage throws a helpful error for invalid payloads", () => {
  assert.throws(
    () => parsePrivilegeRequestMessage(
      'SANDY_PRIVILEGE_REQUEST {"type":"copy_out_of_share","source":"random_numbers.txt","destinationPath":"~/Downloads/random_numbers.txt"}',
    ),
    /Invalid privilege request payload|Unsupported privilege request payload|Payload:/,
  );
});
