const BASE_ENV_KEYS = ["HOME", "PATH", "TMPDIR", "TMP", "TEMP"] as const;

export function buildStdioEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value) {
      environment[key] = value;
    }
  }

  if (!environment["PATH"]) {
    environment["PATH"] = "/usr/bin:/bin";
  }
  if (!environment["HOME"] && process.env["HOME"]) {
    environment["HOME"] = process.env["HOME"];
  }

  return {
    ...environment,
    ...overrides,
  };
}
