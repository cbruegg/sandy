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

test("privilegeRequestPrompt shows skill create metadata and body", () => {
  const prompt = messages.privilegeRequestPrompt({
    kind: "skill_mutation",
    requestId: "req-1",
    operation: "create",
    skillId: "my-skill",
    name: "My Skill",
    description: "Does something useful.",
    body: "Step 1: run this\nStep 2: check that",
  });

  assert.match(prompt, /Skill mutation: create/);
  assert.match(prompt, /Skill ID: my-skill/);
  assert.match(prompt, /Name: My Skill/);
  assert.match(prompt, /Description: Does something useful\./);
  assert.match(prompt, /Skill content:\n---\nStep 1: run this\nStep 2: check that\n---/);
  assert.match(prompt, /Approve or deny this request\./);
  assert.doesNotMatch(prompt, /skill_mutation/);
});

test("privilegeRequestPrompt shows skill update name, description, and body only when provided", () => {
  const prompt = messages.privilegeRequestPrompt({
    kind: "skill_mutation",
    requestId: "req-2",
    operation: "update",
    skillId: "my-skill",
    description: "Updated description.",
    body: "Updated body content.",
  });

  assert.match(prompt, /Skill mutation: update/);
  assert.match(prompt, /Skill ID: my-skill/);
  assert.doesNotMatch(prompt, /Name:/);
  assert.match(prompt, /Description: Updated description\./);
  assert.match(prompt, /Skill content:\n---\nUpdated body content\.\n---/);
  assert.match(prompt, /Approve or deny this request\./);
});

test("privilegeRequestPrompt renders empty skill body explicitly when body is an empty string", () => {
  const prompt = messages.privilegeRequestPrompt({
    kind: "skill_mutation",
    requestId: "req-2b",
    operation: "update",
    skillId: "my-skill",
    body: "",
  });

  assert.match(prompt, /Skill mutation: update/);
  assert.match(prompt, /Skill ID: my-skill/);
  assert.match(prompt, /Skill content:\n---\n\n---/);
});

test("privilegeRequestPrompt shows skill delete with only operation and skillId", () => {
  const prompt = messages.privilegeRequestPrompt({
    kind: "skill_mutation",
    requestId: "req-3",
    operation: "delete",
    skillId: "my-skill",
  });

  assert.match(prompt, /Skill mutation: delete/);
  assert.match(prompt, /Skill ID: my-skill/);
  assert.doesNotMatch(prompt, /Name:/);
  assert.doesNotMatch(prompt, /Description:/);
  assert.doesNotMatch(prompt, /Skill content:/);
  assert.match(prompt, /Approve or deny this request\./);
});

test("jobTaskMustRequestInteractionFirst tells scheduled jobs to wait for visibility", () => {
  const message = messages.jobTaskMustRequestInteractionFirst("asking the user for privilege approval");

  assert.match(message, /scheduled job task is not interactive yet/i);
  assert.match(message, /call sandy\.request_interaction first/i);
  assert.match(message, /wait until Sandy explicitly says the task became interactive/i);
});
