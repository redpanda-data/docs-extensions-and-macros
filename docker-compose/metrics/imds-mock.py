"""Stand-in for the AWS instance metadata service.

Redpanda exports the cloud_roles credential refresh metrics only when object
storage credentials come from a metadata service. This answers the three
requests that refresh makes and hands back the static keys of the object store
in the same Compose project. The token prefix tells Redpanda not to send a
session token, which a plain S3-compatible store would reject.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

ROLE = "metrics"
CREDENTIALS = {
    "AccessKeyId": os.environ["MOCK_ACCESS_KEY"],
    "SecretAccessKey": os.environ["MOCK_SECRET_KEY"],
    "Token": "__REDPANDA_SKIP_IAM_TOKEN_metrics",
    "Expiration": "2099-01-01T00:00:00Z",
}
BASE = "/latest/meta-data/iam/security-credentials/"


class Handler(BaseHTTPRequestHandler):
    def _send(self, body, status=200):
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self):
        if self.path == "/latest/api/token":
            self._send("metrics-token")
        else:
            self._send("not found", 404)

    def do_GET(self):
        if self.path == BASE:
            self._send(ROLE)
        elif self.path == BASE + ROLE:
            self._send(json.dumps(CREDENTIALS))
        else:
            self._send("not found", 404)


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
