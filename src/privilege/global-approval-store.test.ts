import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TomlGlobalApprovalStore } from "./global-approval-store.js";

describe("TomlGlobalApprovalStore", () => {
  let tempDir: string;
  let configFilePath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sandy-approval-test-"));
    configFilePath = join(tempDir, "config.toml");
  });

  afterEach(async () => {
    await Bun.file(configFilePath).delete().catch(() => {});
  });

  it("should only modify approvals.mcp section without adding defaults", async () => {
    // Minimal config without any worker.image or mcp.sidecar_image
    const originalConfig = `[channel.telegram]
bot_token = "test-token"
allowed_user = "12345"
`;
    await writeFile(configFilePath, originalConfig, "utf8");

    const store = new TomlGlobalApprovalStore(configFilePath, {});
    await store.allowTool("todoist", "find-projects");

    const result = await readFile(configFilePath, "utf8");

    // Should NOT contain any default values for worker.image or mcp.sidecar_image
    expect(result).not.toContain("worker.image");
    expect(result).not.toContain("sidecar_image");

    // Should NOT contain other default sections
    expect(result).not.toContain("[logging]");
    expect(result).not.toContain("[stt]");
    expect(result).not.toContain("[updates]");

    // Should contain the original channel config
    expect(result).toContain("[channel.telegram]");
    expect(result).toContain('bot_token = "test-token"');
    expect(result).toContain('allowed_user = "12345"');

    // Should contain the new approval
    expect(result).toContain("[approvals.mcp.todoist]");
    expect(result).toContain('always_allow_tools = [ "find-projects" ]');
  });

  it("should add to existing approvals without overwriting", async () => {
    const originalConfig = `[channel.telegram]
bot_token = "test-token"
allowed_user = "12345"

[approvals.mcp.todoist]
always_allow_tools = ["list_projects"]
`;
    await writeFile(configFilePath, originalConfig, "utf8");

    const store = new TomlGlobalApprovalStore(configFilePath, {
      todoist: ["list_projects"],
    });
    await store.allowTool("todoist", "find-projects");

    const result = await readFile(configFilePath, "utf8");

    // Should preserve original structure without adding defaults
    expect(result).not.toContain("worker.image");
    expect(result).not.toContain("sidecar_image");

    // Should contain both tools (sorted)
    expect(result).toContain('always_allow_tools = [ "find-projects", "list_projects" ]');
  });

  it("should handle adding tool to different server", async () => {
    const originalConfig = `[channel.telegram]
bot_token = "test-token"
allowed_user = "12345"

[approvals.mcp.todoist]
always_allow_tools = ["list_projects"]
`;
    await writeFile(configFilePath, originalConfig, "utf8");

    const store = new TomlGlobalApprovalStore(configFilePath, {
      todoist: ["list_projects"],
    });
    await store.allowTool("github", "create-issue");

    const result = await readFile(configFilePath, "utf8");

    // Should not contain defaults
    expect(result).not.toContain("worker.image");

    // Should contain both server approvals
    expect(result).toContain("[approvals.mcp.todoist]");
    expect(result).toContain("[approvals.mcp.github]");
    expect(result).toContain('always_allow_tools = [ "create-issue" ]');
  });

  it("should not modify file if tool is already allowed", async () => {
    const originalConfig = `[channel.telegram]
bot_token = "test-token"
allowed_user = "12345"

[approvals.mcp.todoist]
always_allow_tools = ["find-projects"]
`;
    await writeFile(configFilePath, originalConfig, "utf8");

    const store = new TomlGlobalApprovalStore(configFilePath, {
      todoist: ["find-projects"],
    });
    await store.allowTool("todoist", "find-projects");

    const result = await readFile(configFilePath, "utf8");

    // Should be unchanged
    expect(result.trim()).toBe(originalConfig.trim());
  });

  it("should persist resource read approvals separately from tool approvals", async () => {
    const originalConfig = `[channel.telegram]
bot_token = "test-token"
allowed_user = "12345"
`;
    await writeFile(configFilePath, originalConfig, "utf8");

    const store = new TomlGlobalApprovalStore(configFilePath, {});
    await store.allowResourceRead("todoist", "test://resource");

    const result = await readFile(configFilePath, "utf8");

    expect(result).not.toContain("worker.image");
    expect(result).toContain("[approvals.mcp.todoist]");
    expect(result).toContain('always_allow_resources = [ "test://resource" ]');
    expect(result).not.toContain("always_allow_tools");
  });

  it("should add resource read approvals without overwriting existing tool approvals", async () => {
    const originalConfig = `[channel.telegram]
bot_token = "test-token"
allowed_user = "12345"

[approvals.mcp.todoist]
always_allow_tools = ["list_projects"]
`;
    await writeFile(configFilePath, originalConfig, "utf8");

    const store = new TomlGlobalApprovalStore(configFilePath, {
      todoist: ["list_projects"],
    });
    await store.allowResourceRead("todoist", "test://resource");

    const result = await readFile(configFilePath, "utf8");

    expect(result).toContain('always_allow_tools = [ "list_projects" ]');
    expect(result).toContain('always_allow_resources = [ "test://resource" ]');
  });

  it("should not modify file if resource read is already allowed", async () => {
    const originalConfig = `[channel.telegram]
bot_token = "test-token"
allowed_user = "12345"

[approvals.mcp.todoist]
always_allow_resources = ["test://resource"]
`;
    await writeFile(configFilePath, originalConfig, "utf8");

    const store = new TomlGlobalApprovalStore(configFilePath, {}, {}, {
      todoist: ["test://resource"],
    });
    await store.allowResourceRead("todoist", "test://resource");

    const result = await readFile(configFilePath, "utf8");

    expect(result.trim()).toBe(originalConfig.trim());
  });
});
