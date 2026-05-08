import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as toml from "@iarna/toml";
import { normalizeParsedToml } from "../config.js";

export interface PersistentApprovalStore {
  isAlwaysAllowed(serverId: string, toolName: string): boolean;
  allowTool(serverId: string, toolName: string): Promise<void>;
  isResourceReadAlwaysAllowed(serverId: string, uri: string): boolean;
  allowResourceRead(serverId: string, uri: string): Promise<void>;
  isHttpTokenAlwaysAllowed(tokenId: string, host: string): boolean;
  allowHttpToken(tokenId: string, host: string): Promise<void>;
  isHostDirectoryAlwaysAllowed(path: string, level: "read_only" | "read_write"): boolean;
  allowHostDirectory(path: string, level: "read_only" | "read_write"): Promise<void>;
}

// Type for the raw approvals structure we modify
type RawApprovalsConfig = {
  approvals?: {
    mcp?: Record<string, {
      always_allow_tools?: string[];
      always_allow_resources?: string[];
    }>;
    http?: Record<string, {
      always_allow_hosts?: string[];
    }>;
    host_directories?: Array<{
      path: string;
      level: string;
    }>;
  };
};

export class TomlPersistentApprovalStore implements PersistentApprovalStore {
  private readonly approvals = new Map<string, Set<string>>();
  private readonly resourceApprovals = new Map<string, Set<string>>();
  private readonly httpApprovals = new Map<string, Set<string>>();
  private readonly hostDirectoryApprovals = new Map<string, "read_only" | "read_write">();

