import { z } from "zod";
import type { SubAgentEvent } from "../types.js";
import { subAgentEventSchema } from "../types.js";
import { workerToolDefinitions } from "./worker-tools.js";

// TODO Check if we can make this generic like WorkerToolDefinition<Schema>
export type WorkerToolDefinition = {
  description: string;
  requiresPrivilegeEscalation: boolean;
  schema: z.ZodObject<z.core.$ZodLooseShape>;
};

type WorkerToolConfigs = typeof workerToolDefinitions;
type WorkerToolName = keyof WorkerToolConfigs;
// TODO: This looks quite complicated, why?
type WorkerToolRegistry = {
  [TName in WorkerToolName]: WorkerToolConfigs[TName] & {
    name: TName;
    prefix: string;
  };
};

export type WorkerToolCall = {
  [TName in WorkerToolName]: {
    tool: TName;
    definition: WorkerToolRegistry[TName];
    payload: z.infer<WorkerToolRegistry[TName]["schema"]>; // Maybe we can make WorkerToolCall generic too?
  };
}[WorkerToolName];

const workerToolRegistry = Object.fromEntries(
  Object.entries(workerToolDefinitions).map(([name, definition]) => [
    name,
    {
      ...definition,
      name,
      prefix: `SANDY_${name.toUpperCase()} `,
    },
  ]),
) as WorkerToolRegistry; // TODO: I don't like such casts, because this is not actually true: Due to the prefix addition, this does not actually satisfy the type. Maybe we can move prefix addition and stripping to the helper functions below and avoid "rewriting" the workerToolRegistry with a prefix? Its only use is detecting that a worker response *is* a tool call

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

  for (const tool of Object.values(workerToolRegistry)) {
    if (!trimmed.startsWith(tool.prefix)) {
      continue;
    }

    const rawPayload = trimmed.slice(tool.prefix.length).trim();

    try {
      const payload = JSON.parse(rawPayload) as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("Tool payload must be a JSON object.");
      }
      if (payload.type !== undefined && payload.type !== tool.name) {
        throw new Error(`Tool payload type must be "${tool.name}" when provided.`);
      }
      return {
        tool: tool.name,
        definition: tool,
        payload: tool.schema.parse({
          ...payload,
          type: tool.name,
        }),
      } as WorkerToolCall;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown tool parse failure.";
      throw new Error(`Invalid ${tool.name} tool payload: ${detail} Payload: ${rawPayload}`, { cause: error });
    }
  }

  return null;
}

export function workerToolCallToSubAgentEvent(
  call: WorkerToolCall,
): Extract<SubAgentEvent, { type: "tool_call" }> {
  return subAgentEventSchema.parse({
    type: "tool_call",
    call: call.payload,
  }) as Extract<SubAgentEvent, { type: "tool_call" }>;
}

function buildWorkerToolInstructionSections(): string[] {
  return Object.values(workerToolRegistry).flatMap((tool) => buildWorkerToolInstructionSection(tool));
}

function buildWorkerToolInstructionSection(tool: WorkerToolRegistry[WorkerToolName]): string[] {
  return [
    `Tool "${tool.prefix.trim()}": ${tool.description}`,
    `Format: ${tool.prefix}{...json...}`,
    `Schema: ${JSON.stringify(z.toJSONSchema(tool.schema))}`,
  ];
}
