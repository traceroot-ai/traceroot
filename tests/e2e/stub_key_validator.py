"""A stand-in for the UI's ``/api/internal/validate-api-key`` route, for the CI
contract job.

REST resolves a public API key by asking the Next.js server (see
``rest/routers/public/deps.py::authenticate_api_key``). The contract test in
``test_agent_trace_contract.py`` is about ingest isolation, not key resolution,
and the UI route has its own unit tests — so in CI this process answers for it:
one key (by its SHA-256, ``TRACEROOT_E2E_API_KEY_SHA256``) maps to one project
(``TRACEROOT_E2E_PROJECT_ID``); anything else is 401. It checks the platform
secret the same way the real route does, so a REST that stopped sending it
would fail here too.

It is given the key's SHA-256, never the key: the digest is all a validator
needs, and a fixture that hashes a credential reads (to a scanner and to a
person) like one that stores passwords.

Usage: ``TRACEROOT_E2E_API_KEY_SHA256=$(printf '%s' "$TRACEROOT_E2E_API_KEY" |
shasum -a 256 | cut -d' ' -f1) TRACEROOT_E2E_PROJECT_ID=… INTERNAL_API_SECRET=…
python tests/e2e/stub_key_validator.py 3999`` and point REST at it with
``TRACEROOT_UI_URL=http://localhost:3999``.
"""

import hmac
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if self.path != "/api/internal/validate-api-key":
            return self._json(404, {"error": "not found"})
        secret = os.environ["INTERNAL_API_SECRET"]
        if not hmac.compare_digest(self.headers.get("X-Internal-Secret") or "", secret):
            return self._json(403, {"error": "bad internal secret"})
        try:
            key_hash = json.loads(body or b"{}").get("keyHash") or ""
        except ValueError:
            key_hash = ""
        expected = os.environ["TRACEROOT_E2E_API_KEY_SHA256"]
        if not hmac.compare_digest(key_hash, expected):
            return self._json(401, {"valid": False, "error": "Invalid API key"})
        return self._json(
            200,
            {
                "valid": True,
                "projectId": os.environ["TRACEROOT_E2E_PROJECT_ID"],
                "workspaceId": "ws-e2e",
                "billingPlan": "free",
                "ingestionBlocked": False,
                "projectName": "e2e",
                "workspaceName": "e2e",
                "keyName": "e2e",
                "keyHint": "tr-e2e",
            },
        )

    def _json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args: object) -> None:  # quiet
        return


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 3999
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
