import { Codex } from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread();
const turn = await thread.run("Just reply with hello world");

console.log(turn.finalResponse);
console.log(turn.items);
