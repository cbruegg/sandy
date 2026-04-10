import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";

export const workerProxyTokenEnvVar = "SANDY_MCP_PROXY_TOKEN";
export const mcpProxyWorkerBaseUrl = "http://sandy-mcp-proxy:8080";

type McpProxyTokenPayload = {
  taskId: string;
};

type McpWorkerGrant = {
  bearerToken: string;
};

type McpWorkerGrantValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: "invalid_token" | "task_mismatch";
      message: string;
    };

export class SandyMcpProxyAccess {
  constructor(private readonly secret: string = randomBytes(32).toString("hex")) {}

  get sharedSecret(): string {
    return this.secret;
  }

  issueWorkerGrant(taskId: string): McpWorkerGrant {
    return {
      bearerToken: jwt.sign({
        taskId,
      } satisfies McpProxyTokenPayload, this.secret, {
        expiresIn: "1d",
      }),
    };
  }

  validateWorkerGrant(input: {
    taskId: string;
    bearerToken: string;
  }): McpWorkerGrantValidationResult {
    let payload: McpProxyTokenPayload;

    try {
      payload = jwt.verify(input.bearerToken, this.secret) as McpProxyTokenPayload;
    } catch (error) {
      return {
        ok: false,
        code: "invalid_token",
        message: error instanceof Error ? error.message : "Invalid bearer token.",
      };
    }

    if (payload.taskId !== input.taskId) {
      return {
        ok: false,
        code: "task_mismatch",
        message: "Bearer token does not grant access to this task.",
      };
    }

    return { ok: true };
  }
}
