import {test} from "bun:test";
import assert from "node:assert/strict";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {initializeHostfs} from "./index.js";
import {RclonePluginManager} from "./rclone-plugin-manager.js";

class FakeChildProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
}

test("initializeHostfs stops WebDAV when rclone setup fails", async () => {
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    const child = new FakeChildProcess();

    queueMicrotask(() => {
      if (args[0] === "run") {
        child.emit("exit", 0, null);
        return;
      }

      child.stderr.write("unrecoverable plugin setup failure");
      child.emit("exit", 1, null);
    });

    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  await assert.rejects(
    initializeHostfs({
      webdavHost: "127.0.0.1",
      webdavDockerHost: "127.0.0.1",
      rclonePluginManager: new RclonePluginManager({spawnImpl}),
    }),
    /unrecoverable plugin setup failure/,
  );
});
