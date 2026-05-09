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

test("HostfsBroker reuses existing grant for same path and level", async () => {
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
    "task-1",
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

test("HostfsBroker lists grants for task", async () => {
  const broker = createBroker();

  broker.registerBundle("bundle-1");
  await broker.requestDirectoryAccess("bundle-1", "task-1", import.meta.dirname, "read_only");

  const grants = broker.listGrantsForTask("task-1");
  assert.equal(grants.length, 1);
  const firstGrant = grants[0];
  assert.ok(firstGrant);
  assert.equal(firstGrant.level, "read_only");
});

test("HostfsBroker releaseTask removes task grants", async () => {
  const broker = createBroker();

  broker.registerBundle("bundle-1");
  await broker.requestDirectoryAccess("bundle-1", "task-1", import.meta.dirname, "read_only");

  assert.equal(broker.listGrantsForTask("task-1").length, 1);
  broker.releaseTask("task-1");
  assert.equal(broker.listGrantsForTask("task-1").length, 0);
});
