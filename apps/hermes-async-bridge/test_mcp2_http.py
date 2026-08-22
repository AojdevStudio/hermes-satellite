import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from starlette.testclient import TestClient

import hermes_async_bridge


class MCP2HTTPTests(unittest.TestCase):
    def test_health_and_bearer_auth_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            hermes_async_bridge, "DB_PATH", Path(temp_dir) / "bridge.db"
        ):
            server = hermes_async_bridge.create_mcp_server(token="test-token")
            app = server.streamable_http_app(host="127.0.0.1")

            with TestClient(app, base_url="http://127.0.0.1:8081") as client:
                self.assertEqual(client.get("/healthz").text, "ok\n")
                self.assertEqual(client.post("/mcp").status_code, 401)
                response = client.post(
                    "/mcp",
                    headers={
                        "Authorization": "Bearer test-token",
                        "Accept": "application/json, text/event-stream",
                    },
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": {
                            "protocolVersion": "2025-06-18",
                            "capabilities": {},
                            "clientInfo": {"name": "bridge-test", "version": "1"},
                        },
                    },
                )
                self.assertEqual(response.status_code, 200)
                self.assertIn("hermes-async", response.text)


if __name__ == "__main__":
    unittest.main()
