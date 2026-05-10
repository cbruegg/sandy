import {test} from "bun:test";
import assert from "node:assert/strict";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {createDecipheriv} from "node:crypto";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {HostfsVolumeManager} from "./hostfs-volume-manager.js";

class FakeChildProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
}

const RCLONE_OBSCURE_KEY = Buffer.from([
  0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d,
  0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
  0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb,
  0xf4, 0xde, 0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38,
]);

function revealRclonePassword(value: string): string {
  const ciphertext = Buffer.from(value, "base64url");
  const iv = ciphertext.subarray(0, 16);
  const encrypted = ciphertext.subarray(16);
  const decipher = createDecipheriv("aes-256-ctr", RCLONE_OBSCURE_KEY, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

test("HostfsVolumeManager uses webdav-prefixed rclone backend options", async () => {
  const invocations: string[][] = [];
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    invocations.push([...args]);
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      child.emit("exit", 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const manager = new HostfsVolumeManager({
    webdavBaseUrl: "http://host.docker.internal:9876",
    spawnImpl,
  });

  const volumeName = await manager.createVolume("bundle-1", "secret-1");

  assert.equal(volumeName, "sandy-hostfs-bundle-1");
  const invocation = invocations[0];
  assert.ok(invocation);
  const passOption = invocation.find((part) => part.startsWith("webdav-pass="));
  assert.ok(passOption);
  assert.equal(revealRclonePassword(passOption.slice("webdav-pass=".length)), "secret-1");

  assert.deepEqual(invocation.slice(0, 4), ["volume", "create", "-d", "rclone"]);
  assert.ok(invocation.includes("type=webdav"));
  assert.ok(invocation.includes("webdav-url=http://host.docker.internal:9876/bundles/bundle-1"));
  assert.ok(invocation.includes("webdav-vendor=other"));
  assert.ok(invocation.includes("webdav-user=sandy"));
  assert.ok(invocation.includes("dir-cache-time=0s"));
  assert.ok(invocation.includes("poll-interval=0"));
  assert.deepEqual(invocation.slice(-1), [
    "sandy-hostfs-bundle-1",
  ]);
});