  constructor(
    private readonly configFilePath: string,
    initialApprovals: Record<string, string[]>,
    initialHttpApprovals: Record<string, string[]> = {},
    initialResourceApprovals: Record<string, string[]> = {},
    initialHostDirectoryApprovals: Array<{path: string; level: "read_only" | "read_write"}> = [],
  ) {
    for (const [serverId, tools] of Object.entries(initialApprovals)) {
      this.approvals.set(serverId, new Set(tools));
    }
    for (const [serverId, resources] of Object.entries(initialResourceApprovals)) {
      this.resourceApprovals.set(serverId, new Set(resources));
    }
    for (const [tokenId, hosts] of Object.entries(initialHttpApprovals)) {
      this.httpApprovals.set(tokenId, new Set(hosts));
    }
    for (const entry of initialHostDirectoryApprovals) {
      this.hostDirectoryApprovals.set(entry.path, entry.level);
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

  isResourceReadAlwaysAllowed(serverId: string, uri: string): boolean {
    return this.resourceApprovals.get(serverId)?.has(uri) ?? false;
  }

  async allowResourceRead(serverId: string, uri: string): Promise<void> {
    if (this.isResourceReadAlwaysAllowed(serverId, uri)) {
      return;
    }

    const raw = await readFile(this.configFilePath, "utf8");
    const next = applyPersistentResourceApprovalToRawToml(raw, serverId, uri);
    const tempFilePath = join(dirname(this.configFilePath), `.tmp-${process.pid}-${Date.now()}-config.toml`);
    await writeFile(tempFilePath, next, "utf8");
    await rename(tempFilePath, this.configFilePath);

    const resources = this.resourceApprovals.get(serverId) ?? new Set<string>();
    resources.add(uri);
    this.resourceApprovals.set(serverId, resources);
  }

  isHttpTokenAlwaysAllowed(tokenId: string, host: string): boolean {
    return this.httpApprovals.get(tokenId)?.has(host) ?? false;
  }

  async allowHttpToken(tokenId: string, host: string): Promise<void> {
    if (this.isHttpTokenAlwaysAllowed(tokenId, host)) {
      return;
    }

    const raw = await readFile(this.configFilePath, "utf8");
    const next = applyHttpPersistentApprovalToRawToml(raw, tokenId, host);
    const tempFilePath = join(dirname(this.configFilePath), `.tmp-${process.pid}-${Date.now()}-config.toml`);
    await writeFile(tempFilePath, next, "utf8");
    await rename(tempFilePath, this.configFilePath);

    const hosts = this.httpApprovals.get(tokenId) ?? new Set<string>();
    hosts.add(host);
    this.httpApprovals.set(tokenId, hosts);
  }

  isHostDirectoryAlwaysAllowed(path: string, level: "read_only" | "read_write"): boolean {
    const stored = this.hostDirectoryApprovals.get(path);
    if (!stored) {
      return false;
    }
    return stored === "read_write" || level === "read_only";
  }

  async allowHostDirectory(path: string, level: "read_only" | "read_write"): Promise<void> {
    if (this.isHostDirectoryAlwaysAllowed(path, level)) {
      return;
    }

    const raw = await readFile(this.configFilePath, "utf8");
    const next = applyHostDirectoryPersistentApprovalToRawToml(raw, path, level);
    const tempFilePath = join(dirname(this.configFilePath), `.tmp-${process.pid}-${Date.now()}-config.toml`);
    await writeFile(tempFilePath, next, "utf8");
    await rename(tempFilePath, this.configFilePath);

    this.hostDirectoryApprovals.set(path, level);
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

function applyHttpPersistentApprovalToRawToml(
  rawToml: string,
  tokenId: string,
  host: string,
): string {
  const parsed = normalizeParsedToml(toml.parse(rawToml)) as RawApprovalsConfig;

  if (!parsed.approvals) {
    parsed.approvals = {};
  }
  if (!parsed.approvals.http) {
    parsed.approvals.http = {};
  }
  if (!parsed.approvals.http[tokenId]) {
    parsed.approvals.http[tokenId] = {};
  }

  const existingHosts = parsed.approvals.http[tokenId].always_allow_hosts ?? [];
  const nextHosts = Array.from(new Set([...existingHosts, host])).sort();
  parsed.approvals.http[tokenId].always_allow_hosts = nextHosts;

  return toml.stringify(parsed);
}

function applyPersistentResourceApprovalToRawToml(
  rawToml: string,
  serverId: string,
  uri: string,
): string {
  const parsed = normalizeParsedToml(toml.parse(rawToml)) as RawApprovalsConfig;

  if (!parsed.approvals) {
    parsed.approvals = {};
  }
  if (!parsed.approvals.mcp) {
    parsed.approvals.mcp = {};
  }
  if (!parsed.approvals.mcp[serverId]) {
    parsed.approvals.mcp[serverId] = {};
  }

  const existingResources = parsed.approvals.mcp[serverId].always_allow_resources ?? [];
  const nextResources = Array.from(new Set([...existingResources, uri])).sort();
  parsed.approvals.mcp[serverId].always_allow_resources = nextResources;

  return toml.stringify(parsed);
}

function applyHostDirectoryPersistentApprovalToRawToml(
  rawToml: string,
  path: string,
  level: "read_only" | "read_write",
): string {
  const parsed = normalizeParsedToml(toml.parse(rawToml)) as RawApprovalsConfig;

  if (!parsed.approvals) {
    parsed.approvals = {};
  }
  if (!parsed.approvals.host_directories) {
    parsed.approvals.host_directories = [];
  }

  const hostDirectories = parsed.approvals.host_directories;
  const existingIndex = hostDirectories.findIndex((entry) => entry.path === path);

  if (existingIndex >= 0) {
    const existingEntry = hostDirectories[existingIndex];
    if (existingEntry) {
      if (existingEntry.level === "read_write" || level === "read_only") {
        // Already satisfied
        return rawToml;
      }
      // Upgrade read_only to read_write
      existingEntry.level = level;
    }
  } else {
    hostDirectories.push({path, level});
  }

  // Sort by path for consistency
  parsed.approvals.host_directories = hostDirectories.sort((a, b) => a.path.localeCompare(b.path));

  return toml.stringify(parsed);
}
