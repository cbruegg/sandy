import {randomBytes} from "node:crypto";

type BundleCredentials = {
  bundleId: string;
  secret: string;
};

type ActiveBundleRecord = {
  credentials: BundleCredentials;
};

export class BundleRegistry {
  private readonly bundles = new Map<string, ActiveBundleRecord>();
  private readonly secrets = new Map<string, string>(); // secret -> bundleId

  createBundle(bundleId: string): BundleCredentials {
    const secret = randomBytes(32).toString("hex");
    const credentials: BundleCredentials = {bundleId, secret};
    this.bundles.set(bundleId, {credentials});
    this.secrets.set(secret, bundleId);
    return credentials;
  }

  getBundleIdBySecret(secret: string): string | null {
    return this.secrets.get(secret) ?? null;
  }

  getCredentials(bundleId: string): BundleCredentials | null {
    return this.bundles.get(bundleId)?.credentials ?? null;
  }

  revokeBundle(bundleId: string): void {
    const record = this.bundles.get(bundleId);
    if (record) {
      this.secrets.delete(record.credentials.secret);
      this.bundles.delete(bundleId);
    }
  }

  listActiveBundleIds(): string[] {
    return Array.from(this.bundles.keys());
  }
}
