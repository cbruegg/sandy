import {test} from "bun:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile, stat} from "node:fs/promises";
import {basename, join} from "node:path";
import {tmpdir} from "node:os";
import {WebDAVServer} from "./webdav-server.js";
import {BundleNamespaceRegistry} from "./bundle-namespace-registry.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sandy-webdav-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

function createServer(
  grants: Map<string, {grantId: string; hostPath: string; level: "read_only" | "read_write"}>,
  authenticate?: (username: string, password: string) => string | null,
): WebDAVServer {
  const registry = new BundleNamespaceRegistry();
  registry.register("test-bundle");
  const ns = registry.get("test-bundle");
  if (ns) {
    for (const [grantId, grant] of grants) {
      ns.grants.set(grantId, grant);
    }
  }
  return new WebDAVServer({
    port: 0,
    host: "127.0.0.1",
    authenticate: authenticate ?? (() => "test-bundle"),
    namespaceRegistry: registry,
  });
}

test("WebDAVServer starts and stops", async () => {
  const server = createServer(new Map());
  const port = await server.start();
  assert.ok(port > 0);
  assert.equal(server.getPort(), port);
  await server.stop();
});

test("WebDAVServer responds to OPTIONS with write methods", async () => {
  await withTempDir(async () => {
    const server = createServer(new Map());
    await server.start();
    const port = server.getPort();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle`, {
        method: "OPTIONS",
        headers: {Authorization: "Basic dXNlcjpwYXNz"},
      });
      assert.equal(response.status, 200);
      const allow = response.headers.get("allow") ?? "";
      assert.ok(allow.includes("PUT"));
      assert.ok(allow.includes("DELETE"));
      assert.ok(allow.includes("MKCOL"));
      assert.ok(allow.includes("COPY"));
      assert.ok(allow.includes("MOVE"));
      assert.ok(allow.includes("PROPPATCH"));
    } finally {
      await server.stop();
    }
  });
});

test("WebDAVServer PROPFIND includes quota properties for a single grant namespace", async () => {
  await withTempDir(async (dir) => {
    const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
    const server = createServer(grants);
    await server.start();
    const port = server.getPort();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle`, {
        method: "PROPFIND",
        headers: {Authorization: "Basic dXNlcjpwYXNz", Depth: "0"},
      });
      assert.equal(response.status, 207);
      const body = await response.text();
      assert.match(body, /<D:quota-available-bytes>\d+<\/D:quota-available-bytes>/);
      assert.match(body, /<D:quota-used-bytes>\d+<\/D:quota-used-bytes>/);
    } finally {
      await server.stop();
    }
  });
});

test("WebDAVServer PUT creates a file", async () => {
  await withTempDir(async (dir) => {
    const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
    const server = createServer(grants);
    await server.start();
    const port = server.getPort();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/hello.txt`, {
        method: "PUT",
        headers: {Authorization: "Basic dXNlcjpwYXNz"},
        body: "hello world",
      });
      assert.equal(response.status, 201);
      const content = await readFile(join(dir, "hello.txt"), "utf8");
      assert.equal(content, "hello world");
    } finally {
      await server.stop();
    }
  });
});

test("WebDAVServer PUT overwrites existing file with 204", async () => {
  await withTempDir(async (dir) => {
    const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
    const server = createServer(grants);
    await server.start();
    const port = server.getPort();
    try {
      await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/hello.txt`, {
        method: "PUT",
        headers: {Authorization: "Basic dXNlcjpwYXNz"},
        body: "first",
      });
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/hello.txt`, {
        method: "PUT",
        headers: {Authorization: "Basic dXNlcjpwYXNz"},
        body: "second",
      });
      assert.equal(response.status, 204);
      const content = await readFile(join(dir, "hello.txt"), "utf8");
      assert.equal(content, "second");
    } finally {
      await server.stop();
    }
  });
});

test("WebDAVServer PUT on read-only grant returns 403", async () => {
  await withTempDir(async (dir) => {
    const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_only" as const}]]);
    const server = createServer(grants);
    await server.start();
    const port = server.getPort();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/hello.txt`, {
        method: "PUT",
        headers: {Authorization: "Basic dXNlcjpwYXNz"},
        body: "hello",
      });
      assert.equal(response.status, 403);
    } finally {
      await server.stop();
    }
  });
});

