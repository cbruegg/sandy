import type { SubAgentEvent } from "../types.js";

export function writeSubAgentEvent(event: SubAgentEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
