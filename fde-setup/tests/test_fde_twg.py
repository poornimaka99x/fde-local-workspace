"""Atlassian Teamwork Graph CLI (twg) under FDE's publication rules.

A stub `twg` records its argv; nothing reaches Atlassian or the network.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "claude-shared" / "lib"))

from test_fde import FDETest, REPO  # noqa: E402
import fde_twg  # noqa: E402

STUB_TWG = """#!/usr/bin/env bash
echo "ARGV=$* AGENT=${TWG_AGENT_DEFAULTS:-}" >> "$TWG_LOG"
[[ "$1" == "--version" ]] && echo "twg 1.4.0"
exit 0
"""
GUARD = REPO / "fde-toolkit" / "plugins" / "fde-core" / "bin" / "twg-guard.py"


class Classifier(unittest.TestCase):
    def kind(self, line):
        return [(d.kind, d.target) for _a, d in fde_twg.find_invocations(line)]

    def test_reads(self):
        for line in ("twg jira workitem get PROJ-1", "twg rovo search login",
                     "twg --profile work jira sprint list", "twg work query",
                     "TWG_AGENT_DEFAULTS=1 twg confluence content get 12"):
            self.assertEqual(self.kind(line)[0][0], "read", line)

    def test_writes_carry_their_target(self):
        self.assertEqual(self.kind("twg jira workitem create --summary x"), [("write", "jira")])
        self.assertEqual(self.kind("twg confluence content create --body b"),
                         [("write", "confluence")])
        self.assertEqual(self.kind("twg bitbucket pull-requests merge 3"),
                         [("write", "bitbucket")])

    def test_unknown_commands_fail_closed(self):
        self.assertEqual(self.kind("twg something new"), [("write", None)])
        self.assertEqual(self.kind("twg --weird-flag jira workitem get X"), [("write", None)])

    def test_credential_and_install_commands_are_operator_only(self):
        for line in ("twg env --export", "twg login --force", "twg setup", "twg uninstall"):
            self.assertEqual(self.kind(line)[0][0], "operator", line)

    def test_wrapped_and_nested_calls_are_found(self):
        self.assertEqual(self.kind('echo hi && bash -c "twg jira workitem transition P-1"'),
                         [("write", "jira")])
        self.assertEqual(self.kind("timeout 30 twg jira workitem delete P-1"), [("write", "jira")])
        with self.assertRaises(ValueError):
            fde_twg.find_invocations("echo $(twg jira workitem get P-1)")

    def test_mentions_are_not_calls(self):
        self.assertEqual(self.kind("grep twg README.md"), [])
        self.assertEqual(self.kind("fde twg --run r -- jira workitem create"), [])


class Governed(FDETest):
    def setUp(self):
        super().setUp()
        stub = self.sb.bindir / "twg"
        stub.write_text(STUB_TWG)
        stub.chmod(0o755)
        self.log = self.sb.tmp / "twg.log"
        self.log.write_text("")

    def twg(self, *args, **env):
        return self.sb.fde("twg", *args, TWG_LOG=str(self.log), **env)

    def confirmed_run(self):
        run_id = self.sb.start_full()
        self.assertEqual(self.sb.full_roles(run_id).returncode, 0)
        return run_id

    def approvals(self, run_id):
        return [json.loads(l) for l in
                (self.sb.run_dir(run_id) / "approvals.jsonl").read_text().splitlines() if l]

    def test_a_read_runs_with_agent_defaults(self):
        r = self.twg("--", "jira", "workitem", "get", "P-1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ARGV=jira workitem get P-1 AGENT=1", self.log.read_text())

    def test_a_write_outside_a_run_is_refused(self):
        r = self.twg("--", "jira", "workitem", "create", "--summary", "x")
        self.assertEqual(r.returncode, 7)
        self.assertEqual(self.log.read_text(), "")

    def test_operator_commands_never_run(self):
        r = self.twg("--", "env", "--export")
        self.assertEqual(r.returncode, 7)
        self.assertEqual(self.log.read_text(), "")

    def test_a_write_needs_and_consumes_one_approval_for_its_target(self):
        run_id = self.confirmed_run()
        write = ("--run", run_id, "--", "jira", "workitem", "create", "--summary", "x")
        r = self.twg(*write)
        self.assertEqual(r.returncode, 7)
        self.assertIn(f"fde approve-publish {run_id} jira", r.stderr)

        # Approving Confluence says nothing about Jira.
        self.sb.fde("approve-publish", run_id, "confluence", "--summary", "page",
                    stdin=f"APPROVE PUBLISH {run_id}\n")
        self.assertEqual(self.twg(*write).returncode, 7)

        r = self.sb.fde("approve-publish", run_id, "jira", "--summary", "1 story",
                        stdin=f"APPROVE PUBLISH {run_id}\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        r = self.twg(*write)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("workitem create", self.log.read_text())
        consumed = [a for a in self.approvals(run_id)
                    if a["type"] == "publication-approval-consumed"]
        self.assertEqual(len(consumed), 1)

        # One use.
        self.assertEqual(self.twg(*write).returncode, 7)
        events = (self.sb.run_dir(run_id) / "events.jsonl").read_text()
        self.assertIn('"tool": "twg"', events)

    def test_an_ungoverned_product_write_is_refused_even_in_a_run(self):
        run_id = self.confirmed_run()
        r = self.twg("--run", run_id, "--", "trello", "card", "create")
        self.assertEqual(r.returncode, 7)
        self.assertIn("not a publication target", r.stderr)

    def test_doctor_reports_twg(self):
        r = self.sb.fde("doctor", TWG_LOG=str(self.log))
        self.assertIn("Teamwork Graph CLI", r.stdout)
        self.assertIn("twg 1.4.0", r.stdout)


class Hook(FDETest):
    def hook(self, command, **env):
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": command}})
        return subprocess.run([sys.executable, str(GUARD)], input=payload,
                              capture_output=True, text=True, env=self.sb.env(**env))

    def test_reads_and_unrelated_commands_pass(self):
        self.assertEqual(self.hook("ls -la").returncode, 0)
        self.assertEqual(self.hook("twg jira workitem get P-1").returncode, 0)

    def test_writes_and_operator_commands_are_blocked(self):
        r = self.hook("twg confluence content create --body x", FDE_RUN_ID="r-1")
        self.assertEqual(r.returncode, 2)
        self.assertIn("fde twg --run r-1", r.stderr)
        self.assertIn("fde approve-publish r-1 confluence", r.stderr)
        self.assertEqual(self.hook("twg env --export").returncode, 2)
        self.assertEqual(self.hook("echo $(twg jira workitem get X)").returncode, 2)

    def test_reads_in_an_unconfirmed_run_are_blocked(self):
        run_id = self.sb.start_full()
        r = self.hook("twg jira workitem get P-1", FDE_RUN_ID=run_id)
        self.assertEqual(r.returncode, 2, r.stderr)

    def test_the_hook_is_registered(self):
        hooks = json.loads((GUARD.parent.parent / "hooks" / "hooks.json").read_text())
        commands = [h["command"] for entry in hooks["hooks"]["PreToolUse"]
                    if entry["matcher"] == "Bash" for h in entry["hooks"]]
        self.assertTrue(any("twg-guard.py" in c for c in commands))


if __name__ == "__main__":
    unittest.main()
