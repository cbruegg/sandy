import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";

type SandyOAuthState = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
};

type SandyOAuthClientProviderOptions = {
  /**
   * JSON state file used to persist OAuth discovery, client registration, PKCE,
   * and token data for one MCP server.
   */
  stateFilePath: string;
  /**
   * Loopback redirect URL for interactive authorization-code logins. Leave
   * unset for the non-interactive MCP proxy/runtime path.
   */
  redirectUrl?: string | URL;
  /**
   * Callback invoked with the authorization URL during interactive login so the
   * caller can present or open it for the user.
   */
  onRedirect?: (authorizationUrl: URL) => void | Promise<void>;
  /**
   * Whether the provider is allowed to initiate an interactive OAuth login.
   * Runtime MCP proxy usage sets this to false and relies on persisted state.
   */
  interactive: boolean;
  /**
   * Optional fixed public client ID. This is used for servers that key the
   * client identity off a pre-derived value instead of dynamic registration.
   */
  clientId?: string;
};

export class SandyOAuthClientProvider implements OAuthClientProvider {
  private cache: SandyOAuthState | null = null;

  readonly clientMetadata: OAuthClientMetadata;
  readonly clientMetadataUrl = undefined;

  constructor(private readonly options: SandyOAuthClientProviderOptions) {
    const redirectUrl = options.redirectUrl ? String(options.redirectUrl) : undefined;
    this.clientMetadata = {
      client_name: "Sandy",
      redirect_uris: redirectUrl ? [redirectUrl] : [],
      ...(redirectUrl ? {
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      } : {}),
      token_endpoint_auth_method: "none",
    };
  }

  get redirectUrl(): string | URL | undefined {
    return this.options.redirectUrl;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const state = await this.loadState();
    const clientId = this.options.clientId;
    if (!clientId) {
      return state.clientInformation;
    }

    // When Sandy derives a per-login client ID from the callback origin, treat
    // it as the authoritative public client identity for this state file
    // instead of attempting dynamic registration first.
    if (state.clientInformation?.client_id === clientId) {
      return state.clientInformation;
    }

    const clientInformation: OAuthClientInformationMixed = {
      client_id: clientId,
    };
    state.clientInformation = clientInformation;
    await this.saveState(state);
    return clientInformation;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    const state = await this.loadState();
    state.clientInformation = clientInformation;
    await this.saveState(state);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.loadState()).tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const state = await this.loadState();
    state.tokens = tokens;
    await this.saveState(state);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.options.interactive) {
      throw new Error(`Authorization is required for this MCP server. Run "sandy mcp login <serverId>" first.`);
    }
    await this.options.onRedirect?.(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const state = await this.loadState();
    state.codeVerifier = codeVerifier;
    await this.saveState(state);
  }

  async codeVerifier(): Promise<string> {
    const state = await this.loadState();
    if (!state.codeVerifier) {
      throw new Error("No OAuth code verifier is stored.");
    }
    return state.codeVerifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    const state = await this.loadState();
    state.discoveryState = discoveryState;
    await this.saveState(state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.loadState()).discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    const state = await this.loadState();

    if (scope === "all" || scope === "client") {
      delete state.clientInformation;
    }
    if (scope === "all" || scope === "tokens") {
      delete state.tokens;
    }
    if (scope === "all" || scope === "verifier") {
      delete state.codeVerifier;
    }
    if (scope === "all" || scope === "discovery") {
      delete state.discoveryState;
    }

    await this.saveState(state);
  }

  async prepareTokenRequest(scope?: string): Promise<URLSearchParams | undefined> {
    if (!this.usesNonInteractiveRuntimeRefresh()) {
      return undefined;
    }

    const state = await this.loadState();
    const refreshToken = state.tokens?.refresh_token?.trim();
    if (!refreshToken) {
      throw new Error(`Authorization is required for this MCP server. Run "sandy mcp login <serverId>" first.`);
    }

    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (scope) {
      params.set("scope", scope);
    }
    return params;
  }

  async logout(): Promise<void> {
    this.cache = {};
    await rm(this.options.stateFilePath, { force: true });
  }

  private async loadState(): Promise<SandyOAuthState> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.options.stateFilePath, "utf8");
      this.cache = JSON.parse(raw) as SandyOAuthState;
    } catch (error) {
      if (isMissingPathError(error)) {
        this.cache = {};
      } else {
        throw error;
      }
    }

    return this.cache;
  }

  private usesNonInteractiveRuntimeRefresh(): boolean {
    return !this.options.interactive && this.options.redirectUrl === undefined;
  }

  private async saveState(state: SandyOAuthState): Promise<void> {
    this.cache = state;
    await mkdir(dirname(this.options.stateFilePath), { recursive: true });
    await writeFile(this.options.stateFilePath, JSON.stringify(state, null, 2), "utf8");
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
