type MatrixStartupErrorContext = {
  botUserId: string | null;
  botDeviceId: string | null;
  stateRoot: string;
};

const oneTimeKeyConflictPattern = /One time key [^ ]+ already exists\./;

export function describeMatrixStartupError(error: unknown, context: MatrixStartupErrorContext): Error {
  if (isMatrixOneTimeKeyConflict(error)) {
    const accountLabel = context.botUserId ?? "the configured Matrix account";
    const deviceLabel = context.botDeviceId ? ` device ${context.botDeviceId}` : "";
    return new Error(
      `Matrix encrypted startup failed for ${accountLabel}${deviceLabel}. `
      + "The configured access token is bound to an existing Matrix client session whose encryption state does not match Sandy's local store. "
      + "This usually means `channel.matrix.access_token` was copied from Element or another Matrix client. "
      + "Create a fresh dedicated Sandy login/device for the bot account, update `channel.matrix.access_token`, delete "
      + `${context.stateRoot}, and restart Sandy.`,
    );
  }

  return toError(error);
}

function isMatrixOneTimeKeyConflict(error: unknown): boolean {
  const message = extractErrorMessage(error);
  return oneTimeKeyConflictPattern.test(message);
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "error" in error && typeof error.error === "string") {
    return error.error;
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(extractErrorMessage(error));
}
