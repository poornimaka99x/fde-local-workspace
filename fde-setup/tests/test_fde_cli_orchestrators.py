"""Codex and Antigravity (Gemini) as orchestrators.

fde-start hands a non-Claude orchestrator to fde-start-cli, which runs exactly
the argv, environment and folder `fde session-launch` describes. These tests
check that description, and run the launcher against stub CLIs that record what
they were given. Nothing here reaches OpenAI, Google or a real sign-in.

  python3 -m unittest tests.test_fde_cli_orchestrators -v
"""
import json
import os
import pathlib
import shutil
import subprocess

from test_fde import FDETest, SRC_SHARED

RECORDER = """#!/usr/bin/env python3
import json, os, sys
with open(os.environ["STUB_LOG"], "a") as fh:
    fh.write(json.dumps({"argv": sys.argv[1:], "cwd": os.getcwd(),
                         "env": {k: v for k, v in os.environ.items()
                                 if k.startswith(("FDE_", "CODEX_", "HOME"))}}) + "\\n")
"""


class CliOrchestratorBase(FDETest):
    def setUp(self):
        super().setUp()
        self.log = self.sb.tmp / "stub.log"
        for name in ("codex", "agy"):
            stub = self.sb.bindir / name
            stub.write_text(RECORDER)
            stub.chmod(0o755)
        for name in ("fde-start", "fde-start-cli"):
            dst = self.sb.shared / "bin" / name
            shutil.copy2(SRC_SHARED / "bin" / name, dst)
            dst.chmod(0o755)
        # The shipped registry gains orchestration for Antigravity; a sandbox
        # copy of it is what these tests exercise.
        self.envkw = {"STUB_LOG": str(self.log),
                      "FDE_AGY_BIN": str(self.sb.bindir / "agy")}

    def fde(self, *args, **kw):
        return self.sb.fde(*args, **{**self.envkw, **kw})

    def plan(self, run_id, phase, **kw):
        r = self.fde("session-launch", run_id, "--phase", phase, "--json", **kw)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def start(self, orchestrator):
        r = self.fde("start", "ACME-301 orchestrate", "--orchestrator", orchestrator)
        self.assertEqual(r.returncode, 0, r.stderr)
        return next(l.split()[1] for l in r.stdout.splitlines() if l.startswith("run "))

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(l) for l in self.log.read_text().splitlines() if l]


