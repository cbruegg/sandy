import type {WebDAVBundleNamespace} from "./webdav-server.js";

export class BundleNamespaceRegistry {
  private readonly namespaces = new Map<string, WebDAVBundleNamespace>();

  register(bundleId: string): WebDAVBundleNamespace {
    const existing = this.namespaces.get(bundleId);
    if (existing) {
      return existing;
    }
    const ns: WebDAVBundleNamespace = {
      bundleId,
      grants: new Map(),
    };
    this.namespaces.set(bundleId, ns);
    return ns;
  }

  revoke(bundleId: string): void {
    this.namespaces.delete(bundleId);
  }

  get(bundleId: string): WebDAVBundleNamespace | null {
    return this.namespaces.get(bundleId) ?? null;
  }
}
