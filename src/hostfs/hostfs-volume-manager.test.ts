import {test} from "bun:test";
import assert from "node:assert/strict";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {HostfsVolumeManager} from "./hostfs-volume-manager.js";

class FakeChildProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
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
  assert.deepEqual(invocations[0], [
    "volume",
    "create",
    "-d",
    "rclone",
    "-o",
    "type=webdav",
    "-o",
    "webdav-url=http://host.docker.internal:9876/bundles/bundle-1",
    "-o",
    "webdav-vendor=other",
    "-o",
    "webdav-user=sandy",
    "-o",
    "webdav-pass=secret-1",
    "sandy-hostfs-bundle-1",
  ]);
});
