import { createInterface } from "node:readline";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  deleteMatrixAuthState,
  loadMatrixAuthState,
  saveMatrixAuthState,
  validateMatrixAuthStateForConfig,
} from "./auth-state.js";
import { matrixAdminMessages } from "../messages.js";

export type MatrixStatus = {
  homeserverUrl: string;
  botUserId: string;
  configured: boolean;
  loggedIn: boolean;
  matchesConfig: boolean;
};

export type MatrixLoginResult = {
  userId: string;
  deviceId: string;
};

export class SandyMatrixAdminService {
  constructor(
    private readonly configDirectory: string,
    private readonly matrixConfig: {
      homeserverUrl: string;
      botUserId: string;
    } | null,
  ) {}

  async status(): Promise<MatrixStatus | null> {
    if (!this.matrixConfig) {
      return null;
    }

    const state = await loadMatrixAuthState(this.configDirectory);
    const validation = validateMatrixAuthStateForConfig(state, this.matrixConfig);

    return {
      homeserverUrl: this.matrixConfig.homeserverUrl,
      botUserId: this.matrixConfig.botUserId,
      configured: true,
      loggedIn: state !== null,
      matchesConfig: validation.valid,
    };
  }

  async login(deviceName = "Sandy"): Promise<MatrixLoginResult> {
    if (!this.matrixConfig) {
      throw new Error(matrixAdminMessages.noMatrixConfig());
    }

    const { homeserverUrl, botUserId } = this.matrixConfig;
    const password = await this.promptForPassword();

    const loginResponse = await this.performMatrixLogin(homeserverUrl, botUserId, password, deviceName);

    if (loginResponse.userId !== botUserId) {
      throw new Error(
        matrixAdminMessages.loginUserIdMismatch(loginResponse.userId, botUserId),
      );
    }

    const existingState = await loadMatrixAuthState(this.configDirectory);
    if (existingState && existingState.deviceId !== loginResponse.deviceId) {
      await this.clearCryptoState();
    }

    await saveMatrixAuthState(this.configDirectory, {
      homeserverUrl,
      botUserId,
      deviceId: loginResponse.deviceId,
      accessToken: loginResponse.accessToken,
    });

    return {
      userId: loginResponse.userId,
      deviceId: loginResponse.deviceId,
    };
  }

  async logout(): Promise<void> {
    await deleteMatrixAuthState(this.configDirectory);
    await this.clearCryptoState();
  }

  private async performMatrixLogin(
    homeserverUrl: string,
    userId: string,
    password: string,
    deviceName: string,
  ): Promise<{ userId: string; deviceId: string; accessToken: string }> {
    const loginUrl = new URL("/_matrix/client/v3/login", homeserverUrl);
    const response = await fetch(loginUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        type: "m.login.password",
        identifier: {
          type: "m.id.user",
          user: userId,
        },
        password,
        initial_device_display_name: deviceName,
      }),
    });

    const body = await response.json();
    if (!response.ok) {
      const errorMessage = typeof (body as { error?: string })?.error === "string"
        ? (body as { error: string }).error
        : `Matrix login failed with HTTP ${response.status}.`;
      throw new Error(matrixAdminMessages.loginFailed(errorMessage));
    }

    const result = body as {
      user_id?: unknown;
      device_id?: unknown;
      access_token?: unknown;
    };

    if (
      typeof result.user_id !== "string" ||
      typeof result.device_id !== "string" ||
      typeof result.access_token !== "string"
    ) {
      throw new Error(matrixAdminMessages.loginInvalidResponse());
    }

    return {
      userId: result.user_id,
      deviceId: result.device_id,
      accessToken: result.access_token,
    };
  }

  private async promptForPassword(): Promise<string> {
    const envPassword = process.env["MATRIX_PASSWORD"];
    if (envPassword) {
      return envPassword;
    }

    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return new Promise((resolve, reject) => {
      readline.question(matrixAdminMessages.passwordPrompt(), (answer) => {
        readline.close();
        const trimmed = answer.trim();
        if (!trimmed) {
          reject(new Error(matrixAdminMessages.passwordRequired()));
          return;
        }
        resolve(trimmed);
      });
    });
  }

  private async clearCryptoState(): Promise<void> {
    const cryptoRoot = join(this.configDirectory, "state", "matrix", "crypto");
    await rm(cryptoRoot, { recursive: true, force: true });
  }
}
