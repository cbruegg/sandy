import { z } from "zod";
import { workerToolDefinitions } from "./worker-tools.js";

export type WorkerToolDefinitions = typeof workerToolDefinitions;
export type WorkerToolName = keyof WorkerToolDefinitions;
// TODO: This is still a lot of types; also i don't like the hardcoded value
export type PrivilegedWorkerToolName = Exclude<WorkerToolName, "send_file_to_channel">;
export type WorkerToolPayload<TName extends WorkerToolName = WorkerToolName> = z.infer<WorkerToolDefinitions[TName]["schema"]>;
export type PrivilegedWorkerToolPayload = WorkerToolPayload<PrivilegedWorkerToolName>;
export type WorkerToolEntry<TName extends WorkerToolName = WorkerToolName> = {
  name: TName;
  definition: WorkerToolDefinitions[TName];
};
type WorkerToolSchema = WorkerToolDefinitions[WorkerToolName]["schema"];
type WorkerToolSchemaTuple = [WorkerToolSchema, ...WorkerToolSchema[]];

function isWorkerToolName(value: string): value is WorkerToolName {
  return value in workerToolDefinitions;
}

// TODO: Can't we just iterate over Object.entries wherever this would be used?
export function getWorkerToolEntries(): WorkerToolEntry[] {
  return Object.keys(workerToolDefinitions)
    .filter(isWorkerToolName)
    .map((name) => ({
      name,
      definition: workerToolDefinitions[name],
    }));
}

export function createWorkerToolPayloadSchema(
  include: (entry: WorkerToolEntry) => boolean = () => true,
): z.ZodDiscriminatedUnion<WorkerToolSchemaTuple, "type"> {
  const schemas = getWorkerToolEntries()
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
