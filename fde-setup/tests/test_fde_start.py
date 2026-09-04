"""Behavioral test for the interactive fde-start session handoff."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "claude-shared" / "bin" / "fde-start"
FDE = ROOT / "claude-shared" / "bin" / "fde"
MCP_SYNC = ROOT / "claude-shared" / "bin" / "mcp-sync"


class FdeStartTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.shared = self.home / ".claude-shared"
        self.profiles = self.home / ".claude-profiles"
        (self.shared / "bin").mkdir(parents=True)
        (self.shared / "config").mkdir(parents=True)
        (self.shared / "mcp").mkdir(parents=True)
        (self.shared / "fde-toolkit/plugins/fde-core").mkdir(parents=True)
        (self.profiles / "work").mkdir(parents=True)
        (self.profiles / "work" / ".credentials.json").write_text("{}")
        shutil.copy2(MCP_SYNC, self.shared / "bin/mcp-sync")
        shutil.copy2(
            ROOT / "claude-shared/config/agents.json",
            self.shared / "config/agents.json",
        )
        shutil.copy2(
            ROOT / "claude-shared/mcp/mcp-servers.json",
            self.shared / "mcp/mcp-servers.json",
        )
        (self.shared / "fde-toolkit/plugins/fde-core/.mcp.json").write_text(
            json.dumps({"mcpServers": {}})
        )

        self.log = self.root / "claude.log"
        self.count = self.root / "claude.count"
        self.stub = self.root / "claude-stub"
        self.stub.write_text(textwrap.dedent("""\
            #!/usr/bin/env bash
            set -euo pipefail
            count=0
            [[ -f "$FDE_TEST_COUNT" ]] && count=$(cat "$FDE_TEST_COUNT")
            count=$((count + 1))
            printf '%s\n' "$count" > "$FDE_TEST_COUNT"
            printf 'CALL %s\n' "$count" >> "$FDE_TEST_LOG"
            printf 'ARG=%s\n' "$@" >> "$FDE_TEST_LOG"
            if [[ "$count" == "1" ]]; then
              "$FDE_CONTROLLER" request "$FDE_RUN_ID" "research the checkout flow"
              "$FDE_CONTROLLER" plan "$FDE_RUN_ID" --require-approval \
                --stages intake,research
              "$FDE_CONTROLLER" roles "$FDE_RUN_ID" --set research=work \
                --set productManagement=none --set microsoftContext=none
              printf 'APPROVE PLAN %s\n' "$FDE_RUN_ID" | \
                "$FDE_CONTROLLER" approve-plan "$FDE_RUN_ID"
            fi
        """))
        self.stub.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def test_same_claude_session_resumes_with_run_scoped_mcp(self):
        env = dict(os.environ)
        env.update({
            "HOME": str(self.home),
            "CLAUDE_SHARED": str(self.shared),
            "CLAUDE_PROFILES_DIR": str(self.profiles),
            "FDE_RUNS_DIR": str(self.shared / "runs"),
            "FDE_CONTROLLER": str(FDE),
            "FDE_MCP_SYNC": str(self.shared / "bin/mcp-sync"),
            "FDE_CLAUDE_BIN": str(self.stub),
            "FDE_TEST_LOG": str(self.log),
            "FDE_TEST_COUNT": str(self.count),
        })
        result = subprocess.run(
            ["bash", str(LAUNCHER), "--orchestrator", "work",
             "--model", "opus", "--effort", "xhigh"],
            text=True, capture_output=True, env=env,
        )
        self.assertEqual(
            result.returncode, 0,
            msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        self.assertEqual(self.count.read_text().strip(), "2")
        log = self.log.read_text()
        self.assertIn("ARG=--session-id", log)
        self.assertIn("ARG=--resume", log)
        self.assertIn("ARG=--mcp-config", log)
        self.assertIn("ARG=--permission-mode", log)
        self.assertIn("ARG=auto", log)
        self.assertGreaterEqual(log.count("ARG=--model"), 2)
        self.assertGreaterEqual(log.count("ARG=opus"), 2)
        self.assertGreaterEqual(log.count("ARG=--effort"), 2)
        self.assertGreaterEqual(log.count("ARG=xhigh"), 2)
        runs = list((self.shared / "runs").iterdir())
        self.assertEqual(len(runs), 1)
        manifest = json.loads((runs[0] / "manifest.json").read_text())
        plan = json.loads((runs[0] / "plan.json").read_text())
        self.assertEqual(manifest["state"], "roles_confirmed")
        self.assertEqual(manifest["sessionConfig"], {"model": "opus", "effort": "xhigh"})
        self.assertIn("executionApprovedAt", plan)
        self.assertTrue((runs[0] / "mcp/claude-work.mcp.json").is_file())


if __name__ == "__main__":
    unittest.main()