test("WebDAVServer DELETE removes a file", async () => {
  await withTempDir(async (dir) => {
    const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
    const server = createServer(grants);
    await server.start();
    const port = server.getPort();
    try {
      await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/hello.txt`, {
        method: "PUT",
        headers: {Authorization: "Basic dXNlcjpwYXNz"},
        body: "hello",
      });
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/hello.txt`, {
        method: "DELETE",
        headers: {Authorization: "Basic dXNlcjpwYXNz"},
      });
      assert.equal(response.status, 204);
      const stats = await statSafe(join(dir, "hello.txt"));
      assert.equal(stats, null);
    } finally {
      await server.stop();
    }
  });
});

test("WebDAVServer DELETE on read-only grant returns 403", async () => {
  await withTempDir(async (dir) => {
    const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_only" as const}]]);
    const server = createServer(grants);
    await server.start();
    const port = server.getPort();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/hello.txt`, {
        method: "DELETE",
        headers: {Authorization: "Basic dXNlcjpwYXNz"},
      });
      assert.equal(response.status, 403);
    } finally {
      await server.stop();
    }
  });
});

test("WebDAVServer DELETE on grant root returns 403", async () => {
  await withTempDir(async (dir) => {
    const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
    const server = createServer(grants);
    await server.start();
    const port = server.getPort();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/`, {
        method: "DELETE",
        headers: {Authorization: "Basic dXNlcjpwYXNz"},
      });
      assert.equal(response.status, 403);
    } finally {
      await server.stop();
    }
  });
});

test("WebDAVServer MKCOL creates a directory", async () => {
  await withTempDir(async (dir) => {
    const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
    const server = createServer(grants);
    await server.start();
    const port = server.getPort();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/newdir`, {
        method: "MKCOL",
        headers: {Authorization: "Basic dXNlcjpwYXNz"},
      });
      assert.equal(response.status, 201);
      const stats = await statSafe(join(dir, "newdir"));
      assert.ok(stats?.isDirectory());
    } finally {
      await server.stop();
    }
  });
});

test("WebDAVServer MKCOL on read-only grant returns 403", async () => {
  await withTempDir(async (dir) => {
    const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_only" as const}]]);
    const server = createServer(grants);
    await server.start();
    const port = server.getPort();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/newdir`, {
        method: "MKCOL",
        headers: {Authorization: "Basic dXNlcjpwYXNz"},
      });
      assert.equal(response.status, 403);
    } finally {
      await server.stop();
    }
  });
});

test("WebDAVServer COPY duplicates a file", async () => {
  await withTempDir(async (dir) => {
    const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
    const server = createServer(grants);
    await server.start();
    const port = server.getPort();
    try {
      await writeFile(join(dir, "source.txt"), "hello");
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/source.txt`, {
        method: "COPY",
        headers: {
          Authorization: "Basic dXNlcjpwYXNz",
          Destination: `http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/copied.txt`,
        },
      });
      assert.equal(response.status, 201);
      assert.equal(await readFile(join(dir, "copied.txt"), "utf8"), "hello");
      assert.equal(await readFile(join(dir, "source.txt"), "utf8"), "hello");
    } finally {
      await server.stop();
    }
  });
});

test("WebDAVServer COPY with overwrite false returns 412", async () => {
  await withTempDir(async (dir) => {
    const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
    const server = createServer(grants);
    await server.start();
    const port = server.getPort();
    try {
      await writeFile(join(dir, "source.txt"), "hello");
      await writeFile(join(dir, "copied.txt"), "existing");
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/source.txt`, {
        method: "COPY",
        headers: {
          Authorization: "Basic dXNlcjpwYXNz",
          Overwrite: "F",
          Destination: `http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/copied.txt`,
        },
      });
      assert.equal(response.status, 412);
      assert.equal(await readFile(join(dir, "copied.txt"), "utf8"), "existing");
    } finally {
      await server.stop();
    }
  });
});

