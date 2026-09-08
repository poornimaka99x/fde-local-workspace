"""Service-connection controller contracts; no real keychain or network."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FDE = ROOT / "claude-shared/bin/fde"


class Connections(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.env = {**os.environ, "FDE_CONNECTIONS_FILE": str(root / "connections.json"),
                    "FDE_TEST_CONNECTION_SECRET_DIR": str(root / "secrets")}

    def tearDown(self): self.tmp.cleanup()

    def fde(self, *args, stdin=None, code=0):
        result = subprocess.run([str(FDE), "connections", *args, "--json"],
                                input=stdin, text=True, capture_output=True, env=self.env)
        self.assertEqual(result.returncode, code, result.stderr)
        return json.loads(result.stdout)

    def test_tokens_are_not_metadata_or_output(self):
        self.fde("add", "--provider", "github", "--name", "Work")
        secret = "ghp_unmistakable_secret_value"
        answer = self.fde("set-secret", "github-work", stdin=secret)
        self.assertNotIn(secret, json.dumps(answer))
        self.assertNotIn(secret, Path(self.env["FDE_CONNECTIONS_FILE"]).read_text())
        self.assertTrue(answer["connection"]["configured"])

    def test_atlassian_host_is_allowlisted(self):
        answer = self.fde("add", "--provider", "atlassian", "--name", "Bad",
                          "--site-url", "https://evil.example", "--email", "a@b.com", code=2)
        self.assertEqual(answer["error"]["code"], "field_invalid")

    def test_figma_refuses_a_pasted_token(self):
        self.fde("add", "--provider", "figma", "--name", "Design")
        answer = self.fde("set-secret", "figma-design", stdin="not-a-real-token", code=2)
        self.assertEqual(answer["error"]["code"], "oauth_connection")

    def test_remove_deletes_secret_and_metadata(self):
        self.fde("add", "--provider", "bitbucket", "--name", "Work")
        self.fde("set-secret", "bitbucket-work", stdin="token-value-long-enough")
        secret_path = Path(self.env["FDE_TEST_CONNECTION_SECRET_DIR"]) / "bitbucket-work"
        self.assertTrue(secret_path.exists())
        self.fde("remove", "bitbucket-work")
        self.assertFalse(secret_path.exists())
        self.assertEqual(self.fde("list")["connections"], [])


if __name__ == "__main__": unittest.main()
