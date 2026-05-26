import json
import os
import queue
import socketserver
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone


class AuthServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True

    def __init__(self, server_address, request_handler_class, supervisor):
        super().__init__(server_address, request_handler_class)
        self.supervisor = supervisor


class AuthRequestHandler(socketserver.StreamRequestHandler):
    def handle(self):
        line = self.rfile.readline()
        if not line:
            return
        request = json.loads(line.decode("utf8"))
        response = self.server.supervisor.resolve_request(request)
        self.wfile.write((json.dumps(response) + "\n").encode("utf8"))
        self.wfile.flush()


class Supervisor:
    def __init__(self):
        self._pending = {}
        self._pending_lock = threading.Lock()
        self._stop_event = threading.Event()
        self._auth_server = AuthServer(("127.0.0.1", 0), AuthRequestHandler, self)
        self._auth_port = self._auth_server.server_address[1]
        self._mitmdump = None

    def run(self):
        auth_thread = threading.Thread(target=self._auth_server.serve_forever, daemon=True)
        auth_thread.start()

        self._mitmdump = subprocess.Popen(
            [
                "mitmdump",
                "--mode", "regular",
                "--listen-host", "0.0.0.0",
                "--listen-port", "8081",
                "--proxyauth", "any",
                "--quiet",
                "--set", f"confdir={os.environ.get('MITMPROXY_CONFDIR', '/run/sandy-mitmproxy-conf')}",
                "--set", "block_global=false",
                "--set", "block_private=false",
                "--set", "flow_detail=0",
                "-s", "/app/http-proxy-addon.py",
                "--set", f"sandy_auth_port={self._auth_port}",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

        threading.Thread(target=self._read_mitmdump_stdout, daemon=True).start()
        threading.Thread(target=self._read_mitmdump_stderr, daemon=True).start()
        threading.Thread(target=self._watch_heartbeat, daemon=True).start()

        self._emit({"type": "ready"})

        try:
            for line in sys.stdin:
                raw = line.strip()
                if not raw:
                    continue
                if self._stop_event.is_set():
                    break
                message = json.loads(raw)
                if message.get("type") != "auth_response":
                    continue
                with self._pending_lock:
                    pending = self._pending.pop(message["requestId"], None)
                if pending is not None:
                    pending.put(message)
        finally:
            self.shutdown()

    def resolve_request(self, request: dict) -> dict:
        request_id = str(uuid.uuid4())
        pending = queue.Queue(maxsize=1)
        with self._pending_lock:
          self._pending[request_id] = pending

        self._emit({
            "type": "auth_request",
            "requestId": request_id,
            **request,
        })

        try:
            return pending.get(timeout=10)
        except queue.Empty:
            with self._pending_lock:
                self._pending.pop(request_id, None)
            return {
                "type": "auth_response",
                "requestId": request_id,
                "outcome": "failed",
                "message": "Authorization request timed out.",
            }

    def shutdown(self):
        if self._stop_event.is_set():
            return
        self._stop_event.set()
        self._auth_server.shutdown()
        self._auth_server.server_close()
        if self._mitmdump and self._mitmdump.poll() is None:
            self._mitmdump.terminate()

    def _read_mitmdump_stdout(self):
        assert self._mitmdump is not None
        for line in self._mitmdump.stdout:
            raw = line.strip()
            if not raw:
                continue
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                self._emit_log("warn", "http.proxy.stdout", {"message": raw})
                continue
            self._emit(message)

    def _read_mitmdump_stderr(self):
        assert self._mitmdump is not None
        for line in self._mitmdump.stderr:
            raw = line.strip()
            if raw:
                self._emit_log("warn", "http.proxy.stderr", {"message": raw})

    def _emit_log(self, level: str, event: str, data: dict):
        self._emit({
            "type": "log",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": level,
            "event": event,
            "data": data,
        })

    def _emit(self, message: dict):
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()

    def _watch_heartbeat(self):
        heartbeat_path = os.environ.get("SANDY_CONTROLLER_HEARTBEAT_PATH")
        if not heartbeat_path:
            return
        timeout_ms = int(os.environ.get("SANDY_CONTROLLER_HEARTBEAT_TIMEOUT_MS", 30000))
        interval = max(timeout_ms / 2000.0, 2.0)
        while not self._stop_event.wait(interval):
            try:
                mtime = os.path.getmtime(heartbeat_path)
                age_s = time.time() - mtime
                if age_s * 1000 > timeout_ms:
                    self._emit_log("warn", "http.proxy.heartbeat_stale", {"age_ms": age_s * 1000})
                    self.shutdown()
                    return
            except OSError:
                # File missing — controller directory may be gone.
                self._emit_log("warn", "http.proxy.heartbeat_missing", {})
                self.shutdown()
                return


if __name__ == "__main__":
    try:
        Supervisor().run()
    except Exception as error:  # pragma: no cover - startup path
        sys.stdout.write(json.dumps({
            "type": "fatal_error",
            "message": str(error),
        }) + "\n")
        sys.stdout.flush()
        raise
