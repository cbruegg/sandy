import { readFileSync } from "node:fs";
import { SandyHttpProxy } from "./http/http-proxy.js";
import { configureLogger } from "./logger.js";
import { SandyMcpProxyAccess } from "./mcp/proxy-access.js";
import { createUnixSocketAuthorizer } from "./http/proxy-auth-client.js";
import type { HttpTokenConfig } from "./config.js";

type Bootstrap = {
  httpTokens: Record<string, HttpTokenConfig>;
  sharedSecret: string;
  caCert?: string;
  caKey?: string;
};

function send(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main(): Promise<void> {
  configureLogger({
    outputMode: "stderr",
    forwardLog: (payload) => send({
      type: "log",
      ...payload,
    }),
  });

  const bootstrapPath = process.env["SANDY_HTTP_PROXY_BOOTSTRAP_FILE"];
  if (!bootstrapPath) {
    throw new Error(
      "SANDY_HTTP_PROXY_BOOTSTRAP_FILE environment variable is required.",
    );
  }

  const bootstrap = JSON.parse(readFileSync(bootstrapPath, "utf8")) as Bootstrap;
  const access = new SandyMcpProxyAccess(bootstrap.sharedSecret);
  const socketPath =
    process.env["SANDY_HTTP_PROXY_AUTH_SOCKET"] ?? "/run/sandy-proxy-auth.sock";

  const proxy = new SandyHttpProxy({
    access,
    httpTokens: bootstrap.httpTokens,
    port: 8081,
    caCert: bootstrap.caCert,
    caKey: bootstrap.caKey,
    authorizeHttpTokenUse: createUnixSocketAuthorizer(socketPath),
  });

  await proxy.start();
  send({ type: "ready" });

  process.stdin.on("close", () => {
    void proxy.stop().then(() => {
      process.exit(0);
    });
  });
}

main().catch((error) => {
  send({
    type: "fatal_error",
    message: error instanceof Error ? error.message : "HTTP proxy failed to start.",
  });
  process.exit(1);
});
