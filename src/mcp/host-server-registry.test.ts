import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildStdioEnvironment } from "./host-server-registry.js";

test("buildStdioEnvironment keeps a minimal base environment", () => {
  const originalPath = process.env["PATH"];
  const originalHome = process.env["HOME"];
  const originalTmpdir = process.env["TMPDIR"];
  const originalTmp = process.env["TMP"];
  const originalTemp = process.env["TEMP"];

  try {
    process.env["PATH"] = "/usr/local/bin";
    process.env["HOME"] = "/home/sandy";
    delete process.env["TMPDIR"];
    delete process.env["TMP"];
    delete process.env["TEMP"];

    assert.deepEqual(buildStdioEnvironment({
      SPOTIFY_CLIENT_ID: "client-id",
    }), {
      HOME: "/home/sandy",
      PATH: "/usr/local/bin",
      SPOTIFY_CLIENT_ID: "client-id",
    });
  } finally {
    if (originalPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = originalPath;
    }
    if (originalHome === undefined) {
      delete process.env["HOME"];
    } else {
      process.env["HOME"] = originalHome;
    }
    if (originalTmpdir === undefined) {
      delete process.env["TMPDIR"];
    } else {
      process.env["TMPDIR"] = originalTmpdir;
    }
    if (originalTmp === undefined) {
      delete process.env["TMP"];
    } else {
      process.env["TMP"] = originalTmp;
    }
    if (originalTemp === undefined) {
      delete process.env["TEMP"];
    } else {
      process.env["TEMP"] = originalTemp;
    }
  }
});
