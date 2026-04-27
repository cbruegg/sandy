import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";

type ProxyTokenPayload = {
  taskId: string;
};

type WorkerGrant = {
  bearerToken: string;
};

type WorkerGrantValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: "invalid_token" | "task_mismatch";
      message: string;
    };

type WorkerGrantResolutionResult =
  | { ok: true; taskId: string }
  | {
      ok: false;
      code: "invalid_token";
      message: string;
    };

export class ProxyAccess {
  constructor(private readonly secret: string = randomBytes(32).toString("hex")) {}

  get sharedSecret(): string {
    return this.secret;
  }

  issueWorkerGrant(taskId: string): WorkerGrant {
    return {
      bearerToken: jwt.sign({
        taskId,
      } satisfies ProxyTokenPayload, this.secret, {
        expiresIn: "1d",
      }),
    };
  }

  validateWorkerGrant(input: {
    taskId: string;
    bearerToken: string;
  }): WorkerGrantValidationResult {
    const resolved = this.resolveVerifiedWorkerGrant(input.bearerToken);
    if (!resolved.ok) {
      return resolved;
    }

    if (resolved.taskId !== input.taskId) {
      return {
        ok: false,
        code: "task_mismatch",
        message: "Bearer token does not grant access to this task.",
      };
    }

    return { ok: true };
  }

  resolveVerifiedWorkerGrant(bearerToken: string): WorkerGrantResolutionResult {
    try {
      const payload = jwt.verify(bearerToken, this.secret) as ProxyTokenPayload;
      return {
        ok: true,
        taskId: payload.taskId,
      };
    } catch (error) {
      return {
        ok: false,
        code: "invalid_token",
        message: error instanceof Error ? error.message : "Invalid bearer token.",
      };
    }
  }
}
