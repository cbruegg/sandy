import { z } from "zod";
import { workerToolDefinitions } from "./worker-tools.js";

export type WorkerToolDefinitions = typeof workerToolDefinitions;
export type WorkerToolName = keyof WorkerToolDefinitions;
export type WorkerToolPayload<TName extends WorkerToolName = WorkerToolName> = z.infer<WorkerToolDefinitions[TName]["schema"]>;
type WorkerToolNameByPrivilege<TRequiresPrivilegeEscalation extends boolean> = {
  [TName in WorkerToolName]:
    WorkerToolDefinitions[TName]["requiresPrivilegeEscalation"] extends TRequiresPrivilegeEscalation ? TName : never;
}[WorkerToolName];
export type PrivilegedWorkerToolPayload = WorkerToolPayload<WorkerToolNameByPrivilege<true>>;
type WorkerToolEntry<TName extends WorkerToolName = WorkerToolName> = {
  name: TName;
  definition: WorkerToolDefinitions[TName];
};
type WorkerToolSchema = WorkerToolDefinitions[WorkerToolName]["schema"];
type WorkerToolSchemaTuple = [WorkerToolSchema, ...WorkerToolSchema[]];

export const workerToolEntries = Object.entries(workerToolDefinitions)
  .map(([name, definition]) => ({
    name,
    definition,
  })) as WorkerToolEntry[];

export function createWorkerToolPayloadSchema(
  include: (entry: WorkerToolEntry) => boolean = () => true,
): z.ZodDiscriminatedUnion<WorkerToolSchemaTuple, "type"> {
  const schemas = workerToolEntries
    .filter(include)
    .map((entry) => entry.definition.schema);
  const [firstSchema, ...restSchemas] = schemas;
  if (!firstSchema) {
    throw new Error("At least one worker tool schema is required.");
  }
  return z.discriminatedUnion("type", [firstSchema, ...restSchemas]);
}

export function getWorkerToolPrefix(name: WorkerToolName): string {
  return `SANDY_${name.toUpperCase()} `;
}
