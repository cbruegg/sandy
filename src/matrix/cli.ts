import { loadConfig } from "../config.js";
import { SandyMatrixAdminService } from "./admin-service.js";
import { SandyMatrixVerificationService, type VerificationStatus } from "./verification-service.js";

export async function runMatrixCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  const matrixConfig = config.channel.kind === "matrix" ? config.channel.matrix : null;
  const admin = new SandyMatrixAdminService(config.configDirectory, matrixConfig);
  const verification = new SandyMatrixVerificationService(config.configDirectory, matrixConfig);
  const [command, subcommand] = args;

  switch (command) {
    case "status": {
      const status = await admin.status();
      if (!status) {
        console.log("Matrix channel is not configured.");
        return;
      }
      console.log(`Homeserver URL: ${status.homeserverUrl}`);
      console.log(`Bot User ID: ${status.botUserId}`);
      console.log(`Logged in: ${status.loggedIn ? "yes" : "no"}`);
      if (status.deviceId) {
        console.log(`Device ID: ${status.deviceId}`);
      }
      console.log(`Matches config: ${status.matchesConfig ? "yes" : "no"}`);
      return;
    }
    case "login": {
      const deviceName = args[1] ?? "Sandy";
      const result = await admin.login(deviceName);
      console.log(`Logged in as ${result.userId} (device: ${result.deviceId}).`);
      return;
    }
    case "logout": {
      await admin.logout();
      console.log("Logged out from Matrix.");
      return;
    }
    case "verify": {
      await runVerifyCommand(verification, subcommand);
      return;
    }
    default:
      throw new Error("Usage: sandy matrix <status|login|logout|verify>");
  }
}

async function runVerifyCommand(
  verification: SandyMatrixVerificationService,
  subcommand: string | undefined,
): Promise<void> {
  switch (subcommand) {
    case "status": {
      const status: VerificationStatus | null = await verification.status();
      if (!status) {
        console.log(
          "Matrix verification status is unavailable. Run \"sandy matrix login\" first.",
        );
        return;
      }
      console.log(`Device ID: ${status.deviceId}`);
      console.log(
        `Cross-signing keys: ${status.hasCrossSigningKeys ? "available" : "not available"}`,
      );
      console.log(`Device verified: ${status.isDeviceVerified ? "yes" : "no"}`);
      return;
    }
    case "recovery-key": {
      const result = await verification.verifyWithRecoveryKey();
      console.log(`Device ${result.deviceId} has been signed successfully.`);
      return;
    }
    default:
      throw new Error("Usage: sandy matrix verify <status|recovery-key>");
  }
}
