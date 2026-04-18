import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { ZodError } from "zod";
import type { McpServerConfig } from "../config.js";
import { mcpAdminMessages } from "../messages.js";
import { SandyOAuthClientProvider } from "./oauth-provider.js";
import { buildHostOauthStateDirectory } from "./oauth-paths.js";
import {
  buildRedirectOriginClientId,
  createOAuthCompatibilityFetch,
  type RecordedOAuthResponse,
  shouldUseIndieAuthFallbackClientId,
} from "./oauth-compatibility.js";

type McpServerStatus = {
  serverId: string;
  transport: McpServerConfig["transport"];
  url: string;
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
        oauthConfigured: config.oauthScopes.length > 0,
      },
      loggedIn: (await provider.tokens()) !== undefined,
    };
  }

  async login(serverId: string): Promise<void> {
    const config = this.requireServer(serverId);
    if (config.transport !== "streamable_http") {
      throw new Error(mcpAdminMessages.oauthLoginUnsupported(serverId));
    }
    const loginServerUrl = resolveLoginServerUrl(config.url);

    const callback = await startLoopbackCallbackServer();
    let authorizationUrl: URL | null = null;
    const oauthCompatibility = createOAuthCompatibilityFetch();
    let provider = this.createProvider(serverId, true, callback.redirectUrl, (url) => {
      authorizationUrl = url;
    }, undefined, config.url, loginServerUrl);
    const scope = config.oauthScopes.length > 0 ? config.oauthScopes.join(" ") : undefined;
    let result: Awaited<ReturnType<typeof auth>>;
    try {
      result = await auth(provider, {
        serverUrl: loginServerUrl,
        scope,
        fetchFn: oauthCompatibility.fetchFn,
      });
    } catch (error) {
      if (shouldUseIndieAuthFallbackClientId(error)) {
        // Retry with a client ID derived from the loopback redirect origin for
        // servers that do not support dynamic client registration and instead
        // key the client identity off the redirect URL base.
        provider = this.createProvider(
          serverId,
          true,
          callback.redirectUrl,
          (url) => {
            authorizationUrl = url;
          },
          buildRedirectOriginClientId(callback.redirectUrl),
          config.url,
          loginServerUrl,
        );
        result = await auth(provider, {
          serverUrl: loginServerUrl,
          scope,
          fetchFn: oauthCompatibility.fetchFn,
        });
      } else {
        await callback.close();
        throw normalizeOAuthLoginError(serverId, config.url, error, oauthCompatibility.lastResponse);
      }
    }

    if (result === undefined) {
      await callback.close();
      throw new Error("OAuth login did not produce a result.");
    }

    if (result === "AUTHORIZED") {
      await callback.close();
      return;
    }

    if (!authorizationUrl) {
      await callback.close();
      throw new Error(mcpAdminMessages.oauthAuthorizationUrlMissing(serverId));
    }

    console.log(mcpAdminMessages.oauthLoginOpenUrl(serverId));
    console.log(String(authorizationUrl));
    if (supportsManualOAuthInput()) {
      console.log(mcpAdminMessages.oauthLoginPastePrompt());
    }

    const manualCodeInput = createManualAuthorizationCodeInput();
    let authorizationCode: string;
    try {
      authorizationCode = await Promise.race([
        callback.waitForCode(),
        manualCodeInput.waitForCode(),
      ]);
    } finally {
      await callback.close();
      manualCodeInput.close();
    }
    try {
      await auth(provider, {
        serverUrl: loginServerUrl,
        scope,
        authorizationCode,
        fetchFn: oauthCompatibility.fetchFn,
      });
    } catch (error) {
      throw normalizeOAuthLoginError(serverId, config.url, error, oauthCompatibility.lastResponse);
    }
  }

  async logout(serverId: string): Promise<void> {
    const provider = this.createProvider(serverId, false);
    await provider.logout();
  }

  private requireServer(serverId: string): McpServerConfig {
    const config = this.mcpServers[serverId];
    if (!config) {
      throw new Error(mcpAdminMessages.unknownServer(serverId));
    }
    return config;
  }

  private createProvider(
    serverId: string,
    interactive: boolean,
    redirectUrl?: string,
    onRedirect?: (url: URL) => void,
    clientId?: string,
    configuredServerUrl?: string,
    loginServerUrl?: string,
  ): SandyOAuthClientProvider {
    return new SandyOAuthClientProvider({
      stateFilePath: join(buildHostOauthStateDirectory(this.configDirectory), `${serverId}.json`),
      redirectUrl,
      onRedirect,
      interactive,
      clientId,
      configuredServerUrl: configuredServerUrl ?? this.requireServer(serverId).url,
      loginServerUrl,
    });
  }
}

