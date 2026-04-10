import {startApp} from "./app.js";
import {runMcpCommand} from "./mcp/cli.js";

const [, , ...args] = process.argv;

if (args[0] === "mcp") {
  await runMcpCommand(args.slice(1));
} else {
  await startApp();
}
