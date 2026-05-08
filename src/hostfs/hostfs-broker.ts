import {randomUUID} from "node:crypto";
import type {BundleRegistry} from "./bundle-registry.js";
import type {WebDAVBundleNamespace, WebDAVServer} from "./webdav-server.js";
import type {HostDirectoryAccessLevel} from "./path-policy.js";
import {canonicalizeHostPath, isAccessLevelSatisfiedOrBetter} from "./path-policy.js";
import {logger} from "../logger.js";

type HostDirectoryGrant = {
  grantId: string;
  hostPath: string;
  level: HostDirectoryAccessLevel;
};

type HostfsBrokerOptions = {
  bundleRegistry: BundleRegistry;
  webdavServer: WebDAVServer;
  webdavBaseUrl: string;
};

export class HostfsBroker {
  private readonly bundleNamespaces = new Map<string, WebDAVBundleNamespace>();
  private readonly taskGrants = new Map<string, Map<string, HostDirectoryGrant>>(); // taskId -> (canonicalPath -> grant)
  private readonly bundleGrants = new Map<string, Map<string, HostDirectoryGrant>>(); // bundleId -> (canonicalPath -> grant)

  constructor(private readonly options: HostfsBrokerOptions) {}

  registerBundle(bundleId: string): void {
    if (this.bundleNamespaces.has(bundleId)) {
      return;
    }
    const namespace: WebDAVBundleNamespace = {
      bundleId,
      grants: new Map(),
    };
    this.bundleNamespaces.set(bundleId, namespace);
    this.bundleGrants.set(bundleId, new Map());
    logger.info("hostfs.bundle_registered", {bundleId});
  }

  revokeBundle(bundleId: string): void {
    this.bundleNamespaces.delete(bundleId);
    this.bundleGrants.delete(bundleId);
    // Clean up task grants for tasks using this bundle
    for (const [taskId, taskBundleId] of this.getTaskBundleMappings()) {
      if (taskBundleId === bundleId) {
        this.taskGrants.delete(taskId);
      }
    }
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

    // Check if this task already has a grant for this path at sufficient level
    const taskGrantMap = this.taskGrants.get(taskId);
    if (taskGrantMap) {
      const existing = taskGrantMap.get(canonicalPath);
      if (existing && isAccessLevelSatisfiedOrBetter(level, existing.level)) {
        return {
          ok: true,
          grantPath: `/workspace/host/grants/${existing.grantId}`,
          grantId: existing.grantId,
        };
      }
    }

    // Check if this bundle already has a grant for this path at sufficient level
    const bundleGrantMap = this.bundleGrants.get(bundleId);
    if (bundleGrantMap) {
      const existing = bundleGrantMap.get(canonicalPath);
      if (existing && isAccessLevelSatisfiedOrBetter(level, existing.level)) {
        // Reuse the existing grant for this task too
        this.ensureTaskGrantMap(taskId).set(canonicalPath, existing);
        return {
          ok: true,
          grantPath: `/workspace/host/grants/${existing.grantId}`,
          grantId: existing.grantId,
        };
      }
    }

    // Create a new grant
    const grantId = randomUUID();
    const grant: HostDirectoryGrant = {
      grantId,
      hostPath: canonicalPath,
      level,
    };

    this.ensureTaskGrantMap(taskId).set(canonicalPath, grant);
    this.ensureBundleGrantMap(bundleId).set(canonicalPath, grant);

    const namespace = this.bundleNamespaces.get(bundleId);
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
    return this.bundleNamespaces.get(bundleId) ?? null;
  }

  getGrantForTask(taskId: string, canonicalPath: string): HostDirectoryGrant | null {
    return this.taskGrants.get(taskId)?.get(canonicalPath) ?? null;
  }

  listGrantsForTask(taskId: string): HostDirectoryGrant[] {
    const map = this.taskGrants.get(taskId);
    if (!map) {
      return [];
    }
    return Array.from(map.values());
  }

  getWebDAVUrlForBundle(bundleId: string): string {
    return `${this.options.webdavBaseUrl}/bundles/${bundleId}`;
  }

  private ensureTaskGrantMap(taskId: string): Map<string, HostDirectoryGrant> {
    let map = this.taskGrants.get(taskId);
    if (!map) {
      map = new Map();
      this.taskGrants.set(taskId, map);
    }
    return map;
  }

  private ensureBundleGrantMap(bundleId: string): Map<string, HostDirectoryGrant> {
    let map = this.bundleGrants.get(bundleId);
    if (!map) {
      map = new Map();
      this.bundleGrants.set(bundleId, map);
    }
    return map;
  }

  private getTaskBundleMappings(): [string, string][] {
    const result: [string, string][] = [];
    for (const taskId of this.taskGrants.keys()) {
      for (const bundleId of this.bundleGrants.keys()) {
        // We need to track this differently. For now, let the caller handle it.
        // The bundle registry has taskId -> bundleId mapping.
        const registryTaskId = this.options.bundleRegistry.getTaskId(bundleId);
        if (registryTaskId === taskId) {
          result.push([taskId, bundleId]);
        }
      }
    }
    return result;
  }
}