export function resolveLoginServerUrl(configuredServerUrl: string): string {
  const parsed = new URL(configuredServerUrl);
  if (parsed.hostname !== "host.docker.internal") {
    return configuredServerUrl;
  }

  parsed.hostname = "localhost";
  return parsed.href;
}

export function normalizeOAuthLoginError(
  serverId: string,
  serverUrl: string,
  error: unknown,
  rawResponse?: RecordedOAuthResponse,
): Error {
  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    });
    return new Error(mcpAdminMessages.oauthDiscoveryInvalidMetadata(serverId, serverUrl, issues, rawResponse));
  }

  return error instanceof Error ? error : new Error(String(error));
}

async function startLoopbackCallbackServer(): Promise<{
  redirectUrl: string;
  waitForCode: () => Promise<string>;
  close: () => Promise<void>;
}> {
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
      rejectCode?.(new Error(mcpAdminMessages.oauthCallbackReturnedError(error)));
      res.statusCode = 400;
      res.end(mcpAdminMessages.oauthLoginFailedResponse());
      return;
    }

    if (!code) {
      res.statusCode = 400;
      res.end(mcpAdminMessages.oauthAuthorizationCodeMissing());
      return;
    }

    resolveCode?.(code);
    res.statusCode = 200;
    res.end(mcpAdminMessages.oauthLoginCompletedResponse());
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
    throw new Error(mcpAdminMessages.oauthCallbackServerStartFailed());
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

type ManualAuthorizationCodeInput = {
  waitForCode: () => Promise<string>;
  close: () => void;
};

function createManualAuthorizationCodeInput(): ManualAuthorizationCodeInput {
  if (!supportsManualOAuthInput()) {
    return {
      waitForCode: () => new Promise<string>(() => {}),
      close: () => undefined,
    };
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let settled = false;

  const waitForCode = new Promise<string>((resolve, reject) => {
    const ask = () => {
      readline.question("", (answer) => {
        if (settled) {
          return;
        }

        try {
          const parsed = parseAuthorizationCodeInput(answer);
          if (!parsed) {
            console.log(mcpAdminMessages.oauthPasteInvalid());
            ask();
            return;
          }

          settled = true;
          resolve(parsed);
        } catch (error) {
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    };

    readline.once("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error(mcpAdminMessages.oauthManualInputClosed()));
      }
    });

    ask();
  });

  return {
    waitForCode: () => waitForCode,
    close: () => {
      if (!settled) {
        settled = true;
      }
      readline.close();
    },
  };
}

function supportsManualOAuthInput(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function parseAuthorizationCodeInput(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (!trimmed.includes("://") && (trimmed.includes("code=") || trimmed.includes("error="))) {
    return extractAuthorizationCodeFromUrlLike(trimmed);
  }

  if (URL.canParse(trimmed)) {
    return extractAuthorizationCodeFromUrlLike(trimmed);
  }

  return trimmed;
}

function extractAuthorizationCodeFromUrlLike(input: string): string | null {
  const url = URL.canParse(input) ? new URL(input) : new URL(input, "http://127.0.0.1");
  const error = url.searchParams.get("error");
  if (error) {
    throw new Error(mcpAdminMessages.oauthCallbackReturnedError(error));
  }

  const code = url.searchParams.get("code");
  return code && code.length > 0 ? code : null;
}
