import {randomBytes} from "node:crypto";

type BundleCredentials = {
  bundleId: string;
  secret: string;
};

type ActiveBundleRecord = {
  credentials: BundleCredentials;
  taskId: string | null;
};

export class BundleRegistry {
  private readonly bundles = new Map<string, ActiveBundleRecord>();
  private readonly secrets = new Map<string, string>(); // secret -> bundleId

  createBundle(bundleId: string): BundleCredentials {
    const secret = randomBytes(32).toString("hex");
    const credentials: BundleCredentials = {bundleId, secret};
    this.bundles.set(bundleId, {
      credentials,
      taskId: null,
    });
    this.secrets.set(secret, bundleId);
    return credentials;
  }

  assignTask(bundleId: string, taskId: string | null): void {
    const record = this.bundles.get(bundleId);
    if (record) {
      record.taskId = taskId;
    }
  }

  getBundleIdBySecret(secret: string): string | null {
    return this.secrets.get(secret) ?? null;
  }

  getCredentials(bundleId: string): BundleCredentials | null {
    return this.bundles.get(bundleId)?.credentials ?? null;
  }

  getTaskId(bundleId: string): string | null {
    return this.bundles.get(bundleId)?.taskId ?? null;
  }

  getBundleIdForTask(taskId: string): string | null {
    for (const [bundleId, record] of this.bundles) {
      if (record.taskId === taskId) {
        return bundleId;
      }
    }
    return null;
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
