import { loadConfig } from "../config.js";
import { SandyMatrixAdminService } from "./admin-service.js";

export async function runMatrixCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  const matrixConfig = config.channel.kind === "matrix" ? config.channel.matrix : null;
  const admin = new SandyMatrixAdminService(config.configDirectory, matrixConfig);
  const [command] = args;

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
    default:
      throw new Error("Usage: sandy matrix <status|login|logout>");
  }
}
