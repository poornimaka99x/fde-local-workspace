"""Regression tests for fde-doctor's run-scoped Atlassian MCP checks."""

import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
DOCTOR = ROOT / "claude-shared" / "bin" / "fde-doctor"


def load_doctor():
    loader = importlib.machinery.SourceFileLoader("fde_doctor_test_module", str(DOCTOR))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


class AtlassianDoctorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.shared = Path(self.tmp.name) / ".claude-shared"
        (self.shared / "mcp").mkdir(parents=True)
        (self.shared / "fde-toolkit/plugins/fde-core").mkdir(parents=True)
        (self.shared / "env.sh").write_text("# synthetic test environment\n")
        (self.shared / "env.sh").chmod(0o600)
        self.doctor = load_doctor()
        self.doctor.SHARED = self.shared

    def tearDown(self):
        self.tmp.cleanup()

    def write_configs(self, targets, generated=False):
        source = {
            "servers": {
                "atlassian": {
                    "transport": "http",
                    "url": "https://mcp.atlassian.com/v1/mcp/authv2",
                    "targets": targets,
                }
            }
        }
        (self.shared / "mcp/mcp-servers.json").write_text(json.dumps(source))
        generated_servers = {"atlassian": {"url": source["servers"]["atlassian"]["url"]}} \
            if generated else {}
        (self.shared / "fde-toolkit/plugins/fde-core/.mcp.json").write_text(
            json.dumps({"mcpServers": generated_servers})
        )

    def run_phase(self):
        responses = iter([
            (200, json.dumps({"results": [{"key": "ENG"}]})),
            (200, json.dumps({"displayName": "Test User"})),
        ])
        self.doctor.get = lambda *_args, **_kwargs: next(responses)
        self.doctor.fails = self.doctor.warns = 0
        env = {
            "CONFLUENCE_BASE_URL": "https://example.atlassian.net",
            "CONFLUENCE_EMAIL": "user@example.com",
            "CONFLUENCE_API_TOKEN": "not-a-real-token",
        }
        output = io.StringIO()
        with mock.patch.dict(os.environ, env, clear=False), contextlib.redirect_stdout(output):
            self.doctor.phase1()
        return output.getvalue()

    def test_run_scoped_atlassian_is_absent_from_global_config(self):
        self.write_configs(["role:orchestrator"], generated=False)
        output = self.run_phase()
        self.assertEqual(self.doctor.fails, 0, output)
        self.assertEqual(self.doctor.warns, 0, output)
        self.assertIn("endpoint verified", output)
        self.assertIn("correctly held out of global config", output)

    def test_run_scoped_atlassian_in_global_config_is_a_failure(self):
        self.write_configs(["role:orchestrator"], generated=True)
        output = self.run_phase()
        self.assertEqual(self.doctor.fails, 1, output)
        self.assertIn("leaked into the global config", output)


if __name__ == "__main__":
    unittest.main()
