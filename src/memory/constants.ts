import { homedir } from "node:os";
import { join } from "node:path";

/** Default MemPalace palace directory. */
export const MEMPALACE_PALACE_PATH = join(homedir(), ".mempalace", "palace");

/** Maximum number of relevant memories to include in prompts. */
export const MAX_RELEVANT_MEMORIES = 5;

/** Room names used for filing trusted entries. */
export const MEMORY_ROOM_CONVERSATION = "conversation";
export const MEMORY_ROOM_TASK_SUMMARY = "task_summary";
