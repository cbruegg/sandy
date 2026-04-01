import type { IncomingMessage } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { HostCommand, SubAgentEvent } from "../types.js";
import { parseSubAgentEvent, serializeHostCommand } from "../types.js";

type TaskRegistration = {
  onEvent: (event: SubAgentEvent) => Promise<void>;
  socket: WebSocket | null;
};

export type SubAgentBridgeOptions = {
  listenHost: string;
  listenPort: number;
  publicHost: string;
  publicPort: number;
};

export class SubAgentBridge {
  private readonly registrations = new Map<string, TaskRegistration>();
  private server: WebSocketServer | null = null;

  constructor(private readonly options: SubAgentBridgeOptions) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.server = new WebSocketServer({
      host: this.options.listenHost,
      port: this.options.listenPort,
    });

    this.server.on("connection", (socket: WebSocket, request: IncomingMessage) => {
      const url = new URL(request.url ?? "/", `ws://${request.headers.host ?? "localhost"}`);
      const taskId = url.searchParams.get("taskId");
      if (!taskId) {
        socket.close();
        return;
      }

      const registration = this.registrations.get(taskId);
      if (!registration) {
        socket.close();
        return;
      }

      registration.socket = socket;
      void registration.onEvent({ type: "worker_connected" });

      socket.on("message", (message: RawData) => {
        try {
          const event = parseSubAgentEvent(String(message));
          void registration.onEvent(event);
        } catch (error) {
          void registration.onEvent({
            type: "task_error",
            message: error instanceof Error ? error.message : "Failed to parse sub-agent event.",
          });
        }
      });

      socket.on("close", () => {
        registration.socket = null;
        void registration.onEvent({
          type: "worker_disconnected",
          message: "The sub-agent worker disconnected.",
        });
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  registerTask(taskId: string, onEvent: (event: SubAgentEvent) => Promise<void>): void {
    this.registrations.set(taskId, {
      onEvent,
      socket: null,
    });
  }

  unregisterTask(taskId: string): void {
    const registration = this.registrations.get(taskId);
    if (registration?.socket) {
      registration.socket.close();
    }
    this.registrations.delete(taskId);
  }

  workerUrl(taskId: string): string {
    return `ws://${this.options.publicHost}:${this.options.publicPort}/subagent?taskId=${encodeURIComponent(taskId)}`;
  }

  async sendCommand(taskId: string, command: HostCommand): Promise<void> {
    const registration = this.registrations.get(taskId);
    if (!registration?.socket) {
      throw new Error(`No connected worker is registered for task ${taskId}.`);
    }
    registration.socket.send(serializeHostCommand(command));
  }
}
