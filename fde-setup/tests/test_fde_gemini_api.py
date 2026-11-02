"""Gemini API-key accounts: several Google accounts side by side.

Every test runs against a throwaway HOME and a fake Gemini API on loopback.
Nothing here reaches Google, the operator's keys or the Antigravity sign-in.

  python3 -m unittest tests.test_fde_gemini_api -v
"""
import http.server
import json
import os
from pathlib import Path
import stat
import subprocess
import threading
import unittest

from test_fde_accounts import AccountsBase, ROOT

BIN = ROOT / "claude-shared" / "bin"
GEMINI_API = BIN / "gemini-api"
ASK_GEMINI = BIN / "ask-gemini"

KEYS = {"work": "AIzaWORKkey-0123456789abcdefghij", "personal": "AIzaPERSONALkey-0123456789abcdef"}


class FakeGemini(http.server.BaseHTTPRequestHandler):
    """Answers only for the known keys and models; records every request."""
    requests = []
    models = ["gemini-pro-latest", "gemini-3.1-pro"]

    def log_message(self, *args):
        pass

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self):
        return self.headers.get("x-goog-api-key") in KEYS.values()

    def do_GET(self):
        FakeGemini.requests.append(("GET", self.path, dict(self.headers), None))
        if not self._authorised():
            return self._send(403, {"error": {"message": "API key not valid."}})
        self._send(200, {"models": [
            {"name": f"models/{m}", "supportedGenerationMethods": ["generateContent"]}
            for m in self.models]})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        FakeGemini.requests.append(("POST", self.path, dict(self.headers), body))
        if not self._authorised():
            return self._send(403, {"error": {"message": "API key not valid."}})
        model = self.path.split("/models/", 1)[1].split(":", 1)[0]
        if model not in self.models:
            return self._send(404, {"error": {"message": f"models/{model} is not found"}})
        who = next(k for k, v in KEYS.items() if v == self.headers.get("x-goog-api-key"))
        self._send(200, {"candidates": [{
            "content": {"parts": [{"text": f"answer from {who} via {model}"}]},
            "groundingMetadata": {"groundingChunks": [
                {"web": {"uri": "https://example.org/a", "title": "Example A"}}]},
        }]})


class GeminiApiBase(AccountsBase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeGemini)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}/v1beta"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        super().setUp()
        FakeGemini.requests = []
        self.gemini = self.home / ".fde-gemini"
        self.env.update({
            "FDE_GEMINI_PROFILES_DIR": str(self.gemini),
            "FDE_GEMINI_API_BASE": self.base,
            "FDE_NO_PREAMBLE": "1",
            # ask-gemini on PATH for 'fde accounts verify'; agy deliberately absent.
            "PATH": f"{self.bin}:{BIN}:/usr/bin:/bin",
        })
        for name in ("FDE_GEMINI_ACCOUNT_DIR", "GEMINI_MODEL", "GEMINI_EFFORT",
                     "FDE_RUN_ID", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy",
                     "https_proxy", "ALL_PROXY", "all_proxy"):
            self.env.pop(name, None)

    def add(self, name, key=True):
        account = self.json_fde("accounts", "add", "--provider", "gemini-api",
                                "--name", name)["account"]
        if key:
            self.json_fde("accounts", "set-secret", account["id"], input_text=KEYS[name])
        return account

    def run_tool(self, argv, input_text="", **extra):
        env = dict(self.env, **extra)
        return subprocess.run(argv, input=input_text, text=True,
                              capture_output=True, env=env)


