export function normalizeTelegramUsername(username: string | undefined): string | null {
  if (typeof username !== "string") {
    return null;
  }

  const trimmed = username.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.startsWith("@") ? trimmed.slice(1).toLowerCase() : trimmed.toLowerCase();
}
