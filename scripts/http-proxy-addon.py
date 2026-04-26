import json
import logging
import socket
from datetime import datetime, timezone

from mitmproxy import ctx, http


def emit(message: dict) -> None:
    print(json.dumps(message), flush=True)


class JsonLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        event = record.name or "mitmproxy.log"
        emit({
            "type": "log",
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "event": event,
            "data": {
                "message": record.getMessage(),
            },
        })


class SandyHttpProxyAddon:
    def load(self, loader):
        loader.add_option(
            name="sandy_auth_socket",
            typespec=str,
            default="/run/sandy-proxy-auth.sock",
            help="Unix socket used for Sandy proxy authorization and header resolution.",
        )

    def running(self):
        emit({"type": "ready"})

    def requestheaders(self, flow: http.HTTPFlow) -> None:
        username, password = self._get_proxy_credentials(flow)
        if not username or not password:
            flow.response = http.Response.make(407, b"Proxy authentication required.")
            return

        request = {
            "proxyAuthUsername": username,
            "proxyAuthPassword": password,
            "targetHost": flow.request.host,
            "headers": [
                {"name": name, "value": value}
                for name, value in flow.request.headers.items(multi=True)
            ],
        }

        try:
            response = self._call_auth_service(request)
        except Exception as error:  # pragma: no cover - defensive runtime path
            emit({
                "type": "log",
                "timestamp": "",
                "level": "error",
                "event": "http.proxy.auth_service_failed",
                "data": {"message": str(error)},
            })
            flow.response = http.Response.make(502, f"Authorization service failure: {error}".encode("utf8"))
            return

        if response["outcome"] != "approved":
            status_code = 403 if response["outcome"] == "denied" else 502
            flow.response = http.Response.make(status_code, response["message"].encode("utf8"))
            return

        flow.request.headers.clear()
        for header in response["headers"]:
            flow.request.headers.add(header["name"], header["value"])

    def _call_auth_service(self, request: dict) -> dict:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            sock.settimeout(5)
            sock.connect(ctx.options.sandy_auth_socket)
            sock.sendall((json.dumps(request) + "\n").encode("utf8"))

            buffer = b""
            while b"\n" not in buffer:
                chunk = sock.recv(65536)
                if not chunk:
                    raise RuntimeError("Authorization service closed connection unexpectedly.")
                buffer += chunk

            line = buffer.split(b"\n", 1)[0].decode("utf8")
            return json.loads(line)
        finally:
            sock.close()

    def _get_proxy_credentials(self, flow: http.HTTPFlow) -> tuple[str | None, str | None]:
        auth = flow.metadata.get("proxyauth")
        if not isinstance(auth, (list, tuple)) or len(auth) != 2:
            return None, None
        username = auth[0]
        password = auth[1]
        if not isinstance(username, str) or not isinstance(password, str):
            return None, None
        return username, password


logging.getLogger().handlers = [JsonLogHandler()]
logging.getLogger().setLevel(logging.INFO)

addons = [SandyHttpProxyAddon()]
