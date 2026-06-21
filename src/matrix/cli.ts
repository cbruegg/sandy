import { Command } from "commander";
import { defaultCliIo, type CliIo, configureCliProgram, runCliProgram } from "../command-line.js";
import { loadConfig } from "../config.js";
import { SandyMatrixAdminService } from "./admin-service.js";
import { SandyMatrixVerificationService, type VerificationStatus } from "./verification-service.js";

type MatrixCliHandlers = {
  status: () => Promise<void>;
  login: (deviceName: string) => Promise<void>;
  logout: () => Promise<void>;
  verifyStatus: () => Promise<void>;
  verifyRecoveryKey: () => Promise<void>;
};

function createDefaultHandlers(io: CliIo): MatrixCliHandlers {
  const stdout = io.stdout;

  function createServices(): {
    admin: SandyMatrixAdminService;
    verification: SandyMatrixVerificationService;
  } {
    const config = loadConfig();
    const matrixConfig = config.channel.kind === "matrix" ? config.channel.matrix : null;

    return {
      admin: new SandyMatrixAdminService(config.configDirectory, matrixConfig),
      verification: new SandyMatrixVerificationService(config.configDirectory, matrixConfig),
    };
  }

  return {
    async status(): Promise<void> {
      const {admin} = createServices();
      const status = await admin.status();
      if (!status) {
        stdout.write("Matrix channel is not configured.\n");
        return;
      }
      stdout.write(`Homeserver URL: ${status.homeserverUrl}\n`);
      stdout.write(`Bot User ID: ${status.botUserId}\n`);
      stdout.write(`Logged in: ${status.loggedIn ? "yes" : "no"}\n`);
      if (status.deviceId) {
        stdout.write(`Device ID: ${status.deviceId}\n`);
      }
      stdout.write(`Matches config: ${status.matchesConfig ? "yes" : "no"}\n`);
    },
    async login(deviceName: string): Promise<void> {
      const {admin} = createServices();
      const result = await admin.login(deviceName);
      stdout.write(`Logged in as ${result.userId} (device: ${result.deviceId}).\n`);
    },
    async logout(): Promise<void> {
      const {admin} = createServices();
      await admin.logout();
      stdout.write("Logged out from Matrix.\n");
    },
    async verifyStatus(): Promise<void> {
      const {verification} = createServices();
      const status: VerificationStatus | null = await verification.status();
      if (!status) {
        stdout.write("Matrix verification status is unavailable. Run \"sandy matrix login\" first.\n");
        return;
      }
      stdout.write(`Device ID: ${status.deviceId}\n`);
      stdout.write(`Cross-signing keys: ${status.hasCrossSigningKeys ? "available" : "not available"}\n`);
      stdout.write(`Device verified: ${status.isDeviceVerified ? "yes" : "no"}\n`);
    },
    async verifyRecoveryKey(): Promise<void> {
      const {verification} = createServices();
      const result = await verification.verifyWithRecoveryKey();
      stdout.write(`Device ${result.deviceId} has been signed successfully.\n`);
    },
  };
}

export function createMatrixCommand(
  io: CliIo = defaultCliIo,
  handlers: MatrixCliHandlers = createDefaultHandlers(io),
): Command {
  const command = configureCliProgram(new Command("matrix"), io)
    .description("Manage Matrix channel authentication and verification.");

  command
    .command("status")
    .description("Show Matrix channel status.")
    .action(async () => {
      await handlers.status();
    });

  command
    .command("login")
    .description("Log in the Matrix bot account.")
    .argument("[deviceName]", "device display name", "Sandy")
    .action(async (deviceName: string) => {
      await handlers.login(deviceName);
    });

  command
    .command("logout")
    .description("Log out the Matrix bot account.")
    .action(async () => {
      await handlers.logout();
    });

  const verifyCommand = command
    .command("verify")
    .description("Inspect or update Matrix device verification.");

  verifyCommand
    .command("status")
    .description("Show Matrix device verification status.")
    .action(async () => {
      await handlers.verifyStatus();
    });

  verifyCommand
    .command("recovery-key")
    .description("Verify the current Matrix device with the recovery key.")
    .action(async () => {
      await handlers.verifyRecoveryKey();
    });

  return command;
}

export async function runMatrixCommand(args: string[], io: CliIo = defaultCliIo): Promise<number> {
  return runCliProgram(createMatrixCommand(io), args);
}
