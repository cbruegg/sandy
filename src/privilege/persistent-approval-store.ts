import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseConfigTomlFile, renderConfigToml, type SandyConfigFileData } from "../config.js";

export interface PersistentApprovalStore {
  isAlwaysAllowed(serverId: string, toolName: string): boolean;
  allowTool(serverId: string, toolName: string): Promise<void>;
}

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
    const parsed = parseConfigTomlFile(raw).data;
    const next = applyPersistentApproval(parsed, serverId, toolName);
    const rendered = renderConfigToml(next);
    const tempFilePath = join(dirname(this.configFilePath), `.tmp-${process.pid}-${Date.now()}-config.toml`);
    await writeFile(tempFilePath, rendered, "utf8");
    await rename(tempFilePath, this.configFilePath);

    const tools = this.approvals.get(serverId) ?? new Set<string>();
    tools.add(toolName);
    this.approvals.set(serverId, tools);
  }
}

function applyPersistentApproval(
  config: SandyConfigFileData,
  serverId: string,
  toolName: string,
): SandyConfigFileData {
  const existingTools = config.approvals.mcp[serverId]?.always_allow_tools ?? [];
  const nextTools = Array.from(new Set([...existingTools, toolName])).sort();

  return {
    ...config,
    approvals: {
      ...config.approvals,
      mcp: {
        ...config.approvals.mcp,
        [serverId]: {
          always_allow_tools: nextTools,
        },
      },
    },
  };
}
