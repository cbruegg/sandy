import {test} from "bun:test";
import assert from "node:assert/strict";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {RclonePluginManager} from "./rclone-plugin-manager.js";

class FakeChildProcess extends EventEmitter {
  public readonly stdin = new PassThrough();
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
}

test("RclonePluginManager prepares plugin directories before installing the plugin", async () => {
  const invocations: string[][] = [];
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    invocations.push([...args]);
    const child = new FakeChildProcess();

    queueMicrotask(() => {
      if (args[0] === "plugin" && args[1] === "ls" && args[3] === "{{.Name}}") {
        child.stdout.write("");
      }
      child.emit("exit", 0, null);
    });

    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const manager = new RclonePluginManager({spawnImpl, hostArch: "x64"});
  await manager.ensureInstalled();

  assert.deepEqual(invocations[0], [
    "run",
    "--rm",
    "-v",
    "/var/lib/docker-plugins/rclone/config:/var/lib/docker-plugins/rclone/config",
    "-v",
    "/var/lib/docker-plugins/rclone/cache:/var/lib/docker-plugins/rclone/cache",
    "alpine:latest",
    "mkdir",
    "-p",
    "/var/lib/docker-plugins/rclone/config",
    "/var/lib/docker-plugins/rclone/cache",
  ]);
  assert.deepEqual(invocations[1], ["plugin", "ls", "--format", "{{.Name}}"]);
  assert.deepEqual(invocations[2], [
    "plugin",
    "install",
    "--grant-all-permissions",
    "--alias",
    "rclone",
    "rclone/docker-volume-rclone:amd64",
    "config=/var/lib/docker-plugins/rclone/config",
    "cache=/var/lib/docker-plugins/rclone/cache",
  ]);
});

test("RclonePluginManager uses the arm64 rclone plugin image on arm64 hosts", async () => {
  const invocations: string[][] = [];
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    invocations.push([...args]);
    const child = new FakeChildProcess();

    queueMicrotask(() => {
      if (args[0] === "plugin" && args[1] === "ls" && args[3] === "{{.Name}}") {
        child.stdout.write("");
      }
      child.emit("exit", 0, null);
    });

    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const manager = new RclonePluginManager({spawnImpl, hostArch: "arm64"});
  await manager.ensureInstalled();

  assert.ok(invocations.some((invocation) => invocation.includes("rclone/docker-volume-rclone:arm64")));
});

test("RclonePluginManager uses the arm-v7 rclone plugin image on arm hosts", async () => {
  const invocations: string[][] = [];
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    invocations.push([...args]);
    const child = new FakeChildProcess();

    queueMicrotask(() => {
      if (args[0] === "plugin" && args[1] === "ls" && args[3] === "{{.Name}}") {
        child.stdout.write("");
      }
      child.emit("exit", 0, null);
    });

    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const manager = new RclonePluginManager({spawnImpl, hostArch: "arm"});
  await manager.ensureInstalled();

  assert.ok(invocations.some((invocation) => invocation.includes("rclone/docker-volume-rclone:arm-v7")));
});

test("RclonePluginManager enables an installed disabled plugin after preparing directories", async () => {
  const invocations: string[][] = [];
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    invocations.push([...args]);
    const child = new FakeChildProcess();

    queueMicrotask(() => {
      if (args[0] === "plugin" && args[1] === "ls" && args[3] === "{{.Name}}") {
        child.stdout.write("rclone\n");
      }
      if (args[0] === "plugin" && args[1] === "ls" && args[3] === "{{.Name}}:{{.Enabled}}") {
        child.stdout.write("rclone:false\n");
      }
      child.emit("exit", 0, null);
    });

    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const manager = new RclonePluginManager({spawnImpl});
  await manager.ensureInstalled();

  assert.deepEqual(invocations[0], [
    "run",
    "--rm",
    "-v",
    "/var/lib/docker-plugins/rclone/config:/var/lib/docker-plugins/rclone/config",
    "-v",
    "/var/lib/docker-plugins/rclone/cache:/var/lib/docker-plugins/rclone/cache",
    "alpine:latest",
    "mkdir",
    "-p",
    "/var/lib/docker-plugins/rclone/config",
    "/var/lib/docker-plugins/rclone/cache",
  ]);
  assert.deepEqual(invocations[1], ["plugin", "ls", "--format", "{{.Name}}"]);
  assert.deepEqual(invocations[2], ["plugin", "ls", "--format", "{{.Name}}:{{.Enabled}}"]);
  assert.deepEqual(invocations[3], ["plugin", "enable", "rclone"]);
});

