import { test } from "bun:test";
import assert from "node:assert/strict";
import { messages } from "./messages.js";

test("privilegeRequestPrompt uses user-friendly copy for MCP tool calls", () => {
  const prompt = messages.privilegeRequestPrompt({
    kind: "mcp_tool_call",
    requestId: "req-1",
    serverId: "filesystem",
    toolName: "read_file",
    arguments: { path: "/tmp/example.txt" },
  });

  assert.match(prompt, /MCP tool call: filesystem\.read_file/);
  assert.doesNotMatch(prompt, /mcp_tool_call/);
});

test("privilegeRequestPrompt uses user-friendly copy for host directory access", () => {
  const prompt = messages.privilegeRequestPrompt({
    kind: "host_directory_access",
    requestId: "req-1",
    path: "/workspace/project",
    level: "read_write",
  });

  assert.match(prompt, /Host directory access: \/workspace\/project/);
  assert.match(prompt, /Access level: read and write/);
  assert.doesNotMatch(prompt, /host_directory_access/);
});

test("privilegeRequestPrompt uses user-friendly copy for saved auto-approvals", () => {
  const prompt = messages.privilegeRequestPrompt({
    kind: "http_token_use",
    requestId: "req-1",
    tokenId: "github",
    host: "api.github.com",
    reason: "fetch PR feedback",
    confirmsAutoApprovalForTask: true,
  });

  assert.match(prompt, /A saved auto-approval matches HTTP token github for api\.github\.com\./);
  assert.match(prompt, /Apply that saved approval to this task\?/);
  assert.doesNotMatch(prompt, /Previously auto-allowed/);
});
