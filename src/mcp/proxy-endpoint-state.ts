/**
 * Holds the worker-visible MCP proxy base URL once the HTTP proxy has bound a port.
 *
 * Lifecycle:
 * - Constructed during app startup before `SandyMcpProxy.start()`.
 * - Shared with both the HTTP proxy and the worker launch-config builder.
 * - `getWorkerBaseUrl()` may be called before the proxy is listening; callers will wait.
 * - `SandyMcpProxy.start()` resolves that wait by calling `setWorkerBaseUrl()` after `listen()`.
 * - After startup the value is expected to stay stable for the process lifetime.
 */
export class McpProxyEndpointState {
  private workerBaseUrl: string | null = null;
  private readonly pendingWorkerBaseUrl = new Promise<string>((resolve) => {
    this.resolvePendingWorkerBaseUrl = resolve;
  });
  private resolvePendingWorkerBaseUrl: ((workerBaseUrl: string) => void) | null = null;

  /**
   * Publishes the bound worker-facing base URL after the proxy has started listening.
   * This should be called once during startup.
   */
  setWorkerBaseUrl(workerBaseUrl: string): void {
    this.workerBaseUrl = workerBaseUrl;
    this.resolvePendingWorkerBaseUrl?.(workerBaseUrl);
    this.resolvePendingWorkerBaseUrl = null;
  }

  /**
   * Returns the worker-facing base URL, waiting until proxy startup has published it if needed.
   */
  async getWorkerBaseUrl(): Promise<string> {
    if (this.workerBaseUrl !== null) {
      return this.workerBaseUrl;
    }
    return this.pendingWorkerBaseUrl;
  }
}
