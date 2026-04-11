import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMcpProxyPath,
  buildMcpProxyWorkerUrl,
  mcpProxyContainerAlias,
  mcpProxyWorkerBaseUrl,
  parseMcpProxyPath,
} from "./proxy-route.js";

test("MCP proxy route helpers share one encoding contract", () => {
  assert.equal(mcpProxyContainerAlias, "sandy-mcp-proxy");
  assert.equal(mcpProxyWorkerBaseUrl, "http://sandy-mcp-proxy:8080");

  const route = {
    taskId: "task/1",
    serverId: "github tools",
  };

  const path = buildMcpProxyPath(route);

  assert.equal(path, "/mcp/tasks/task%2F1/servers/github%20tools");
  assert.equal(
    buildMcpProxyWorkerUrl(route),
    "http://sandy-mcp-proxy:8080/mcp/tasks/task%2F1/servers/github%20tools",
  );
  assert.deepEqual(parseMcpProxyPath(path), route);
  assert.equal(parseMcpProxyPath("/not-an-mcp-route"), null);
});
