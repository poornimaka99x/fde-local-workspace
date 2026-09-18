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
        # mcp-sync reads the catalogue through the shared library; a sandbox
        # without it is a broken install, not a smaller one.
        shutil.copytree(ROOT / "claude-shared" / "lib", self.shared / "lib",
                        dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copy2(
            ROOT / "claude-shared/config/agents.json",
            self.shared / "config/agents.json",
        )
        shutil.copy2(
            ROOT / "claude-shared/config/provider-templates.json",
            self.shared / "config/provider-templates.json",
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
        # A raw string: the stub's own printf format needs a literal backslash-n,
        # and an interpreted one puts a real newline at column 0, which defeats
        # dedent and leaves the shebang indented. A stub with no usable shebang
        # is not the stub this test means to exercise — it silently became
        # whatever shell the caller's exec fallback chose.
        self.stub.write_text(textwrap.dedent(r"""
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
        """).lstrip("\n"))
        self.stub.chmod(0o755)

    def tearDown(self):
        self.tmp.cleanup()

    def test_same_claude_session_resumes_with_run_scoped_mcp(self):
        (self.shared / "config/capability-policy.json").write_text(json.dumps({
            "schemaVersion": 1,
            "disabled": ["skill:fde-core:crosscheck", "tool:WebSearch"],
        }))
        (self.profiles / "work" / "settings.json").write_text(json.dumps({
            "enabledPlugins": {"fde-core@fde-toolkit": True},
            "extraKnownMarketplaces": {
                "fde-toolkit": {"source": {
                    "source": "directory",
                    "path": str(self.shared / "fde-toolkit"),
                }},
            },
            "apiKeyHelper": "must-not-leak-into-the-run",
        }))
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
        self.assertIn("ARG=--settings", log)
        self.assertIn("ARG=--permission-mode", log)
        self.assertIn("ARG=auto", log)
        self.assertGreaterEqual(log.count("ARG=--disallowedTools"), 2)
        self.assertGreaterEqual(log.count("ARG=WebSearch"), 2)
        self.assertIn("skill:fde-core:crosscheck", log)
        self.assertGreaterEqual(log.count("ARG=--model"), 2)
        self.assertGreaterEqual(log.count("ARG=opus"), 2)
        self.assertGreaterEqual(log.count("ARG=--effort"), 2)
        self.assertGreaterEqual(log.count("ARG=xhigh"), 2)
        self.assertIn("controller does not yet have a recorded request", log)
        runs = list((self.shared / "runs").iterdir())
        self.assertEqual(len(runs), 1)
        manifest = json.loads((runs[0] / "manifest.json").read_text())
        plan = json.loads((runs[0] / "plan.json").read_text())
        self.assertEqual(manifest["state"], "roles_confirmed")
        self.assertEqual(manifest["sessionConfig"], {"model": "opus", "effort": "xhigh"})
        self.assertIn("executionApprovedAt", plan)
        self.assertTrue((runs[0] / "mcp/claude-work.mcp.json").is_file())
        self.assertTrue((runs[0] / "mcp/claude-work.settings.json").is_file())
        run_settings = json.loads(
            (runs[0] / "mcp/claude-work.settings.json").read_text())
        self.assertEqual(run_settings["enabledPlugins"],
                         {"fde-core@fde-toolkit": True})
        self.assertEqual(
            run_settings["extraKnownMarketplaces"]["fde-toolkit"]["source"]["path"],
            str(self.shared / "fde-toolkit"),
        )
        self.assertNotIn("apiKeyHelper", run_settings)

    def test_resume_uses_an_existing_recorded_request_without_asking_again(self):
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
        created = subprocess.run(
            [str(FDE), "start", "design a prototype from the supplied context",
             "--orchestrator", "work", "--model", "opus", "--effort", "high",
             "--json"],
            text=True, capture_output=True, env=env,
        )
        self.assertEqual(
            created.returncode, 0,
            msg=f"stdout:\n{created.stdout}\nstderr:\n{created.stderr}",
        )
        run_id = json.loads(created.stdout)["run"]["runId"]

        result = subprocess.run(
            ["bash", str(LAUNCHER), "--resume", run_id],
            text=True, capture_output=True, env=env,
        )
        self.assertEqual(
            result.returncode, 0,
            msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        log = self.log.read_text()
        self.assertIn("controller already has this run's request", log)
        self.assertIn("Do not ask me to repeat or re-record the request", log)
        self.assertNotIn("Hold an interactive scoping conversation. Ask for my request", log)

    def test_resume_replaces_a_session_id_claude_never_persisted(self):
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
        created = subprocess.run(
            [str(FDE), "start", "design a prototype", "--orchestrator", "work",
             "--shape", "design-panel", "--json"],
            text=True, capture_output=True, env=env, check=True,
        )
        run_id = json.loads(created.stdout)["run"]["runId"]
        roles = [
            str(FDE), "roles", run_id,
            "--set", "productManagement=none",
            "--set", "solutioning=work",
            "--set", "uiUxDesign=work",
            "--set", "designSystem=none",
            "--set", "review=work",
            "--set", "prReview=none",
            "--set", "standardsReview=none",
            "--set", "securityReview=none",
            "--set", "presentation=work",
            "--set", "microsoftContext=none",
        ]
        subprocess.run(roles, text=True, capture_output=True, env=env, check=True)

        stale = "11111111-2222-4333-8444-555555555555"
        run_dir = self.shared / "runs" / run_id
        (run_dir / "orchestrator-session-id").write_text(stale + "\n")
        (self.profiles / "work" / "projects").mkdir()
        # This run is already scoped, so the Claude stub only needs to accept
        # the fresh execution session; it must not rewrite the run.
        self.stub.write_text(textwrap.dedent(r"""
            #!/usr/bin/env bash
            set -euo pipefail
            printf 'ARG=%s\n' "$@" >> "$FDE_TEST_LOG"
        """).lstrip("\n"))
        self.stub.chmod(0o755)

        result = subprocess.run(
            ["bash", str(LAUNCHER), "--resume", run_id],
            text=True, capture_output=True, env=env,
        )
        self.assertEqual(
            result.returncode, 0,
            msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        new_id = (run_dir / "orchestrator-session-id").read_text().strip()
        self.assertNotEqual(new_id, stale)
        self.assertIn("was not persisted; starting a fresh session", result.stdout)
        log = self.log.read_text()
        self.assertIn("ARG=--session-id", log)
        self.assertIn(f"ARG={new_id}", log)
        self.assertNotIn("ARG=--resume", log)


if __name__ == "__main__":
    unittest.main()
