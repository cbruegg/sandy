import {test} from "bun:test";
import assert from "node:assert/strict";
import {HostfsBroker} from "./hostfs-broker.js";
import {BundleNamespaceRegistry} from "./bundle-namespace-registry.js";

function createBroker(): HostfsBroker {
  return new HostfsBroker({
    namespaceRegistry: new BundleNamespaceRegistry(),
    webdavBaseUrl: "http://localhost:9876",
  });
}

test("HostfsBroker registers and revokes bundles", () => {
  const broker = createBroker();

  broker.registerBundle("bundle-1");
  const ns = broker.getBundleNamespace("bundle-1");
  assert.ok(ns);
  assert.equal(ns?.bundleId, "bundle-1");

  broker.revokeBundle("bundle-1");
  assert.equal(broker.getBundleNamespace("bundle-1"), null);
});

test("HostfsBroker grants directory access and returns grant path", async () => {
  const broker = createBroker();

  broker.registerBundle("bundle-1");
  const result = await broker.requestDirectoryAccess(
    "bundle-1",
    "task-1",
    import.meta.dirname,
    "read_only",
  );

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.grantPath.startsWith("/workspace/host/grants/"));
    assert.ok(result.grantId.length > 0);
  }
});

test("HostfsBroker reuses existing grant for same path and level within a bundle", async () => {
  const broker = createBroker();

  broker.registerBundle("bundle-1");
  const result1 = await broker.requestDirectoryAccess(
    "bundle-1",
    "task-1",
    import.meta.dirname,
    "read_only",
  );
  const result2 = await broker.requestDirectoryAccess(
    "bundle-1",
    "task-2",
    import.meta.dirname,
    "read_only",
  );

  assert.equal(result1.ok, true);
  assert.equal(result2.ok, true);
  if (result1.ok && result2.ok) {
    assert.equal(result1.grantId, result2.grantId);
  }
});

test("HostfsBroker rejects invalid paths", async () => {
  const broker = createBroker();

  broker.registerBundle("bundle-1");
  const result = await broker.requestDirectoryAccess(
    "bundle-1",
    "task-1",
    "/nonexistent/path/that/does/not/exist",
    "read_only",
  );

  assert.equal(result.ok, false);
});

test("HostfsBroker scopes grants per bundle", async () => {
  const broker = createBroker();

  broker.registerBundle("bundle-1");
  broker.registerBundle("bundle-2");

  const result1 = await broker.requestDirectoryAccess("bundle-1", "task-1", import.meta.dirname, "read_only");
  const result2 = await broker.requestDirectoryAccess("bundle-2", "task-1", import.meta.dirname, "read_only");

  assert.equal(result1.ok, true);
  assert.equal(result2.ok, true);
  if (result1.ok && result2.ok) {
    assert.notEqual(result1.grantId, result2.grantId);
  }
});

test("HostfsBroker revokeBundle clears bundle grants", async () => {
  const broker = createBroker();

  broker.registerBundle("bundle-1");
  await broker.requestDirectoryAccess("bundle-1", "task-1", import.meta.dirname, "read_only");

  assert.notEqual(broker.getBundleNamespace("bundle-1"), null);

  broker.revokeBundle("bundle-1");

  assert.equal(broker.getBundleNamespace("bundle-1"), null);
  // After revoke, requesting access with the same bundle id (re-registered) creates a new grant
  broker.registerBundle("bundle-1");
  const result = await broker.requestDirectoryAccess("bundle-1", "task-2", import.meta.dirname, "read_only");
  assert.equal(result.ok, true);
});