class TestProvider(GeminiApiBase):
    def test_the_api_key_provider_isolates_accounts(self):
        providers = {p["provider"]: p for p in
                     self.json_fde("accounts", "providers")["providers"]}
        api = providers["gemini-api"]
        self.assertEqual(api["loginMode"], "secret")
        self.assertFalse(api["sharedCredential"])
        self.assertTrue(api["multipleAccounts"])
        # Antigravity is unchanged: still one sign-in per machine.
        self.assertEqual(providers["antigravity"]["maxAccounts"], 1)

    def test_two_google_accounts_get_separate_key_folders(self):
        work, personal = self.add("work"), self.add("personal")
        self.assertEqual(work["id"], "geminiapi_work")
        self.assertEqual(personal["id"], "geminiapi_personal")
        self.assertNotEqual(work["credentialDir"], personal["credentialDir"])
        for name in ("work", "personal"):
            key = self.gemini / name / "gemini-api-key"
            self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(key.parent.stat().st_mode) & 0o077, 0)
        listed = {a["id"]: a for a in self.json_fde("accounts", "list")["accounts"]}
        self.assertTrue(listed["geminiapi_work"]["loggedIn"])
        self.assertTrue(listed["geminiapi_personal"]["loggedIn"])

    def test_launch_env_points_at_this_accounts_folder_and_carries_no_key(self):
        self.add("work")
        r = self.fde("accounts", "launch", "geminiapi_work", "--json")
        self.assertEqual(r.returncode, 3, r.stderr)  # one-shot, not interactive
        env = json.loads(r.stdout)["launch"]["env"]
        self.assertEqual(env["FDE_GEMINI_ACCOUNT_DIR"], str(self.gemini / "work"))
        self.assertEqual(env["FDE_GEMINI_API_DEFAULT_MODEL"], "gemini-pro-latest")
        self.assertNotIn(KEYS["work"], r.stdout + r.stderr)

    def test_default_model_can_be_set_and_updated(self):
        self.json_fde("accounts", "add", "--provider", "gemini-api", "--name", "work",
                      "--model", "gemini-3.1-pro")
        self.assertEqual(self.registry()["agents"]["geminiapi_work"]["model"], "gemini-3.1-pro")
        self.json_fde("accounts", "update", "geminiapi_work", "--model", "gemini-pro-latest")
        self.assertEqual(self.registry()["agents"]["geminiapi_work"]["model"], "gemini-pro-latest")

    def test_verify_asks_the_api_and_never_prints_the_key(self):
        self.add("work")
        r = self.fde("accounts", "verify", "geminiapi_work", "--json")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(json.loads(r.stdout)["account"]["check"]["ran"])
        self.assertNotIn(KEYS["work"], r.stdout + r.stderr)

    def test_verify_reports_a_rejected_key(self):
        self.add("work", key=False)
        self.json_fde("accounts", "set-secret", "geminiapi_work",
                      input_text="AIzaNOT-A-REAL-KEY-0123456789abcdef")
        r = self.fde("accounts", "verify", "geminiapi_work", "--json")
        self.assertEqual(r.returncode, 4, r.stdout + r.stderr)
        self.assertFalse(json.loads(r.stdout)["account"]["loggedIn"])


class TestAsk(GeminiApiBase):
    def test_each_account_answers_with_its_own_key(self):
        self.add("work"), self.add("personal")
        for name in ("work", "personal"):
            r = self.run_tool([str(ASK_GEMINI), "--account", name, "what changed?"])
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn(f"answer from {name}", r.stdout)
            self.assertIn("https://example.org/a", r.stdout)
            self.assertNotIn(KEYS[name], r.stdout + r.stderr)
        method, path, headers, body = FakeGemini.requests[-1]
        self.assertEqual(body["contents"][0]["parts"][0]["text"], "what changed?")
        self.assertEqual(body["tools"], [{"google_search": {}}])
        # The key travels as a header, never in the URL.
        self.assertNotIn("key=", path)

    def test_the_controller_environment_selects_the_account(self):
        self.add("personal")
        r = self.run_tool([str(ASK_GEMINI), "hello"],
                          FDE_GEMINI_ACCOUNT_DIR=str(self.gemini / "personal"))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("answer from personal", r.stdout)

    def test_an_antigravity_route_is_split_into_model_and_thinking_level(self):
        self.add("work")
        r = self.run_tool([str(ASK_GEMINI), "--account", "work",
                           "--model", "gemini-3.1-pro-high", "q"])
        self.assertEqual(r.returncode, 0, r.stderr)
        _m, path, _h, body = FakeGemini.requests[-1]
        self.assertIn("/models/gemini-3.1-pro:generateContent", path)
        self.assertEqual(body["generationConfig"]["thinkingConfig"]["thinkingLevel"], "high")

    def test_an_unknown_model_falls_back_to_the_account_default(self):
        self.add("work")
        r = self.run_tool([str(ASK_GEMINI), "--account", "work",
                           "--model", "gemini-9-ultra", "q"])
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("via gemini-pro-latest", r.stdout)
        self.assertIn("not available to this key", r.stderr)

    def test_no_web_turns_grounding_off(self):
        self.add("work")
        r = self.run_tool([str(ASK_GEMINI), "--account", "work", "q"], FDE_GEMINI_NO_WEB="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("tools", FakeGemini.requests[-1][3])

    def test_an_unknown_account_name_is_refused(self):
        r = self.run_tool([str(ASK_GEMINI), "--account", "nobody", "q"])
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no Gemini API account named 'nobody'", r.stderr)

    def test_a_key_readable_by_others_is_refused(self):
        self.add("work")
        (self.gemini / "work" / "gemini-api-key").chmod(0o644)
        r = self.run_tool([str(ASK_GEMINI), "--account", "work", "q"])
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("readable by other users", r.stderr)
        self.assertEqual(FakeGemini.requests, [])

    def test_a_plain_http_endpoint_off_this_machine_is_refused(self):
        self.add("work")
        r = self.run_tool([str(GEMINI_API), "--check"],
                          FDE_GEMINI_ACCOUNT_DIR=str(self.gemini / "work"),
                          FDE_GEMINI_API_BASE="http://example.org/v1beta")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("must be https", r.stderr)

    def test_a_direct_call_inside_a_run_is_still_refused(self):
        self.add("work")
        r = self.run_tool([str(ASK_GEMINI), "--account", "work", "q"], FDE_RUN_ID="r-1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("fde invoke", r.stderr)
        self.assertEqual(FakeGemini.requests, [])


if __name__ == "__main__":
    unittest.main()
