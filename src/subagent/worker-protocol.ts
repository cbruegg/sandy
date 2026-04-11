import { z } from "zod";
import type { SubAgentEvent } from "../types.js";
import type { WorkerToolDefinitions, WorkerToolName, WorkerToolPayload } from "./worker-tool-registry.js";
import { getWorkerToolPrefix, workerToolEntries } from "./worker-tool-registry.js";

export type WorkerToolDefinition<TSchema extends z.ZodObject<z.core.$ZodLooseShape> = z.ZodObject<z.core.$ZodLooseShape>> = {
  description: string;
  requiresPrivilegeEscalation: boolean;
  schema: TSchema;
};

type WorkerToolCallFor<TName extends WorkerToolName> = {
  tool: TName;
  definition: WorkerToolDefinitions[TName];
  payload: WorkerToolPayload<TName>;
};

type WorkerToolCall<TName extends WorkerToolName = WorkerToolName> = TName extends WorkerToolName
  ? WorkerToolCallFor<TName>
  : never;

export function buildWorkerProtocolInstructions(): string[] {
  return [
    "Protocol requirements for host-mediated actions:",
    "Use a tool by emitting exactly one line with no surrounding text.",
    ...buildWorkerToolInstructionSections(),
    "After emitting a tool call, stop and wait for the next host message before continuing.",
  ];
}

export function parseWorkerToolCall(text: string): WorkerToolCall | null {
  const trimmed = text.trim();

  for (const entry of workerToolEntries) {
    const prefix = getWorkerToolPrefix(entry.name);
    if (!trimmed.startsWith(prefix)) {
      continue;
    }

    const rawPayload = trimmed.slice(prefix.length).trim();

    try {
      const payload = JSON.parse(rawPayload) as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Tool payload must be a JSON object.");
      }
      if (payload["type"] !== undefined && payload["type"] !== entry.name) {
        throw new Error(`Tool payload type must be "${entry.name}" when provided.`);
      }
      return {
        tool: entry.name,
        definition: entry.definition,
        payload: entry.definition.schema.parse({
          ...payload,
          type: entry.name,
        }),
      } as WorkerToolCall;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown tool parse failure.";
      throw new Error(`Invalid ${entry.name} tool payload: ${detail} Payload: ${rawPayload}`, { cause: error });
    }
  }

  return null;
}

export function workerToolCallToSubAgentEvent(
  call: WorkerToolCall,
): Extract<SubAgentEvent, { type: "tool_call" }> | Extract<SubAgentEvent, { type: "task_done" }> {
  if (call.tool === "complete_task") {
    return {
      type: "task_done",
    };
  }

  return {
    type: "tool_call",
    call: call.payload,
  };
}

function buildWorkerToolInstructionSections(): string[] {
  return workerToolEntries.flatMap((entry) => buildWorkerToolInstructionSection(entry));
}

function buildWorkerToolInstructionSection(
  entry: typeof workerToolEntries[number],
): string[] {
  const prefix = getWorkerToolPrefix(entry.name);
  return [
    `Tool "${prefix.trim()}": ${entry.definition.description}`,
    `Format: ${prefix}{...json...}`,
    `Schema: ${JSON.stringify(z.toJSONSchema(entry.definition.schema))}`,
     // deliberately do not include whether this tool requires privilege escalation;
     // agent probably does not need to know
  ];
}
