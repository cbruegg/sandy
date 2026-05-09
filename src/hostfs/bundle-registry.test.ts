import {test} from "bun:test";
import assert from "node:assert/strict";
import {BundleRegistry} from "./bundle-registry.js";

test("BundleRegistry creates unique credentials per bundle", () => {
  const registry = new BundleRegistry();
  const creds1 = registry.createBundle("bundle-1");
  const creds2 = registry.createBundle("bundle-2");

  assert.equal(creds1.bundleId, "bundle-1");
  assert.equal(creds2.bundleId, "bundle-2");
  assert.notEqual(creds1.secret, creds2.secret);
  assert.ok(creds1.secret.length > 0);
  assert.ok(creds2.secret.length > 0);
});

test("BundleRegistry looks up bundle by secret", () => {
  const registry = new BundleRegistry();
  const creds = registry.createBundle("bundle-1");

  assert.equal(registry.getBundleIdBySecret(creds.secret), "bundle-1");
  assert.equal(registry.getBundleIdBySecret("wrong-secret"), null);
});

test("BundleRegistry assigns and retrieves task IDs", () => {
  const registry = new BundleRegistry();
  registry.createBundle("bundle-1");
  registry.assignTask("bundle-1", "task-1");

  assert.equal(registry.getTaskId("bundle-1"), "task-1");
  assert.equal(registry.getBundleIdForTask("task-1"), "bundle-1");
});

test("BundleRegistry tracks hostfs availability for tasks", () => {
  const registry = new BundleRegistry();
  registry.createBundle("bundle-1");
  registry.assignTask("bundle-1", "task-1");

  assert.equal(registry.taskHasHostfsVolume("task-1"), false);

  registry.setHostfsVolumeAvailability("bundle-1", true);

  assert.equal(registry.taskHasHostfsVolume("task-1"), true);
});

test("BundleRegistry revoke removes bundle", () => {
  const registry = new BundleRegistry();
  const creds = registry.createBundle("bundle-1");
  registry.revokeBundle("bundle-1");

  assert.equal(registry.getBundleIdBySecret(creds.secret), null);
  assert.equal(registry.getCredentials("bundle-1"), null);
});

test("BundleRegistry lists active bundle IDs", () => {
  const registry = new BundleRegistry();
  registry.createBundle("bundle-1");
  registry.createBundle("bundle-2");

  const ids = registry.listActiveBundleIds();
  assert.equal(ids.length, 2);
  assert.ok(ids.includes("bundle-1"));
  assert.ok(ids.includes("bundle-2"));
});
