import { Command } from "commander";
import { defaultCliIo, type CliIo, configureCliProgram, runCliProgram } from "./command-line.js";
import { createMcpCommand } from "./mcp/cli.js";
import { createMatrixCommand } from "./matrix/cli.js";

type MainCliDependencies = {
  startApp: () => Promise<void>;
};

const defaultDependencies: MainCliDependencies = {
  startApp: () => import("./app.js").then(({startApp}) => startApp()),
};

export function createMainProgram(
  dependencies: MainCliDependencies = defaultDependencies,
  io: CliIo = defaultCliIo,
): Command {
  const program = configureCliProgram(new Command("sandy"), io)
    .description("Run Sandy or one of its admin commands.")
    .action(async () => {
      await dependencies.startApp();
    });

  program.addCommand(createMcpCommand(io));
  program.addCommand(createMatrixCommand(io));

  return program;
}

export async function runMainCli(args: string[], io: CliIo = defaultCliIo): Promise<number> {
  return runCliProgram(createMainProgram(defaultDependencies, io), args);
}
