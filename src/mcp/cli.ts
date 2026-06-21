import { Command } from "commander";
import { defaultCliIo, type CliIo, configureCliProgram, runCliProgram } from "../command-line.js";
import { loadConfig } from "../config.js";
import { SandyMcpAdminService } from "./admin-service.js";

type McpCliHandlers = {
  list: () => void | Promise<void>;
  status: (serverId: string) => void | Promise<void>;
  login: (serverId: string) => void | Promise<void>;
  logout: (serverId: string) => void | Promise<void>;
};

function createDefaultHandlers(io: CliIo): McpCliHandlers {
  const stdout = io.stdout;

  function createAdmin(): SandyMcpAdminService {
    const config = loadConfig();
    return new SandyMcpAdminService(config.configDirectory, config.mcpServers);
  }

  return {
    list(): void {
      const admin = createAdmin();
      for (const server of admin.listServers()) {
        const target = server.transport === "streamable_http" ? server.url : server.command;
        stdout.write(`${server.serverId}\t${server.transport}\t${target}\n`);
      }
    },
    async status(serverId: string): Promise<void> {
      const admin = createAdmin();
      const status = await admin.getStatus(serverId);
      stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    },
    async login(serverId: string): Promise<void> {
      const admin = createAdmin();
      await admin.login(serverId);
      stdout.write(`Logged in to ${serverId}.\n`);
    },
    async logout(serverId: string): Promise<void> {
      const admin = createAdmin();
      await admin.logout(serverId);
      stdout.write(`Logged out from ${serverId}.\n`);
    },
  };
}

export function createMcpCommand(
  io: CliIo = defaultCliIo,
  handlers: McpCliHandlers = createDefaultHandlers(io),
): Command {
  const command = configureCliProgram(new Command("mcp"), io)
    .description("Manage MCP server connections.");

  command
    .command("list")
    .description("List configured MCP servers.")
    .action(async () => {
      await handlers.list();
    });

  command
    .command("status")
    .description("Show the status for a configured MCP server.")
    .argument("<serverId>", "server identifier")
    .action(async (serverId: string) => {
      await handlers.status(serverId);
    });

  command
    .command("login")
    .description("Run the login flow for a configured MCP server.")
    .argument("<serverId>", "server identifier")
    .action(async (serverId: string) => {
      await handlers.login(serverId);
    });

  command
    .command("logout")
    .description("Log out from a configured MCP server.")
    .argument("<serverId>", "server identifier")
    .action(async (serverId: string) => {
      await handlers.logout(serverId);
    });

  return command;
}

export async function runMcpCommand(args: string[], io: CliIo = defaultCliIo): Promise<number> {
  return runCliProgram(createMcpCommand(io), args);
}
