import {randomUUID} from "node:crypto";
import type {WebDAVBundleNamespace} from "./webdav-server.js";
import type {HostDirectoryAccessLevel} from "./path-policy.js";
import {canonicalizeHostPath, isAccessLevelSatisfiedOrBetter} from "./path-policy.js";
import {logger} from "../logger.js";
import type {BundleNamespaceRegistry} from "./bundle-namespace-registry.js";

type HostDirectoryGrant = {
  grantId: string;
  hostPath: string;
  level: HostDirectoryAccessLevel;
};

type HostfsBrokerOptions = {
  namespaceRegistry: BundleNamespaceRegistry;
  webdavBaseUrl: string;
};

export class HostfsBroker {
  private readonly bundleGrants = new Map<string, Map<string, HostDirectoryGrant>>(); // bundleId -> (canonicalPath -> grant)

  constructor(private readonly options: HostfsBrokerOptions) {}

  registerBundle(bundleId: string): void {
    this.options.namespaceRegistry.register(bundleId);
    this.bundleGrants.set(bundleId, new Map());
    logger.info("hostfs.bundle_registered", {bundleId});
  }

  revokeBundle(bundleId: string): void {
    this.options.namespaceRegistry.revoke(bundleId);
    this.bundleGrants.delete(bundleId);
    logger.info("hostfs.bundle_revoked", {bundleId});
  }

  async requestDirectoryAccess(
    bundleId: string,
    taskId: string,
    requestedPath: string,
    level: HostDirectoryAccessLevel,
  ): Promise<{ok: true; grantPath: string; grantId: string} | {ok: false; error: string}> {
    const canonicalResult = await canonicalizeHostPath(requestedPath);
    if (!canonicalResult.ok) {
      return {ok: false, error: canonicalResult.error};
    }

    const canonicalPath = canonicalResult.canonicalPath;

    const bundleGrantMap = this.bundleGrants.get(bundleId);
    if (bundleGrantMap) {
      const existing = bundleGrantMap.get(canonicalPath);
      if (existing && isAccessLevelSatisfiedOrBetter(level, existing.level)) {
        return {
          ok: true,
          grantPath: `/workspace/host/grants/${existing.grantId}`,
          grantId: existing.grantId,
        };
      }
    }

    const grantId = randomUUID();
    const grant: HostDirectoryGrant = {
      grantId,
      hostPath: canonicalPath,
      level,
    };

    this.ensureBundleGrantMap(bundleId).set(canonicalPath, grant);

    const namespace = this.options.namespaceRegistry.get(bundleId);
    if (namespace) {
      namespace.grants.set(grantId, grant);
    }

    logger.info("hostfs.directory_granted", {
      bundleId,
      taskId,
      grantId,
      hostPath: canonicalPath,
      level,
    });

    return {
      ok: true,
      grantPath: `/workspace/host/grants/${grantId}`,
      grantId,
    };
  }

  getBundleNamespace(bundleId: string): WebDAVBundleNamespace | null {
    return this.options.namespaceRegistry.get(bundleId);
  }

  getWebDAVUrlForBundle(bundleId: string): string {
    return `${this.options.webdavBaseUrl}/bundles/${bundleId}`;
  }

  private ensureBundleGrantMap(bundleId: string): Map<string, HostDirectoryGrant> {
    let map = this.bundleGrants.get(bundleId);
    if (!map) {
      map = new Map();
      this.bundleGrants.set(bundleId, map);
    }
    return map;
  }
}

export function createNoopHostfsBroker(): HostfsBroker {
  return {
    registerBundle: () => {},
    revokeBundle: () => {},
    requestDirectoryAccess: () => Promise.resolve({ ok: false, error: "Host directory access is not enabled." }),
    getBundleNamespace: () => null,
    getWebDAVUrlForBundle: () => "",
  } as unknown as HostfsBroker;
}
