import {runMainCli} from "./main-cli.js";

process.exitCode = await runMainCli(process.argv.slice(2));
