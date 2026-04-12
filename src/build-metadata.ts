import { embeddedBuildMetadata } from "./build-metadata.generated.js";

const LOCAL_DEFAULT_WORKER_IMAGE = "sandy-subagent:latest";
const LOCAL_DEFAULT_SIDECAR_IMAGE = "sandy-mcp-proxy:latest";

export type SandyBuildMetadata = {
  gitRevision?: string;
  imageRegistry?: string;
};

export type SandyImageDefaults = {
  workerImage: string;
  sidecarImage: string;
};

function normalizeBuildString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function toPublishedImageTag(gitRevision: string): string {
  return gitRevision.startsWith("sha-") ? gitRevision : `sha-${gitRevision}`;
}

export function resolveDefaultImageReferences(buildMetadata: SandyBuildMetadata = embeddedBuildMetadata): SandyImageDefaults {
  const gitRevision = normalizeBuildString(buildMetadata.gitRevision);
  const imageRegistry = normalizeBuildString(buildMetadata.imageRegistry);

  if (!gitRevision || !imageRegistry) {
    return {
      workerImage: LOCAL_DEFAULT_WORKER_IMAGE,
      sidecarImage: LOCAL_DEFAULT_SIDECAR_IMAGE,
    };
  }

  const imageTag = toPublishedImageTag(gitRevision);
  return {
    workerImage: `${imageRegistry}/sandy-subagent:${imageTag}`,
    sidecarImage: `${imageRegistry}/sandy-mcp-proxy:${imageTag}`,
  };
}
