import {test} from "bun:test";
import assert from "node:assert/strict";
import {canonicalizeHostPath, isAccessLevelSatisfiedOrBetter} from "./path-policy.js";

test("canonicalizeHostPath rejects non-absolute paths", async () => {
  const result = await canonicalizeHostPath("relative/path");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.includes("must be absolute"));
  }
});

test("canonicalizeHostPath rejects non-directory paths", async () => {
  const result = await canonicalizeHostPath(import.meta.filename);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.error.includes("not a directory"));
  }
});

test("canonicalizeHostPath accepts existing directories", async () => {
  const result = await canonicalizeHostPath(import.meta.dirname);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.canonicalPath.length > 0);
  }
});

test("canonicalizeHostPath expands tilde", async () => {
  const result = await canonicalizeHostPath("~");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(result.canonicalPath.length > 0);
  }
});

test("isAccessLevelSatisfiedOrBetter: read_write satisfies read_only", () => {
  assert.equal(isAccessLevelSatisfiedOrBetter("read_only", "read_write"), true);
});

test("isAccessLevelSatisfiedOrBetter: read_only satisfies read_only", () => {
  assert.equal(isAccessLevelSatisfiedOrBetter("read_only", "read_only"), true);
});

test("isAccessLevelSatisfiedOrBetter: read_only does not satisfy read_write", () => {
  assert.equal(isAccessLevelSatisfiedOrBetter("read_write", "read_only"), false);
});

test("isAccessLevelSatisfiedOrBetter: read_write satisfies read_write", () => {
  assert.equal(isAccessLevelSatisfiedOrBetter("read_write", "read_write"), true);
});
