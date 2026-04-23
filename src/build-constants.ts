import { readFileSync } from "node:fs";

declare const SANDY_BUILD_GIT_REVISION: string | undefined;
declare const SANDY_BUILD_IMAGE_REGISTRY: string | undefined;
declare const SANDY_BUILD_GITHUB_REPOSITORY: string | undefined;
declare const SANDY_BUILD_UPDATE_RELEASE_TAG: string | undefined;
declare const SANDY_CODEX_VERSION: string | undefined;

function resolveManagedCodexVersionFromSdkDependency(): string {
  const sdkPackageJson = JSON.parse(
    readFileSync(new URL("../node_modules/@openai/codex-sdk/package.json", import.meta.url), "utf8"),
  ) as {
    dependencies?: Record<string, unknown>;
  };
  const codexVersion = sdkPackageJson.dependencies?.["@openai/codex"];

  if (typeof codexVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(codexVersion)) {
    throw new Error(`Unable to determine exact @openai/codex version from @openai/codex-sdk: ${String(codexVersion)}`);
  }

  return codexVersion;
}

export const embeddedBuildMetadata = {
  // Bun leaves these identifiers undeclared when no --define is provided, so direct reads can throw.
  gitRevision: typeof SANDY_BUILD_GIT_REVISION === "undefined" ? undefined : SANDY_BUILD_GIT_REVISION,
  imageRegistry: typeof SANDY_BUILD_IMAGE_REGISTRY === "undefined" ? undefined : SANDY_BUILD_IMAGE_REGISTRY,
  githubRepository: typeof SANDY_BUILD_GITHUB_REPOSITORY === "undefined" ? undefined : SANDY_BUILD_GITHUB_REPOSITORY,
  updateReleaseTag: typeof SANDY_BUILD_UPDATE_RELEASE_TAG === "undefined" ? undefined : SANDY_BUILD_UPDATE_RELEASE_TAG,
} as const;

// The same undeclared-identifier rule applies here when SANDY_CODEX_VERSION is not injected.
export const embeddedCodexVersion = typeof SANDY_CODEX_VERSION === "undefined"
  ? resolveManagedCodexVersionFromSdkDependency()
  : SANDY_CODEX_VERSION;