test("WebDAVServer MOVE renames a file", async () => {
  await withTempDir(async (dir) => {
    const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
    const server = createServer(grants);
    await server.start();
    const port = server.getPort();
    try {
      await writeFile(join(dir, "source.txt"), "hello");
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/source.txt`, {
        method: "MOVE",
        headers: {
          Authorization: "Basic dXNlcjpwYXNz",
          Destination: `http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/moved.txt`,
        },
      });
      assert.equal(response.status, 201);
      assert.equal(await statSafe(join(dir, "source.txt")), null);
      assert.equal(await readFile(join(dir, "moved.txt"), "utf8"), "hello");
    } finally {
      await server.stop();
    }
  });
});

test("WebDAVServer MOVE with overwrite false returns 412", async () => {
  await withTempDir(async (dir) => {
    const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
    const server = createServer(grants);
    await server.start();
    const port = server.getPort();
    try {
      await writeFile(join(dir, "source.txt"), "hello");
      await writeFile(join(dir, "moved.txt"), "existing");
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/source.txt`, {
        method: "MOVE",
        headers: {
          Authorization: "Basic dXNlcjpwYXNz",
          Overwrite: "F",
          Destination: `http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/moved.txt`,
        },
      });
      assert.equal(response.status, 412);
      assert.equal(await readFile(join(dir, "source.txt"), "utf8"), "hello");
      assert.equal(await readFile(join(dir, "moved.txt"), "utf8"), "existing");
    } finally {
      await server.stop();
    }
  });
});

test("WebDAVServer PROPPATCH updates getlastmodified", async () => {
  await withTempDir(async (dir) => {
    const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
    const server = createServer(grants);
    await server.start();
    const port = server.getPort();
    const newTime = "Mon, 06 Jan 2025 12:34:56 GMT";
    try {
      await writeFile(join(dir, "hello.txt"), "hello");
      const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/hello.txt`, {
        method: "PROPPATCH",
        headers: {Authorization: "Basic dXNlcjpwYXNz", "Content-Type": "application/xml"},
        body: `<?xml version="1.0" encoding="utf-8"?>
<D:propertyupdate xmlns:D="DAV:">
  <D:set>
    <D:prop>
      <D:getlastmodified>${newTime}</D:getlastmodified>
    </D:prop>
  </D:set>
</D:propertyupdate>`,
      });
      assert.equal(response.status, 207);
      const body = await response.text();
      assert.match(body, /<D:getlastmodified\/>/);
      const updatedStats = await stat(join(dir, "hello.txt"));
      assert.equal(updatedStats.mtime.toUTCString(), new Date(newTime).toUTCString());
    } finally {
      await server.stop();
    }
  });
});

for (const method of ["OPTIONS", "GET", "HEAD", "PROPFIND", "PUT", "DELETE", "MKCOL", "COPY", "MOVE", "PROPPATCH"] as const) {
  test(`WebDAVServer ${method} without Authorization returns 401`, async () => {
    await withTempDir(async (dir) => {
      const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
      const server = createServer(grants);
      await server.start();
      const port = server.getPort();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/hello.txt`, {
          method,
        });
        assert.equal(response.status, 401);
        const wwwAuth = response.headers.get("www-authenticate");
        assert.ok(wwwAuth?.includes("Basic"));
      } finally {
        await server.stop();
      }
    });
  });
}

