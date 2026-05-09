import {randomUUID} from "node:crypto";
import type {WebDAVBundleNamespace} from "./webdav-server.js";
import type {HostDirectoryAccessLevel} from "./path-policy.js";
import {canonicalizeHostPath, isAccessLevelSatisfiedOrBetter} from "./path-policy.js";
import {logger} from "../logger.js";
import type {BundleNamespaceRegistry} from "./bundle-namespace-registry.js";
import {hostGrantsPrefix} from "../paths.js";

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
  constructor(private readonly options: HostfsBrokerOptions) {}

  registerBundle(bundleId: string): void {
    this.options.namespaceRegistry.register(bundleId);
    logger.info("hostfs.bundle_registered", {bundleId});
  }

  revokeBundle(bundleId: string): void {
    this.options.namespaceRegistry.revoke(bundleId);
    logger.info("hostfs.bundle_revoked", {bundleId});
  }

  /**
   * Grant a task-scoped bundle access to a host directory at the given level.
   * Reuses an existing grant for the same canonical path when the level is
   * sufficient. Returns the grant path that the worker will see as
   * /workspace/host/grants/<grantId>.
   *
   * Returns `{ok: false}` when the requested path does not exist, is not a
   * directory, is relative, or when the bundle is not registered.
   */
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

    const namespace = this.options.namespaceRegistry.get(bundleId);
    if (!namespace) {
      return {ok: false, error: `Bundle namespace not found: ${bundleId}`};
    }

    const canonicalPath = canonicalResult.canonicalPath;

    for (const existing of namespace.grants.values()) {
      if (existing.hostPath === canonicalPath) {
        if (existing && isAccessLevelSatisfiedOrBetter(level, existing.level)) {
          return {
            ok: true,
            grantPath: `${hostGrantsPrefix}/${existing.grantId}`,
            grantId: existing.grantId,
          };
        }
      }
    }

    const grantId = randomUUID();
    const grant: HostDirectoryGrant = {
      grantId,
      hostPath: canonicalPath,
      level,
    };

    namespace.grants.set(grantId, grant);

    logger.info("hostfs.directory_granted", {
      bundleId,
      taskId,
      grantId,
      hostPath: canonicalPath,
      level,
    });

    return {
      ok: true,
      grantPath: `${hostGrantsPrefix}/${grantId}`,
      grantId,
    };
  }

  getBundleNamespace(bundleId: string): WebDAVBundleNamespace | null {
    return this.options.namespaceRegistry.get(bundleId);
  }
}

export function createNoopHostfsBroker(): HostfsBroker {
  return {
    registerBundle: () => {},
    revokeBundle: () => {},
    requestDirectoryAccess: () => Promise.resolve({ ok: false, error: "Host directory access is not enabled." }),
    getBundleNamespace: () => null,
  } as unknown as HostfsBroker;
}
