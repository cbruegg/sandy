import {
  loadMatrixAuthState,
  validateMatrixAuthStateForConfig,
} from "./auth-state.js";
import { matrixAdminMessages } from "../messages-to-user.js";
import type { SandyConfig } from "../config.js";

export async function validateMatrixAuthStateForStartup(
  configDirectory: string,
  channelConfig: SandyConfig["channel"],
): Promise<void> {
  if (channelConfig.kind !== "matrix") {
    return;
  }

  const { homeserverUrl, botUserId } = channelConfig.matrix;
  const state = await loadMatrixAuthState(configDirectory);
  const validation = validateMatrixAuthStateForConfig(state, {
    homeserverUrl,
    botUserId,
  });

  if (!validation.valid) {
    throw new Error(
      matrixAdminMessages.authStateInvalid(validation.reason ?? matrixAdminMessages.authStateMissing()),
    );
  }
}

export async function resolveMatrixAccessToken(
  configDirectory: string,
  channelConfig: SandyConfig["channel"],
): Promise<string> {
  if (channelConfig.kind !== "matrix") {
    throw new Error("Cannot resolve Matrix access token when channel is not matrix.");
  }

  const state = await loadMatrixAuthState(configDirectory);
  const { homeserverUrl, botUserId } = channelConfig.matrix;
  const validation = validateMatrixAuthStateForConfig(state, {
    homeserverUrl,
    botUserId,
  });

  if (!validation.valid || !state) {
    throw new Error(
      matrixAdminMessages.authStateInvalid(validation.reason ?? matrixAdminMessages.authStateMissing()),
    );
  }

  return state.accessToken;
}
