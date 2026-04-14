const GITHUB_USER_AGENT = "Sandy";

export function buildGitHubHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return {
    "user-agent": GITHUB_USER_AGENT,
    ...headers,
  };
}

export function isGitHubUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "api.github.com" || parsed.hostname === "github.com";
  } catch {
    return false;
  }
}
