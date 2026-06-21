import {runLocalTestCli} from "./local-test-cli.js";

process.exitCode = await runLocalTestCli(process.argv.slice(2));
