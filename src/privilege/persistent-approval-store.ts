import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as toml from "@iarna/toml";
import { normalizeParsedToml } from "../config.js";

export interface PersistentApprovalStore {
  isAlwaysAllowed(serverId: string, toolName: string): boolean;
  allowTool(serverId: string, toolName: string): Promise<void>;
}

// Type for the raw approvals structure we modify
type RawApprovalsConfig = {
  approvals?: {
    mcp?: Record<string, {
      always_allow_tools?: string[];
    }>;
  };
};

export class TomlPersistentApprovalStore implements PersistentApprovalStore {
  private readonly approvals = new Map<string, Set<string>>();

  constructor(private readonly configFilePath: string, initialApprovals: Record<string, string[]>) {
    for (const [serverId, tools] of Object.entries(initialApprovals)) {
      this.approvals.set(serverId, new Set(tools));
    }
  }

  isAlwaysAllowed(serverId: string, toolName: string): boolean {
    return this.approvals.get(serverId)?.has(toolName) ?? false;
  }

  async allowTool(serverId: string, toolName: string): Promise<void> {
    if (this.isAlwaysAllowed(serverId, toolName)) {
      return;
    }

    const raw = await readFile(this.configFilePath, "utf8");
    const next = applyPersistentApprovalToRawToml(raw, serverId, toolName);
    const tempFilePath = join(dirname(this.configFilePath), `.tmp-${process.pid}-${Date.now()}-config.toml`);
    await writeFile(tempFilePath, next, "utf8");
    await rename(tempFilePath, this.configFilePath);

    const tools = this.approvals.get(serverId) ?? new Set<string>();
    tools.add(toolName);
    this.approvals.set(serverId, tools);
  }
}

function applyPersistentApprovalToRawToml(
  rawToml: string,
  serverId: string,
  toolName: string,
): string {
  // Parse without Zod schema to preserve original structure (no defaults filled in)
  const parsed = normalizeParsedToml(toml.parse(rawToml)) as RawApprovalsConfig;

  // Ensure the approvals.mcp structure exists
  if (!parsed.approvals) {
    parsed.approvals = {};
  }
  if (!parsed.approvals.mcp) {
    parsed.approvals.mcp = {};
  }
  if (!parsed.approvals.mcp[serverId]) {
    parsed.approvals.mcp[serverId] = {};
  }

  // Add the tool to always_allow_tools (sorted, unique)
  const existingTools = parsed.approvals.mcp[serverId].always_allow_tools ?? [];
  const nextTools = Array.from(new Set([...existingTools, toolName])).sort();
  parsed.approvals.mcp[serverId].always_allow_tools = nextTools;

  return toml.stringify(parsed);
}