class TestCodexPlan(CliOrchestratorBase):
    def test_scoping_runs_codex_sandboxed_to_the_run_folder(self):
        run_id = self.start("chatgpt_codex")
        run_dir = str(self.sb.run_dir(run_id))
        plan = self.plan(run_id, "scoping")
        argv = plan["argv"]
        self.assertEqual(argv[:7], ["codex", "-C", run_dir, "--sandbox", "workspace-write",
                                    "--ask-for-approval", "on-request"])
        self.assertEqual(plan["cwd"], run_dir)
        self.assertEqual(plan["env"]["FDE_RUN_ID"], run_id)
        # The working folder is never a writable root, and nothing bypasses
        # Codex's own approvals.
        self.assertNotIn("--add-dir", argv)
        self.assertNotIn("danger-full-access", argv)
        self.assertNotIn("never", argv)
        instructions = next(a for a in argv if a.startswith("developer_instructions="))
        text = json.loads(instructions.split("=", 1)[1])
        self.assertIn("APPROVE PLAN", text)
        self.assertIn("# Engage", text, "the /engage skill is inlined")
        self.assertIn("do not change it yourself", text)
        self.assertIn(f"APPROVE PLAN {run_id}", argv[-1])
        record = json.loads((self.sb.run_dir(run_id) / "orchestrator-session.json").read_text())
        self.assertEqual(record["agentId"], "chatgpt_codex")
        self.assertIn("startedAt", record)

    def test_execution_resumes_the_recorded_codex_session(self):
        run_id = self.start("chatgpt_codex")
        run_dir = self.sb.run_dir(run_id)
        self.plan(run_id, "scoping")
        sid = "019a7c1e-4b2d-7f00-9a3e-1c2d3e4f5a6b"
        rollout = self.sb.home / ".codex" / "sessions" / "2026" / "11" / "02" / \
            f"rollout-2026-11-02T10-00-00-{sid}.jsonl"
        rollout.parent.mkdir(parents=True)
        rollout.write_text(json.dumps({"timestamp": "2026-11-02T10:00:00Z",
                                       "type": "session_meta",
                                       "payload": {"id": sid, "cwd": str(run_dir)}}) + "\n")
        plan = self.plan(run_id, "execution")
        self.assertEqual(plan["argv"][:2], ["codex", "resume"])
        self.assertEqual(plan["argv"][-2], sid)
        self.assertIn("approved", plan["argv"][-1])
        self.assertEqual((run_dir / "orchestrator-session-id").read_text().strip(), sid)
        session = json.loads(self.fde("status", run_id, "--json").stdout)["session"]
        self.assertTrue(session["resumable"])
        self.assertEqual(session["sessionId"], sid)

    def test_a_session_in_another_folder_is_not_taken_for_this_run(self):
        run_id = self.start("chatgpt_codex")
        self.plan(run_id, "scoping")
        rollout = self.sb.home / ".codex" / "sessions" / "rollout-x-other.jsonl"
        rollout.parent.mkdir(parents=True)
        rollout.write_text(json.dumps({"type": "session_meta",
                                       "payload": {"id": "other-session",
                                                   "cwd": str(self.sb.outside)}}) + "\n")
        plan = self.plan(run_id, "execution")
        self.assertIn("--last", plan["argv"])
        self.assertNotIn("other-session", plan["argv"])
        self.assertTrue(plan["notices"])

    def test_dry_run_records_nothing(self):
        run_id = self.start("chatgpt_codex")
        r = self.fde("session-launch", run_id, "--phase", "scoping", "--json", "--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse((self.sb.run_dir(run_id) / "orchestrator-session.json").exists())

    def test_a_claude_orchestrator_is_not_handled_here(self):
        run_id = self.start("claude_alt")
        r = self.fde("session-launch", run_id, "--phase", "scoping", "--json")
        self.assertEqual(r.returncode, 2)
        self.assertIn("fde-start launches Claude itself", r.stderr)


class TestAntigravityPlan(CliOrchestratorBase):
    def test_antigravity_uses_the_run_folder_as_its_workspace(self):
        run_id = self.start("gemini")
        plan = self.plan(run_id, "scoping")
        self.assertTrue(plan["argv"][0].endswith("ask-gemini"))
        self.assertEqual(plan["argv"][1:3], ["--orchestrate", "--"])
        self.assertEqual(plan["env"]["FDE_GEMINI_WORKSPACE"], str(self.sb.run_dir(run_id)))
        self.assertEqual(plan["env"]["FDE_GEMINI_ACCOUNT_DIR"], "")
        self.assertIn("# Engage", plan["argv"][-1])
        later = self.plan(run_id, "execution")
        self.assertEqual(later["argv"][1:4], ["--orchestrate", "--continue", "--"])
        session = json.loads(self.fde("status", run_id, "--json").stdout)["session"]
        self.assertTrue(session["resumable"])

    def test_a_gemini_api_account_cannot_orchestrate(self):
        self.fde("accounts", "add", "--provider", "gemini-api", "--name", "personal")
        r = self.fde("start", "ACME-302", "--orchestrator", "geminiapi_personal")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("cannot orchestrate", r.stderr)


class TestLauncher(CliOrchestratorBase):
    def test_fde_start_hands_a_codex_run_to_the_cli_launcher(self):
        run_id = self.start("chatgpt_codex")
        r = subprocess.run([str(self.sb.shared / "bin" / "fde-start"), "--resume", run_id],
                           capture_output=True, text=True, stdin=subprocess.DEVNULL,
                           env=self.sb.env(**self.envkw), cwd=str(self.sb.tmp), timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("not approved yet", r.stdout)
        calls = self.calls()
        self.assertEqual(len(calls), 1, "scoping ran once; execution waits for approval")
        self.assertEqual(calls[0]["cwd"], str(self.sb.run_dir(run_id)))
        self.assertEqual(calls[0]["env"]["FDE_RUN_ID"], run_id)
        self.assertEqual(calls[0]["argv"][:2], ["-C", str(self.sb.run_dir(run_id))])

    def test_ask_gemini_orchestrate_runs_agy_interactively_and_continues(self):
        run_id = self.start("gemini")
        for phase in ("scoping", "execution"):
            plan = self.plan(run_id, phase)
            env = self.sb.env(**self.envkw)
            env.update(plan["env"])
            r = subprocess.run(plan["argv"], capture_output=True, text=True,
                               stdin=subprocess.DEVNULL, env=env, cwd=plan["cwd"], timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
        first, second = self.calls()
        self.assertEqual(first["cwd"], str(self.sb.run_dir(run_id)))
        self.assertIn("-i", first["argv"])
        self.assertNotIn("--continue", first["argv"])
        self.assertIn("--continue", second["argv"])
        for call in (first, second):
            self.assertNotIn("-p", call["argv"])
            self.assertNotIn("--dangerously-skip-permissions", call["argv"])

    def test_ask_gemini_orchestrate_is_refused_when_called_directly(self):
        r = subprocess.run([str(self.sb.shared / "bin" / "ask-gemini"), "--orchestrate",
                            "--", "hello"], capture_output=True, text=True,
                           env=self.sb.env(**self.envkw), timeout=30)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("started by fde-start", r.stderr)
