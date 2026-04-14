import { runLocalTestCli } from "./local-test-cli.js";

const [, , ...args] = process.argv;

await runLocalTestCli(args);
