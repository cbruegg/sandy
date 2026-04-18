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
import { rewriteUrlOrigin } from "./oauth-compatibility.js";

type SandyOAuthState = {
  /**
   * Canonical URL from config.toml at the time the user last logged in.
   *
   * OAuth discovery and tokens are treated as bound to this exact configured
   * server URL. If the config changes later, Sandy intentionally discards the
   * cached state and requires a fresh login instead of trying to guess whether
   * the old discovery metadata and refresh endpoints are still valid.
   */
  configuredServerUrl?: string;
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
  /**
   * Canonical MCP server URL from config.toml. Persisted OAuth state is bound
   * to this URL and is considered stale if the configured URL changes.
   */
  configuredServerUrl: string;
  /**
   * Optional host-local URL used only during `sandy mcp login` when the
   * canonical configured URL is not directly resolvable from the host.
   */
  loginServerUrl?: string;
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
    // During `sandy mcp login`, discovery must remain usable from the host for
    // the full OAuth flow, including the final authorization-code exchange.
    // That means we persist the host-local view here as-is and only rewrite it
    // to the canonical configured URL after login succeeds.
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

  async canonicalizeForConfiguredServer(): Promise<void> {
    const state = await this.loadState();
    if (!state.discoveryState) {
      return;
    }

    // Login may have used a host-only alias such as `localhost` for a server
    // that is configured canonically as `host.docker.internal` for runtime use
    // inside the MCP sidecar. Once interactive login is complete, rewrite all
    // saved discovery endpoints back to the configured URL so later runtime
    // refresh/token requests use the sidecar-reachable hostname.
    state.discoveryState = this.normalizeDiscoveryState(state.discoveryState);
    await this.saveState(state);
  }

  private async loadState(): Promise<SandyOAuthState> {
    if (this.cache) {
      return this.cache;
    }

    try {
      const raw = await readFile(this.options.stateFilePath, "utf8");
      this.cache = JSON.parse(raw) as SandyOAuthState;
      if (this.cache.configuredServerUrl !== this.options.configuredServerUrl) {
        // A URL change is treated as a different server identity/reachability
        // context. This avoids brittle partial rewrites of old OAuth metadata
        // and forces the user to run `sandy mcp login` again for the new URL.
        this.cache = {
          configuredServerUrl: this.options.configuredServerUrl,
        };
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        this.cache = {
          configuredServerUrl: this.options.configuredServerUrl,
        };
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
    this.cache = {
      ...state,
      configuredServerUrl: this.options.configuredServerUrl,
    };
    await mkdir(dirname(this.options.stateFilePath), { recursive: true });
    await writeFile(this.options.stateFilePath, JSON.stringify(this.cache, null, 2), "utf8");
  }

  private normalizeDiscoveryState(discoveryState: OAuthDiscoveryState): OAuthDiscoveryState {
    const loginServerUrl = this.options.loginServerUrl;
    if (!loginServerUrl || loginServerUrl === this.options.configuredServerUrl) {
      return discoveryState;
    }

    // The provider stores one logical server identity:
    // - `loginServerUrl`: only used from the host during `sandy mcp login`
    // - `configuredServerUrl`: canonical runtime URL from config.toml
    //
    // For host-local services on Linux, these can differ:
    // - login:    `http://localhost:8123/...`
    // - runtime:  `http://host.docker.internal:8123/...`
    //
    // After login succeeds, we rewrite any discovered OAuth endpoints from the
    // host-local origin back to the configured runtime origin so the sidecar
    // can later refresh tokens and talk to the same logical server.
    const normalized = structuredClone(discoveryState) as OAuthDiscoveryState & {
      resourceMetadata?: {
        resource?: string;
      };
      authorizationServerMetadata?: Record<string, unknown>;
    };

    normalized.authorizationServerUrl = rewriteUrlOrigin(
      normalized.authorizationServerUrl,
      loginServerUrl,
      this.options.configuredServerUrl,
    );
    if (normalized.resourceMetadataUrl) {
      normalized.resourceMetadataUrl = rewriteUrlOrigin(
        normalized.resourceMetadataUrl,
        loginServerUrl,
        this.options.configuredServerUrl,
      );
    }
    if (normalized.resourceMetadata?.resource) {
      normalized.resourceMetadata.resource = rewriteUrlOrigin(
        normalized.resourceMetadata.resource,
        loginServerUrl,
        this.options.configuredServerUrl,
      );
    }
    if (normalized.authorizationServerMetadata) {
      for (const [key, value] of Object.entries(normalized.authorizationServerMetadata)) {
        if (typeof value !== "string") {
          continue;
        }
        if (!URL.canParse(value)) {
          continue;
        }
        normalized.authorizationServerMetadata[key] = rewriteUrlOrigin(
          value,
          loginServerUrl,
          this.options.configuredServerUrl,
        );
      }
    }

    return normalized;
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
