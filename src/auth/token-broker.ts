import { readFile, writeFile } from "node:fs/promises";
import { logger } from "../logger.js";
import type { ChatGptExternalTokens } from "../types.js";

const AUTH_REFRESH_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

interface AuthDotJson {
  auth_mode?: string;
  OPENAI_API_KEY?: string;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
  agent_identity?: string;
}

interface JwtClaims {
  chatgpt_plan_type?: string;
  chatgpt_account_id?: string;
  chatgpt_user_id?: string;
  email?: string;
  [key: string]: unknown;
}

export interface TokenBroker {
  getInitialTokens(): Promise<ChatGptExternalTokens>;
  refreshTokens(previousAccountId: string | null): Promise<ChatGptExternalTokens>;
}

function decodeJwtPayload(jwt: string): JwtClaims | null {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return null;
    let payload = parts[1];
    if (!payload) return null;
    payload = payload.replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4 !== 0) payload += "=";
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(decoded) as JwtClaims;
  } catch {
    return null;
  }
}

export class CodexTokenBroker implements TokenBroker {
  private authDotJson: AuthDotJson | null = null;
  private refreshInFlight: Promise<ChatGptExternalTokens> | null = null;
  private cachedTokens: ChatGptExternalTokens | null = null;

  constructor(private readonly authFilePath: string) {}

  async getInitialTokens(): Promise<ChatGptExternalTokens> {
    if (this.cachedTokens) {
      return this.cachedTokens;
    }
    const tokens = await this.loadAndExtractTokens();
    this.cachedTokens = tokens;
    return tokens;
  }

  async refreshTokens(_previousAccountId: string | null): Promise<ChatGptExternalTokens> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.doRefreshTokens(_previousAccountId);
    try {
      const tokens = await this.refreshInFlight;
      return tokens;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async doRefreshTokens(_previousAccountId: string | null): Promise<ChatGptExternalTokens> {
    const auth = await this.loadAuthFile();

    if (auth.auth_mode === "chatgpt" && auth.tokens?.refresh_token) {
      const newTokens = await this.callRefreshEndpoint(auth.tokens.refresh_token);
      if (newTokens) {
        const updatedAuth = this.applyRefreshResponse(auth, newTokens);
        await this.persistAuthFile(updatedAuth);
        this.authDotJson = updatedAuth;
        const extracted = this.extractTokens(updatedAuth);
        this.cachedTokens = extracted;
        return extracted;
      }
    }

    const extracted = this.extractTokens(auth);
    this.cachedTokens = extracted;
    return extracted;
  }

  private async loadAndExtractTokens(): Promise<ChatGptExternalTokens> {
    const auth = await this.loadAuthFile();
    return this.extractTokens(auth);
  }

  private async loadAuthFile(): Promise<AuthDotJson> {
    if (this.authDotJson) {
      return this.authDotJson;
    }
    const raw = await readFile(this.authFilePath, "utf8");
    const parsed = JSON.parse(raw) as AuthDotJson;
    this.authDotJson = parsed;
    return parsed;
  }

  private extractTokens(auth: AuthDotJson): ChatGptExternalTokens {
    const accessToken = auth.tokens?.access_token;
    if (!accessToken) {
      throw new Error("auth.json is missing access_token. Run 'codex login' first.");
    }

    let chatgptAccountId: string | null = null;
    let chatgptPlanType: string | null = null;

    if (auth.tokens?.id_token) {
      const claims = decodeJwtPayload(auth.tokens.id_token);
      if (claims) {
        chatgptAccountId = claims.chatgpt_account_id ?? null;
        chatgptPlanType = claims.chatgpt_plan_type ?? null;
      }
    }

    chatgptAccountId = auth.tokens?.account_id ?? chatgptAccountId;

    if (!chatgptAccountId) {
      throw new Error(
        "auth.json does not include a chatgpt_account_id. " +
        "Ensure the auth session was created with 'codex login' (not API key login)."
      );
    }

    return {
      accessToken,
      chatgptAccountId,
      chatgptPlanType,
    };
  }

  private async callRefreshEndpoint(refreshToken: string): Promise<{
    access_token: string;
    refresh_token?: string;
    id_token?: string;
  } | null> {
    try {
      const response = await fetch(AUTH_REFRESH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: CODEX_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        logger.warn("token_broker.refresh_failed", {
          status: response.status,
          body,
        });
        return null;
      }

      return await response.json() as {
        access_token: string;
        refresh_token?: string;
        id_token?: string;
      };
    } catch (error) {
      logger.error("token_broker.refresh_error", {
        message: error instanceof Error ? error.message : "Unknown refresh error.",
      });
      return null;
    }
  }

  private applyRefreshResponse(
    auth: AuthDotJson,
    response: {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
    },
  ): AuthDotJson {
    const updatedAuth = structuredClone(auth);
    if (!updatedAuth.tokens) {
      throw new Error("auth.json has no tokens object to update.");
    }

    updatedAuth.tokens.access_token = response.access_token;
    if (response.refresh_token) {
      updatedAuth.tokens.refresh_token = response.refresh_token;
    }
    if (response.id_token) {
      updatedAuth.tokens.id_token = response.id_token;
    }
    updatedAuth.last_refresh = new Date().toISOString();

    return updatedAuth;
  }

  private async persistAuthFile(auth: AuthDotJson): Promise<void> {
    await writeFile(this.authFilePath, JSON.stringify(auth, null, 2) + "\n", "utf8");
    logger.info("token_broker.auth_persisted", {
      path: this.authFilePath,
      lastRefresh: auth.last_refresh,
    });
  }
}