test("RclonePluginManager treats rclone:latest as an installed plugin name", async () => {
  const invocations: string[][] = [];
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    invocations.push([...args]);
    const child = new FakeChildProcess();

    queueMicrotask(() => {
      if (args[0] === "plugin" && args[1] === "ls" && args[3] === "{{.Name}}") {
        child.stdout.write("rclone:latest\n");
      }
      if (args[0] === "plugin" && args[1] === "ls" && args[3] === "{{.Name}}:{{.Enabled}}") {
        child.stdout.write("rclone:latest:true\n");
      }
      child.emit("exit", 0, null);
    });

    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const manager = new RclonePluginManager({spawnImpl, enableRecovery: true});
  await manager.ensureInstalled();

  assert.deepEqual(invocations[1], ["plugin", "ls", "--format", "{{.Name}}"]);
  assert.deepEqual(invocations[2], ["plugin", "ls", "--format", "{{.Name}}:{{.Enabled}}"]);
  assert.equal(invocations.some((invocation) => invocation[0] === "plugin" && invocation[1] === "install"), false);
  assert.equal(invocations.some((invocation) => invocation[0] === "plugin" && invocation[1] === "enable"), false);
});

test("RclonePluginManager recovers when install reports plugin already exists", async () => {
  const invocations: string[][] = [];
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    invocations.push([...args]);
    const child = new FakeChildProcess();

    queueMicrotask(() => {
      if (args[0] === "plugin" && args[1] === "ls" && args[3] === "{{.Name}}") {
        child.stdout.write("");
        child.emit("exit", 0, null);
        return;
      }
      if (args[0] === "plugin" && args[1] === "install") {
        child.stderr.write("Error response from daemon: plugin rclone:latest already exists");
        child.emit("exit", 1, null);
        return;
      }
      if (args[0] === "plugin" && args[1] === "ls" && args[3] === "{{.Name}}:{{.Enabled}}") {
        child.stdout.write("rclone:latest:false\n");
        child.emit("exit", 0, null);
        return;
      }
      child.emit("exit", 0, null);
    });

    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const manager = new RclonePluginManager({spawnImpl});
  await manager.ensureInstalled();

  assert.ok(invocations.some((invocation) => invocation[0] === "plugin" && invocation[1] === "install"));
  assert.ok(invocations.some((invocation) => invocation[0] === "plugin" && invocation[1] === "enable" && invocation[2] === "rclone"));
});

test("RclonePluginManager clears plugin state and reinstalls after socket failure", async () => {
  const invocations: string[][] = [];
  let pluginListCallCount = 0;
  const spawnImpl = ((_command: string, args: readonly string[]) => {
    invocations.push([...args]);
    const child = new FakeChildProcess();

    queueMicrotask(() => {
      if (args[0] === "plugin" && args[1] === "ls" && args[3] === "{{.Name}}") {
        pluginListCallCount += 1;
        child.stdout.write(pluginListCallCount === 1 ? "rclone:latest\n" : "");
        child.emit("exit", 0, null);
        return;
      }
      if (args[0] === "plugin" && args[1] === "ls" && args[3] === "{{.Name}}:{{.Enabled}}") {
        child.stdout.write("rclone:latest:false\n");
        child.emit("exit", 0, null);
        return;
      }
      if (args[0] === "plugin" && args[1] === "enable") {
        child.stderr.write("Error response from daemon: dial unix /run/docker/plugins/test/rclone.sock: connect: no such file or directory");
        child.emit("exit", 1, null);
        return;
      }
      child.emit("exit", 0, null);
    });

    return child as unknown as ChildProcessWithoutNullStreams;
  }) as typeof import("node:child_process").spawn;

  const manager = new RclonePluginManager({spawnImpl, enableRecovery: true});
  await manager.ensureInstalled();

  assert.ok(invocations.some((invocation) => invocation[0] === "plugin" && invocation[1] === "disable" && invocation[2] === "-f" && invocation[3] === "rclone"));
  assert.ok(invocations.some((invocation) => invocation[0] === "run" && invocation.includes("rm") && invocation.includes("/var/lib/docker-plugins/rclone/cache/docker-plugin.state")));
  assert.ok(invocations.some((invocation) => invocation[0] === "plugin" && invocation[1] === "rm" && invocation[2] === "-f" && invocation[3] === "rclone"));
  assert.ok(invocations.some((invocation) => invocation[0] === "plugin" && invocation[1] === "install"));
});
