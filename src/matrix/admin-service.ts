import { randomBytes } from "node:crypto";
import {rm} from "node:fs/promises";
import { matrixStateRoot } from "../state-paths.js";
import {
  deleteMatrixAuthState,
  loadMatrixAuthState,
  saveMatrixAuthState,
  validateMatrixAuthStateForConfig,
} from "./auth-state.js";
import {matrixAdminMessages} from "../messages-to-user.js";

type MatrixStatus = {
  homeserverUrl: string;
  botUserId: string;
  deviceId: string | null;
  configured: boolean;
  loggedIn: boolean;
  matchesConfig: boolean;
};

type MatrixLoginResult = {
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
      deviceId: state?.deviceId ?? null,
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

    // Matrix permits clients to choose their device ID at login. Asking for a
    // fresh Sandy-scoped ID avoids reusing a homeserver device whose one-time
    // keys may no longer match our freshly-created local Rust crypto store.
    const requestedDeviceId = createMatrixLoginDeviceId();
    const loginResponse = await this.performMatrixLogin(homeserverUrl, botUserId, password, deviceName, requestedDeviceId);

    await this.clearMatrixState();

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
    await this.clearMatrixState();
  }

  private async performMatrixLogin(
    homeserverUrl: string,
    userId: string,
    password: string,
    deviceName: string,
    deviceId: string,
  ): Promise<{ userId: string; deviceId: string; accessToken: string }> {
    const loginUrl = new URL("/_matrix/client/v3/login", homeserverUrl);
    const response = await fetch(loginUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(buildMatrixLoginRequestBody(userId, password, deviceName, deviceId)),
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
    return promptForPasswordHidden(matrixAdminMessages.passwordPrompt());
  }

  private async clearMatrixState(): Promise<void> {
    const matrixRoot = matrixStateRoot(this.configDirectory);
    await rm(matrixRoot, { recursive: true, force: true });
  }
}

export function buildMatrixLoginRequestBody(
  userId: string,
  password: string,
  deviceName: string,
  deviceId: string,
): Record<string, unknown> {
  return {
    type: "m.login.password",
    identifier: {
      type: "m.id.user",
      user: userId,
    },
    password,
    device_id: deviceId,
    initial_device_display_name: deviceName,
  };
}

export function createMatrixLoginDeviceId(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const suffix = randomBytes(8).toString("hex").toUpperCase();
  return `SANDY_${timestamp}_${suffix}`;
}

export async function promptForPasswordHidden(
  prompt: string,
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): Promise<string> {
  stdout.write(prompt);

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let password = "";
  return await new Promise<string>((resolve, reject) => {
    const onData = (char: string) => {
      switch (char) {
        case "\n":
        case "\r":
        case "\u0004": {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          const trimmed = password.trim();
          if (!trimmed) {
            reject(new Error(matrixAdminMessages.passwordRequired()));
          } else {
            resolve(trimmed);
          }
          break;
        }
        case "\u0003": {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          reject(new Error("Password input cancelled."));
          break;
        }
        case "\u007f": {
          if (password.length > 0) {
            password = password.slice(0, -1);
          }
          break;
        }
        default: {
          password += char;
          break;
        }
      }
    };

    stdin.on("data", onData);
  });
}
