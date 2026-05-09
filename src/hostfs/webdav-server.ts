import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import {createReadStream, createWriteStream, type Stats} from "node:fs";
import {mkdir, rm, stat, readdir} from "node:fs/promises";
import {basename, dirname, join, resolve} from "node:path";
import {pipeline} from "node:stream/promises";
import {logger} from "../logger.js";
import type {BundleNamespaceRegistry} from "./bundle-namespace-registry.js";
import type {HostDirectoryAccessLevel} from "./path-policy.ts";

type WebDAVGrant = {
  grantId: string;
  hostPath: string;
  level: HostDirectoryAccessLevel;
};

export type WebDAVBundleNamespace = {
  bundleId: string;
  grants: Map<string, WebDAVGrant>;
};

type WebDAVServerOptions = {
  port: number;
  host?: string;
  authenticate: (username: string, password: string) => string | null; // returns bundleId or null
  namespaceRegistry: BundleNamespaceRegistry;
};

const READ_METHODS = ["OPTIONS", "GET", "HEAD", "PROPFIND"];
const WRITE_METHODS = ["PUT", "DELETE", "MKCOL"];
const ALLOWED_METHODS = [...READ_METHODS, ...WRITE_METHODS];

export class WebDAVServer {
  private server: Server | null = null;

  constructor(private readonly options: WebDAVServerOptions) {}

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      this.server.listen(this.options.port, this.options.host ?? "127.0.0.1", () => {
        const address = this.server!.address();
        const port = typeof address === "string" ? parseInt(address, 10) : address!.port;
        logger.info("hostfs.webdav_server_started", {
          host: this.options.host ?? "127.0.0.1",
          port,
        });
        resolve(port);
      });
    });
  }

  getPort(): number {
    if (!this.server) {
      throw new Error("WebDAV server has not been started.");
    }
    const address = this.server.address();
    if (!address) {
      throw new Error("WebDAV server is not listening.");
    }
    return typeof address === "string" ? parseInt(address, 10) : address.port;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestPath = decodeURIComponent(req.url ?? "/");
    const authHeader = req.headers.authorization ?? "";
    const bundleId = this.authenticateRequest(authHeader);

    if (!bundleId) {
      logger.warn("hostfs.webdav_auth_failed", {
        method: req.method,
        url: requestPath,
      });
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Basic realm="Sandy Hostfs"');
      res.end("Unauthorized");
      return;
    }

    logger.debug("hostfs.webdav_request_received", {
      method: req.method,
      url: requestPath,
      bundleId,
    });

    const namespace = this.options.namespaceRegistry.get(bundleId);
    if (!namespace) {
      logger.warn("hostfs.webdav_namespace_missing", {
        method: req.method,
        url: requestPath,
        bundleId,
      });
      res.statusCode = 404;
      res.end("Bundle namespace not found");
      return;
    }

    try {
      switch (req.method) {
        case "PROPFIND":
          await this.handlePropfind(req, res, namespace);
          break;
        case "GET":
          await this.handleGet(req, res, namespace);
          break;
        case "HEAD":
          await this.handleHead(req, res, namespace);
          break;
        case "PUT":
          await this.handlePut(req, res, namespace);
          break;
        case "DELETE":
          await this.handleDelete(req, res, namespace);
          break;
        case "MKCOL":
          await this.handleMkcol(req, res, namespace);
          break;
        case "OPTIONS":
          res.statusCode = 200;
          res.setHeader("Allow", ALLOWED_METHODS.join(", "));
          res.setHeader("DAV", "1");
          res.end();
          break;
        default:
          res.statusCode = 405;
          res.setHeader("Allow", ALLOWED_METHODS.join(", "));
          res.end("Method not allowed");
      }
    } catch (error) {
        logger.error("hostfs.webdav_request_failed", {
          method: req.method,
          url: requestPath,
          bundleId,
          error: error instanceof Error ? error.message : String(error),
        });
      res.statusCode = 500;
      res.end("Internal server error");
    }
  }

  private authenticateRequest(authHeader: string): string | null {
    if (!authHeader.startsWith("Basic ")) {
      return null;
    }
    const base64 = authHeader.slice(6);
    const decoded = Buffer.from(base64, "base64").toString("utf8");
    const colonIndex = decoded.indexOf(":");
    if (colonIndex === -1) {
      return null;
    }
    const username = decoded.slice(0, colonIndex);
    const password = decoded.slice(colonIndex + 1);
    return this.options.authenticate(username, password);
  }

  private async handlePropfind(
    req: IncomingMessage,
    res: ServerResponse,
    namespace: WebDAVBundleNamespace,
  ): Promise<void> {
    const urlPath = decodeURIComponent(req.url ?? "/");
    const depth = req.headers["depth"] ?? "1";

    const entries = await this.resolveWebDAVPath(urlPath, namespace);
    if (entries === null) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const [rootEntry, childEntries] = entries;

    const bodyParts: string[] = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<D:multistatus xmlns:D="DAV:">',
    ];

    bodyParts.push(this.buildPropfindResponseEntry(urlPath, rootEntry));

    if (depth !== "0" && rootEntry.kind === "directory") {
      for (const child of childEntries) {
        const childUrl = urlPath.endsWith("/") ? urlPath + child.name : `${urlPath}/${child.name}`;
        bodyParts.push(this.buildPropfindResponseEntry(childUrl, child));
      }
    }

    bodyParts.push("</D:multistatus>");

    res.statusCode = 207;
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.end(bodyParts.join("\n"));
  }

  private async handleGet(
    req: IncomingMessage,
    res: ServerResponse,
    namespace: WebDAVBundleNamespace,
  ): Promise<void> {
    const urlPath = decodeURIComponent(req.url ?? "/");
    const entries = await this.resolveWebDAVPath(urlPath, namespace);
    if (entries === null) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const [entry] = entries;
    if (entry.kind === "directory") {
      res.statusCode = 301;
      res.setHeader("Location", urlPath.endsWith("/") ? urlPath : `${urlPath}/`);
      res.end();
      return;
    }

    const hostPath = entry.hostPath;
    const stats = await statSafe(hostPath);
    if (!stats) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Length", stats.size);
    res.setHeader("Content-Type", "application/octet-stream");
    const stream = createReadStream(hostPath);
    stream.pipe(res);
  }

  private async handleHead(
    req: IncomingMessage,
    res: ServerResponse,
    namespace: WebDAVBundleNamespace,
  ): Promise<void> {
    const urlPath = decodeURIComponent(req.url ?? "/");
    const entries = await this.resolveWebDAVPath(urlPath, namespace);
    if (entries === null) {
      res.statusCode = 404;
      res.end();
      return;
    }

    const [entry] = entries;
    if (entry.kind === "directory") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end();
      return;
    }

    const stats = await statSafe(entry.hostPath);
    if (!stats) {
      res.statusCode = 404;
      res.end();
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Length", stats.size);
    res.setHeader("Content-Type", "application/octet-stream");
    res.end();
  }

  private async handlePut(
    req: IncomingMessage,
    res: ServerResponse,
    namespace: WebDAVBundleNamespace,
  ): Promise<void> {
    const writeInfo = this.resolveWebDAVWritePath(decodeURIComponent(req.url ?? "/"), namespace);
    if (!writeInfo) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    if (writeInfo.isReadOnly) {
      res.statusCode = 403;
      res.end("Read-only grant");
      return;
    }

    const hostPath = writeInfo.hostPath;
    const parentDir = dirname(hostPath);

    try {
      await mkdir(parentDir, {recursive: true});
    } catch {
      // Parent might already exist
    }

    const existed = (await statSafe(hostPath)) !== null;

    try {
      const writeStream = createWriteStream(hostPath);
      await pipeline(req, writeStream);
      res.statusCode = existed ? 204 : 201;
      res.end();
    } catch (error) {
      logger.error("hostfs.webdav_put_failed", {
        hostPath,
        error: error instanceof Error ? error.message : String(error),
      });
      res.statusCode = 500;
      res.end("Write failed");
    }
  }

  private async handleDelete(
    req: IncomingMessage,
    res: ServerResponse,
    namespace: WebDAVBundleNamespace,
  ): Promise<void> {
    const writeInfo = this.resolveWebDAVWritePath(decodeURIComponent(req.url ?? "/"), namespace);
    if (!writeInfo) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    if (writeInfo.isReadOnly) {
      res.statusCode = 403;
      res.end("Read-only grant");
      return;
    }

    // Prevent deleting the grant root directory itself
    if (writeInfo.isGrantRoot) {
      res.statusCode = 403;
      res.end("Cannot delete grant root");
      return;
    }

    const hostPath = writeInfo.hostPath;
    const stats = await statSafe(hostPath);
    if (!stats) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    try {
      await rm(hostPath, {recursive: stats.isDirectory()});
      res.statusCode = 204;
      res.end();
    } catch (error) {
      logger.error("hostfs.webdav_delete_failed", {
        hostPath,
        error: error instanceof Error ? error.message : String(error),
      });
      res.statusCode = 500;
      res.end("Delete failed");
    }
  }

  private async handleMkcol(
    req: IncomingMessage,
    res: ServerResponse,
    namespace: WebDAVBundleNamespace,
  ): Promise<void> {
    const writeInfo = this.resolveWebDAVWritePath(decodeURIComponent(req.url ?? "/"), namespace);
    if (!writeInfo) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    if (writeInfo.isReadOnly) {
      res.statusCode = 403;
      res.end("Read-only grant");
      return;
    }

    const hostPath = writeInfo.hostPath;

    try {
      await mkdir(hostPath, {recursive: false});
      res.statusCode = 201;
      res.end();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        res.statusCode = 405;
        res.end("Already exists");
        return;
      }
      logger.error("hostfs.webdav_mkcol_failed", {
        hostPath,
        error: error instanceof Error ? error.message : String(error),
      });
      res.statusCode = 500;
      res.end("Create directory failed");
    }
  }

  private buildPropfindResponseEntry(href: string, entry: WebDAVEntry): string {
    const isDir = entry.kind === "directory";
    const displayName = encodeXml(basename(href) || "/");
    const hrefEncoded = encodeXml(href);

    const props = [
      "<D:displayname>", displayName, "</D:displayname>",
      "<D:getlastmodified>", entry.mtime, "</D:getlastmodified>",
      "<D:resourcetype>", isDir ? "<D:collection/>" : "", "</D:resourcetype>",
    ];

    if (!isDir && entry.size !== undefined) {
      props.push(`<D:getcontentlength>${entry.size}</D:getcontentlength>`);
    }

    return [
      "<D:response>",
      `<D:href>${hrefEncoded}</D:href>`,
      "<D:propstat>",
      "<D:prop>",
      ...props,
      "</D:prop>",
      "<D:status>HTTP/1.1 200 OK</D:status>",
      "</D:propstat>",
      "</D:response>",
    ].join("\n");
  }

  private async resolveWebDAVPath(
    urlPath: string,
    namespace: WebDAVBundleNamespace,
  ): Promise<[WebDAVEntry, WebDAVEntry[]] | null> {
    const normalizedPath = urlPath.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

    // Root of bundle namespace
    if (normalizedPath === `/bundles/${namespace.bundleId}`) {
      return [this.makeSyntheticDirEntry("/"), [this.makeSyntheticDirEntry("grants")]];
    }

    // /bundles/<bundleId>/grants
    if (normalizedPath === `/bundles/${namespace.bundleId}/grants`) {
      const grantEntries: WebDAVEntry[] = [];
      for (const grant of namespace.grants.values()) {
        grantEntries.push(this.makeSyntheticDirEntry(grant.grantId));
      }
      return [this.makeSyntheticDirEntry("grants"), grantEntries];
    }

    // /bundles/<bundleId>/grants/<grantId>/...
    const grantsPrefix = `/bundles/${namespace.bundleId}/grants/`;
    if (normalizedPath.startsWith(grantsPrefix)) {
      const remainder = normalizedPath.slice(grantsPrefix.length);
      const firstSlash = remainder.indexOf("/");
      const grantId = firstSlash === -1 ? remainder : remainder.slice(0, firstSlash);
      const subPath = firstSlash === -1 ? "" : remainder.slice(firstSlash + 1);

      const grant = namespace.grants.get(grantId);
      if (!grant) {
        return null;
      }

      const hostPath = this.resolveGrantPath(grant.hostPath, subPath);
      if (!hostPath) {
        return null;
      }

      const stats = await statSafe(hostPath);
      if (!stats) {
        return null;
      }

      if (stats.isDirectory()) {
        const children = await this.listDirectoryEntries(hostPath);
        return [this.makeDirEntryFromStats(hostPath, stats), children];
      }

      return [this.makeFileEntryFromStats(hostPath, stats), []];
    }

    return null;
  }

  private resolveWebDAVWritePath(
    urlPath: string,
    namespace: WebDAVBundleNamespace,
  ): {hostPath: string; isReadOnly: boolean; isGrantRoot: boolean} | null {
    const normalizedPath = urlPath.replace(/\/+/g, "/").replace(/\/$/, "") || "/";

    const grantsPrefix = `/bundles/${namespace.bundleId}/grants/`;
    if (!normalizedPath.startsWith(grantsPrefix)) {
      return null;
    }

    const remainder = normalizedPath.slice(grantsPrefix.length);
    const firstSlash = remainder.indexOf("/");
    const grantId = firstSlash === -1 ? remainder : remainder.slice(0, firstSlash);
    const subPath = firstSlash === -1 ? "" : remainder.slice(firstSlash + 1);

    const grant = namespace.grants.get(grantId);
    if (!grant) {
      return null;
    }

    const hostPath = this.resolveGrantPath(grant.hostPath, subPath);
    if (!hostPath) {
      return null;
    }

    return {
      hostPath,
      isReadOnly: grant.level === "read_only",
      isGrantRoot: subPath === "" || subPath === "/",
    };
  }

  private resolveGrantPath(grantHostPath: string, subPath: string): string | null {
    const resolvedGrant = resolve(grantHostPath);
    const resolvedTarget = resolve(grantHostPath, subPath);
    const normalizedGrant = resolvedGrant.replace(/\\/g, "/");
    const normalizedTarget = resolvedTarget.replace(/\\/g, "/");
    if (normalizedTarget !== normalizedGrant && !normalizedTarget.startsWith(normalizedGrant + "/")) {
      return null;
    }
    return resolvedTarget;
  }

  private async listDirectoryEntries(hostPath: string): Promise<WebDAVEntry[]> {
    try {
      const entries = await readdir(hostPath, {withFileTypes: true});
      const result: WebDAVEntry[] = [];
      for (const entry of entries) {
        const entryPath = join(hostPath, entry.name);
        const stats = await statSafe(entryPath);
        if (!stats) continue;
        if (entry.isDirectory()) {
          result.push(this.makeDirEntryFromStats(entryPath, stats));
        } else {
          result.push(this.makeFileEntryFromStats(entryPath, stats));
        }
      }
      return result.sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  private makeSyntheticDirEntry(name: string): WebDAVEntry {
    return {
      kind: "directory",
      name,
      hostPath: "",
      mtime: new Date().toUTCString(),
    };
  }

  private makeDirEntryFromStats(hostPath: string, stats: Stats): WebDAVEntry {
    return {
      kind: "directory",
      name: basename(hostPath),
      hostPath,
      mtime: stats.mtime.toUTCString(),
    };
  }

  private makeFileEntryFromStats(hostPath: string, stats: Stats): WebDAVEntry {
    return {
      kind: "file",
      name: basename(hostPath),
      hostPath,
      mtime: stats.mtime.toUTCString(),
      size: stats.size,
    };
  }
}

type WebDAVEntry = {
  kind: "directory" | "file";
  name: string;
  hostPath: string;
  mtime: string;
  size?: number;
};

async function statSafe(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function encodeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
