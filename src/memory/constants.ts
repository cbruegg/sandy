import { homedir } from "node:os";
import { join } from "node:path";

/** Default MemPalace palace directory. */
export const MEMPALACE_PALACE_PATH = join(homedir(), ".mempalace", "palace");

/** Maximum number of relevant memories to include in prompts. */
export const MAX_RELEVANT_MEMORIES = 5;

/**
 * Sandy currently uses one shared wing so memories can be recalled across
 * chats for the single controlling user.
 */
export const SANDY_MEMORY_WING = "sandy";

/** Room names used for filing trusted entries. */
export const MEMORY_ROOM_CONVERSATION = "conversation";
export const MEMORY_ROOM_TASK_SUMMARY = "task_summary";
