import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpServerConfig } from "../config.js";
import { SandyOAuthClientProvider } from "./oauth-provider.js";

type McpServerStatus = {
  serverId: string;
  transport: McpServerConfig["transport"];
  url: string | null;
  command: string | null;
  oauthConfigured: boolean;
};

export class SandyMcpAdminService {
  constructor(
    private readonly configDirectory: string,
    private readonly mcpServers: Record<string, McpServerConfig>,
  ) {}

  listServers(): McpServerStatus[] {
    return Object.entries(this.mcpServers).map(([serverId, config]) => ({
      serverId,
      transport: config.transport,
      url: config.url,
      command: config.command,
      oauthConfigured: config.oauthScopes.length > 0,
    }));
  }

  async getStatus(serverId: string): Promise<{ server: McpServerStatus; loggedIn: boolean }> {
    const config = this.requireServer(serverId);
    const provider = this.createProvider(serverId, false);
    return {
      server: {
        serverId,
        transport: config.transport,
        url: config.url,
        command: config.command,
        oauthConfigured: config.oauthScopes.length > 0,
      },
      loggedIn: (await provider.tokens()) !== undefined,
    };
  }

  async login(serverId: string): Promise<void> {
    const config = this.requireServer(serverId);
    if (config.transport !== "streamable_http" || !config.url) {
      throw new Error(`MCP server ${serverId} does not support OAuth login because it is not streamable_http.`);
    }

    const callback = await startLoopbackCallbackServer();
    let authorizationUrl: URL | null = null;
    const provider = this.createProvider(serverId, true, callback.redirectUrl, (url) => {
      authorizationUrl = url;
    });
    const scope = config.oauthScopes.length > 0 ? config.oauthScopes.join(" ") : undefined;
    const result = await auth(provider, {
      serverUrl: config.url,
      scope,
    });

    if (result === "AUTHORIZED") {
      await callback.close();
      return;
    }

    if (!authorizationUrl) {
      await callback.close();
      throw new Error(`OAuth login for ${serverId} did not provide an authorization URL.`);
    }

    console.log(`Open this URL to authorize ${serverId}:`);
    console.log(String(authorizationUrl));
    const authorizationCode = await callback.waitForCode();
    await callback.close();
    await auth(provider, {
      serverUrl: config.url,
      scope,
      authorizationCode,
    });
  }

  async logout(serverId: string): Promise<void> {
    const provider = this.createProvider(serverId, false);
    await provider.logout();
  }

  private requireServer(serverId: string): McpServerConfig {
    const config = this.mcpServers[serverId];
    if (!config) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }
    return config;
  }

  private createProvider(
    serverId: string,
    interactive: boolean,
    redirectUrl?: string,
    onRedirect?: (url: URL) => void,
  ): SandyOAuthClientProvider {
    return new SandyOAuthClientProvider({
      stateFilePath: join(this.configDirectory, "oauth", `${serverId}.json`),
      redirectUrl,
      onRedirect,
      interactive,
    });
  }
}

async function startLoopbackCallbackServer(): Promise<{
  redirectUrl: string;
  waitForCode: () => Promise<string>;
  close: () => Promise<void>;
}> {
  await mkdir(join(process.cwd(), ".tmp"), { recursive: true });
  let resolveCode: ((value: string) => void) | null = null;
  let rejectCode: ((reason?: unknown) => void) | null = null;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      rejectCode?.(new Error(`OAuth callback returned error: ${error}`));
      res.statusCode = 400;
      res.end("OAuth login failed. You can close this tab.");
      return;
    }

    if (!code) {
      res.statusCode = 400;
      res.end("Missing OAuth authorization code.");
      return;
    }

    resolveCode?.(code);
    res.statusCode = 200;
    res.end("OAuth login completed. You can close this tab.");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start OAuth callback server.");
  }

  return {
    redirectUrl: `http://127.0.0.1:${address.port}/callback`,
    waitForCode: () => codePromise,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
  };
}