for (const method of ["OPTIONS", "GET", "HEAD", "PROPFIND", "PUT", "DELETE", "MKCOL", "COPY", "MOVE", "PROPPATCH"] as const) {
  test(`WebDAVServer ${method} with wrong token returns 401`, async () => {
    await withTempDir(async (dir) => {
      const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
      const server = createServer(grants, (_username, password) => {
        return password === "correct-secret" ? "test-bundle" : null;
      });
      await server.start();
      const port = server.getPort();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/hello.txt`, {
          method,
          headers: {Authorization: "Basic dXNlcjp3cm9uZy1zZWNyZXQ="},
        });
        assert.equal(response.status, 401);
      } finally {
        await server.stop();
      }
    });
  });
}

test("WebDAVServer GET with path traversal returns 404", async () => {
  await withTempDir(async (dir) => {
    const parentDir = await mkdtemp(join(tmpdir(), "sandy-webdav-parent-"));
    try {
      const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
      const server = createServer(grants);
      await server.start();
      const port = server.getPort();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/../../${basename(parentDir)}/secret.txt`, {
          method: "GET",
          headers: {Authorization: "Basic dXNlcjpwYXNz"},
        });
        assert.equal(response.status, 404);
      } finally {
        await server.stop();
      }
    } finally {
      await rm(parentDir, {recursive: true, force: true});
    }
  });
});

test("WebDAVServer PUT with path traversal returns 404", async () => {
  await withTempDir(async (dir) => {
    const parentDir = await mkdtemp(join(tmpdir(), "sandy-webdav-parent-"));
    try {
      const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
      const server = createServer(grants);
      await server.start();
      const port = server.getPort();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/../../${basename(parentDir)}/secret.txt`, {
          method: "PUT",
          headers: {Authorization: "Basic dXNlcjpwYXNz"},
          body: "evil",
        });
        assert.equal(response.status, 404);
        const leaked = await statSafe(join(parentDir, "secret.txt"));
        assert.equal(leaked, null);
      } finally {
        await server.stop();
      }
    } finally {
      await rm(parentDir, {recursive: true, force: true});
    }
  });
});

test("WebDAVServer DELETE with path traversal returns 404", async () => {
  await withTempDir(async (dir) => {
    const parentDir = await mkdtemp(join(tmpdir(), "sandy-webdav-parent-"));
    try {
      await writeFile(join(parentDir, "secret.txt"), "keep me");
      const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
      const server = createServer(grants);
      await server.start();
      const port = server.getPort();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/../../${basename(parentDir)}/secret.txt`, {
          method: "DELETE",
          headers: {Authorization: "Basic dXNlcjpwYXNz"},
        });
        assert.equal(response.status, 404);
        const kept = await readFile(join(parentDir, "secret.txt"), "utf8");
        assert.equal(kept, "keep me");
      } finally {
        await server.stop();
      }
    } finally {
      await rm(parentDir, {recursive: true, force: true});
    }
  });
});

test("WebDAVServer PROPFIND with path traversal returns 404", async () => {
  await withTempDir(async (dir) => {
    const parentDir = await mkdtemp(join(tmpdir(), "sandy-webdav-parent-"));
    try {
      const grants = new Map([["grant-1", {grantId: "grant-1", hostPath: dir, level: "read_write" as const}]]);
      const server = createServer(grants);
      await server.start();
      const port = server.getPort();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/bundles/test-bundle/grants/grant-1/../../${basename(parentDir)}`, {
          method: "PROPFIND",
          headers: {Authorization: "Basic dXNlcjpwYXNz"},
        });
        assert.equal(response.status, 404);
      } finally {
        await server.stop();
      }
    } finally {
      await rm(parentDir, {recursive: true, force: true});
    }
  });
});

async function statSafe(path: string): Promise<{isDirectory(): boolean} | null> {
  try {
    const {stat} = await import("node:fs/promises");
    return await stat(path);
  } catch {
    return null;
  }
}
