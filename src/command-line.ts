import { Command, CommanderError, InvalidArgumentError } from "commander";

export type CliIo = {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
};

export const defaultCliIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
};

export function configureCliProgram(program: Command, io: CliIo = defaultCliIo): Command {
  return program
    .showHelpAfterError()
    .showSuggestionAfterError()
    .helpCommand("help [command]", "display help for command")
    .configureOutput({
      writeOut: (text) => {
        io.stdout.write(text);
      },
      writeErr: (text) => {
        io.stderr.write(text);
      },
      outputError: (text, write) => {
        write(text);
      },
    });
}

export async function runCliProgram(program: Command, args: string[]): Promise<number> {
  applyExitOverride(program);

  try {
    await program.parseAsync(args, {from: "user"});
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    throw error;
  }
}

function applyExitOverride(command: Command): void {
  command.exitOverride();
  for (const subcommand of command.commands) {
    applyExitOverride(subcommand);
  }
}

export function parseIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new InvalidArgumentError(`Expected an integer but received ${JSON.stringify(value)}.`);
  }
  return parsed;
}
