import {loadConfig} from "../config.js";
import {SandyMcpAdminService} from "./admin-service.js";

export async function runMcpCommand(args: string[]): Promise<void> {
    const config = loadConfig();
    const admin = new SandyMcpAdminService(config.configDirectory, config.mcpServers);
    const [command, serverId] = args;

    switch (command) {
        case "list":
            for (const server of admin.listServers()) {
                console.log(`${server.serverId}\t${server.transport}\t${server.url}`);
            }
            return;
        case "status": {
            if (!serverId) {
                throw new Error("Usage: sandy mcp status <serverId>");
            }
            const status = await admin.getStatus(serverId);
            console.log(JSON.stringify(status, null, 2));
            return;
        }
        case "login":
            if (!serverId) {
                throw new Error("Usage: sandy mcp login <serverId>");
            }
            await admin.login(serverId);
            console.log(`Logged in to ${serverId}.`);
            return;
        case "logout":
            if (!serverId) {
                throw new Error("Usage: sandy mcp logout <serverId>");
            }
            await admin.logout(serverId);
            console.log(`Logged out from ${serverId}.`);
            return;
        default:
            throw new Error("Usage: sandy mcp <list|status|login|logout> [serverId]");
    }
}