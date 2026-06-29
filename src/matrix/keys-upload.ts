export function stripMatrixOneTimeKeys(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  // Keep device keys and fallback keys, but drop ordinary one-time keys. This
  // is only used as a retry payload after the homeserver reports that a one-time
  // key ID already exists for this device.
  const sanitized = { ...payload };
  delete sanitized["one_time_keys"];
  return sanitized;
}

export function hasMatrixOneTimeKeys(payload: Record<string, unknown>): boolean {
  return "one_time_keys" in payload;
}

export function isMatrixDuplicateOneTimeKeyError(error: unknown): boolean {
  // matrix.org currently reports duplicate one-time-key uploads as M_UNKNOWN
  // with the useful detail only in the human-readable error text.
  const message = extractMatrixErrorText(error);
  return /one time key .* already exists/i.test(message);
}

function extractMatrixErrorText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (!error || typeof error !== "object") {
    return "";
  }

  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
  }

  const record = error as Record<string, unknown>;
  appendMatrixErrorBody(parts, record["body"]);
  appendMatrixErrorBody(parts, record["data"]);
  appendMatrixErrorBody(parts, record["response"]);
  appendMatrixErrorBody(parts, record);

  return parts.join("\n");
}

function appendMatrixErrorBody(parts: string[], value: unknown): void {
  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  if (typeof record["error"] === "string") {
    parts.push(record["error"]);
  }
  if (typeof record["errcode"] === "string") {
    parts.push(record["errcode"]);
  }
}
