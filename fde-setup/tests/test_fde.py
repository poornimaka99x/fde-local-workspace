#!/usr/bin/env python3
"""Acceptance tests for the FDE toolkit.

Every test runs against a throwaway HOME containing a synthetic install. Nothing
here reads or writes ~/.claude-shared, ~/.claude-profiles, ~/.codex, ~/.gemini or
~/.copilot. A stub `codex` on PATH records its argv and working directory, so the
approval gate can be exercised deterministically and offline; where a real codex
binary exists, the sandbox tests additionally run against it.

  python3 -m unittest discover -s tests -v
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
SRC_SHARED = REPO / "claude-shared"
REAL_CODEX = shutil.which("codex")

STUB_CODEX = """#!/usr/bin/env bash
# Stub Codex. Records how it was called, then behaves like the sandbox it was
# told to use: read-only refuses to write, workspace-write writes only under cwd.
{
  echo "CWD=$PWD"
  echo "ARGV=$*"
} >> "$CODEX_LOG"

sandbox="unset"
prev=""
for a in "$@"; do
  [[ "$prev" == "--sandbox" ]] && sandbox="$a"
  prev="$a"
done

if [[ -n "${CODEX_TRY_WRITE:-}" ]]; then
  if [[ "$sandbox" == "read-only" ]]; then
    echo "sandbox read-only: refusing to write $CODEX_TRY_WRITE" >&2
    exit 1
  fi
  case "$CODEX_TRY_WRITE" in
    "$PWD"/*) echo "written by codex" > "$CODEX_TRY_WRITE" ;;
    *) echo "sandbox workspace-write: $CODEX_TRY_WRITE is outside $PWD" >&2; exit 1 ;;
  esac
fi
echo "stub codex ok"
"""


class Sandbox:
    """A synthetic install under a temporary HOME."""

    def __init__(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="fde-test-"))
        self.home = self.tmp / "home"
        self.shared = self.home / ".claude-shared"
        self.profiles = self.home / ".claude-profiles"
        self.bindir = self.tmp / "bin"
        self.repo = self.tmp / "workrepo"
        self.outside = self.tmp / "elsewhere"
        for d in (self.shared / "bin", self.shared / "config", self.shared / "mcp",
                  self.shared / "runs", self.shared / "fde-toolkit/plugins/fde-core",
                  self.bindir, self.repo, self.outside):
            d.mkdir(parents=True, exist_ok=True)

        for name in ("fde", "ask-codex", "mcp-sync", "ask-ms-copilot", "ask-copilot"):
            dst = self.shared / "bin" / name
            shutil.copy2(SRC_SHARED / "bin" / name, dst)
            dst.chmod(0o755)
        shutil.copy2(SRC_SHARED / "config/agents.json", self.shared / "config/agents.json")
        shutil.copy2(SRC_SHARED / "mcp/mcp-servers.json", self.shared / "mcp/mcp-servers.json")

        for p in ("work", "msc", "alt", "bedrock"):
            d = self.profiles / p
            d.mkdir(parents=True, exist_ok=True)
            (d / ".credentials.json").write_text("{}")
        (self.profiles / "bedrock" / "settings.json").write_text(json.dumps(
            {"env": {"AWS_PROFILE": "bedrock-dev", "AWS_REGION": "eu-west-1"}}, indent=2))

        stub = self.bindir / "codex"
        stub.write_text(STUB_CODEX)
        stub.chmod(0o755)
        self.codex_log = self.tmp / "codex.log"
        self.codex_log.write_text("")

    # -- plumbing
    def env(self, **extra):
        e = dict(os.environ)
        e.update({
            "HOME": str(self.home),
            "CLAUDE_SHARED": str(self.shared),
            "CLAUDE_PROFILES_DIR": str(self.profiles),
            "FDE_RUNS_DIR": str(self.shared / "runs"),
            "PATH": f"{self.bindir}:{self.shared / 'bin'}:{os.environ['PATH']}",
            "CODEX_LOG": str(self.codex_log),
        })
        for k in ("CONFLUENCE_BASE_URL", "CONFLUENCE_EMAIL", "CONFLUENCE_API_TOKEN",
                  "COPILOT_DIRECTLINE_SECRET", "COPILOT_TOKEN_ENDPOINT"):
            e.pop(k, None)
        e.update({k: v for k, v in extra.items() if v is not None})
        return e

    def fde(self, *args, stdin="", **envkw):
        return subprocess.run([sys.executable, str(self.shared / "bin" / "fde"), *args],
                              input=stdin, capture_output=True, text=True,
                              env=self.env(**envkw), cwd=str(self.tmp))

    def sh(self, script, **envkw):
        return subprocess.run(["bash", "-c", script], capture_output=True, text=True,
                              env=self.env(**envkw), cwd=str(self.tmp))

    def ask_codex(self, *args, **envkw):
        return subprocess.run([str(self.shared / "bin" / "ask-codex"), *args],
                              capture_output=True, text=True, env=self.env(**envkw),
                              cwd=str(self.tmp))

    def codex_calls(self):
        return self.codex_log.read_text()

    def start(self, requirement="MAX-142 returns orchestration"):
        r = self.fde("start", requirement)
        assert r.returncode == 0, r.stderr
        return next(l.split()[1] for l in r.stdout.splitlines() if l.startswith("run "))

    def full_roles(self, run_id, **overrides):
        base = {
            "orchestrator": "claude_alt", "research": "claude_work",
            "solutioning": "claude_work", "review": "claude_msc",
            "deliveryPlanning": "claude_alt", "presentation": "claude_work",
            "implementation": "claude_work", "microsoftContext": "none",
        }
        base.update(overrides)
        args = []
        for k, v in base.items():
            args += ["--set", f"{k}={v}"]
        return self.fde("roles", run_id, *args)

    def advance_to(self, run_id, target):
        order = ["intake", "research", "solutioning", "review", "reconciliation",
                 "planning", "awaiting_implementation_approval", "implementation",
                 "verification", "awaiting_publication_approval", "complete"]
        for s in order:
            r = self.fde("resume", run_id, "--advance", s)
            assert r.returncode == 0, r.stderr
            if s == target:
                return

    def run_dir(self, run_id):
        return self.shared / "runs" / run_id

    def destroy(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class FDETest(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()

    def tearDown(self):
        self.sb.destroy()


# -- 18. All tests run using a temporary home directory ----------------------

class TestIsolation(FDETest):
    def test_temporary_home_only(self):
        """18. Nothing touches the real user configuration."""
        env = self.sb.env()
        self.assertTrue(env["HOME"].startswith(str(self.sb.tmp)))
        self.assertNotEqual(env["HOME"], os.path.expanduser("~"))
        self.sb.start()
        real = pathlib.Path(os.path.expanduser("~/.claude-shared/runs"))
        if real.exists():
            self.assertFalse(any(p.name.startswith("fde-test") for p in real.iterdir()))


# -- 1, 2, 3. Roles are asked, asked again, and unconstrained by identity ----

class TestRoles(FDETest):
    def test_start_asks_for_roles_before_any_access(self):
        """1. Starting a task asks for roles before any connector or repo access."""
        r = self.sb.fde("start", "MAX-1 do a thing")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Before I initialize this task, assign the roles.", r.stdout)
        for identity in ("Claude: work", "Claude: msc", "Claude: alt",
                         "Claude Code: Bedrock", "ChatGPT/Codex", "Gemini",
                         "Microsoft Copilot"):
            self.assertIn(identity, r.stdout)
        self.assertIn("I will not initialize the task or access connected systems "
                      "until you confirm.", r.stdout)

        run_id = next(l.split()[1] for l in r.stdout.splitlines() if l.startswith("run "))
        m = json.loads((self.sb.run_dir(run_id) / "manifest.json").read_text())
        self.assertEqual(m["state"], "awaiting_roles")
        self.assertFalse((self.sb.run_dir(run_id) / "roles.json").exists())

    def test_no_access_before_roles_confirmed(self):
        """1. The guard actually refuses, it is not only documentation."""
        run_id = self.sb.start()
        for args in (("guard", run_id, "--activity", "reading Jira"),
                     ("invoke", run_id, "claude_work", "requirement.md"),
                     ("approve-publish", run_id, "jira"),
                     ("resume", run_id, "--advance", "intake")):
            r = self.sb.fde(*args)
            self.assertNotEqual(r.returncode, 0, f"{args} should have been refused")
            self.assertIn("not confirmed", r.stderr + r.stdout)

    def test_second_task_asks_again(self):
        """2. A second run asks again and inherits nothing."""
        first = self.sb.start("MAX-1 first")
        self.assertEqual(self.sb.full_roles(first).returncode, 0)
        second = self.sb.start("MAX-2 second")
        self.assertFalse((self.sb.run_dir(second) / "roles.json").exists())
        m = json.loads((self.sb.run_dir(second) / "manifest.json").read_text())
        self.assertEqual(m["state"], "awaiting_roles")
        r = self.sb.fde("resume", second)
        self.assertIn("Before I initialize this task", r.stdout)
        self.assertIn("do not reuse the previous run's roles", r.stdout)

    def test_same_as_requires_explicit_flag(self):
        """2. 'Same as last time' only happens when the user says so."""
        first = self.sb.start("MAX-1 first")
        self.sb.full_roles(first, orchestrator="claude_msc")
        second = self.sb.start("MAX-2 second")
        r = self.sb.fde("roles", second, "--same-as", first)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads((self.sb.run_dir(second) / "roles.json").read_text())
                         ["assignments"]["orchestrator"], "claude_msc")

    def test_any_identity_in_any_supported_role(self):
        """3. Identity does not imply role."""
        combos = [
            {"orchestrator": "claude_work", "research": "gemini", "solutioning": "chatgpt_codex",
             "review": "claude_msc", "implementation": "chatgpt_codex"},
            {"orchestrator": "claude_bedrock", "research": "chatgpt_codex",
             "solutioning": "claude_msc", "review": "gemini", "implementation": "claude_alt"},
            {"orchestrator": "claude_msc", "research": "claude_bedrock,gemini",
             "solutioning": "claude_alt", "review": "chatgpt_codex,claude_work",
             "implementation": "claude_bedrock"},
        ]
        for combo in combos:
            run_id = self.sb.start("MAX-9 role matrix")
            r = self.sb.full_roles(run_id, **combo)
            # --allow-unavailable: availability is a separate concern from legality
            if r.returncode != 0:
                args = []
                for k, v in {**{"deliveryPlanning": "claude_alt",
                                "presentation": "claude_work",
                                "microsoftContext": "none"}, **combo}.items():
                    args += ["--set", f"{k}={v}"]
                r = self.sb.fde("roles", run_id, *args, "--allow-unavailable")
            self.assertEqual(r.returncode, 0, f"{combo}: {r.stderr}")

    def test_unavailable_identity_stops_and_asks(self):
        """Assigning something that is not installed stops the run."""
        shutil.rmtree(self.sb.profiles / "msc")
        run_id = self.sb.start()
        r = self.sb.full_roles(run_id, review="claude_msc")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Choose a replacement", r.stderr)
        self.assertFalse((self.sb.run_dir(run_id) / "roles.json").exists())

    def test_agents_json_carries_no_roles(self):
        """3. The registry describes identities, never who does what."""
        data = json.loads((SRC_SHARED / "config/agents.json").read_text())
        for aid, a in data["agents"].items():
            for banned in ("role", "defaultRole", "preferred", "default"):
                self.assertNotIn(banned, a, f"{aid} declares {banned}")

    def test_agent_may_only_act_in_an_assigned_role(self):
        run_id = self.sb.start()
        self.sb.full_roles(run_id, research="claude_work", review="claude_msc")
        self.sb.advance_to(run_id, "research")
        task = self.sb.run_dir(run_id) / "tasks/t.md"
        task.write_text("look into it")
        r = self.sb.fde("invoke", run_id, "claude_msc", str(task), "--dry-run")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("does not cover the 'research' stage", r.stderr)
        r = self.sb.fde("invoke", run_id, "claude_bedrock", str(task), "--dry-run")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("holds no role", r.stderr)


# -- 4, 5. One Copilot, and it is the Microsoft one --------------------------

class TestCopilotSeparation(FDETest):
    def test_only_microsoft_copilot_is_offered(self):
        """4. Microsoft Copilot is the only Copilot shown."""
        r = self.sb.fde("start", "MAX-3 copilot check")
        self.assertIn("Microsoft Copilot", r.stdout)
        self.assertNotIn("GitHub", r.stdout)
        agents = json.loads((SRC_SHARED / "config/agents.json").read_text())["agents"]
        copilots = [a["label"] for a in agents.values() if "opilot" in a["label"]]
        self.assertEqual(copilots, ["Microsoft Copilot"])
        self.assertEqual(agents["microsoft_copilot"]["kind"], "copilot-studio")

    def test_ask_copilot_is_a_stub(self):
        r = subprocess.run([str(self.sb.shared / "bin" / "ask-copilot"), "anything"],
                           capture_output=True, text=True, env=self.sb.env())
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("GitHub Copilot is not part of this FDE ecosystem.", r.stderr)
        self.assertIn("Use ask-ms-copilot for Microsoft 365 context.", r.stderr)

    def test_mcp_sync_never_touches_dot_copilot(self):
        """5. mcp-sync does not touch ~/.copilot."""
        copilot_dir = self.sb.home / ".copilot"
        copilot_dir.mkdir()
        marker = copilot_dir / "mcp-config.json"
        marker.write_text('{"mine": true}')
        before = marker.stat().st_mtime_ns
        r = subprocess.run([sys.executable, str(self.sb.shared / "bin" / "mcp-sync")],
                           capture_output=True, text=True, env=self.sb.env())
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(marker.read_text(), '{"mine": true}')
        self.assertEqual(marker.stat().st_mtime_ns, before)
        self.assertEqual(sorted(p.name for p in copilot_dir.iterdir()), ["mcp-config.json"])
        self.assertIn("not part of this ecosystem", r.stdout)

    def test_ms_copilot_reads_no_secret_from_a_bare_environment(self):
        r = subprocess.run([sys.executable, str(self.sb.shared / "bin" / "ask-ms-copilot"),
                            "--check"], capture_output=True, text=True, env=self.sb.env())
        self.assertEqual(r.returncode, 1)
        self.assertIn("unconfigured", r.stdout)
        self.assertIn("fde-copilot-directline", r.stdout)

    def test_ms_copilot_check_never_prints_the_secret(self):
        secret = "s3cr3t-directline-value"
        r = subprocess.run([sys.executable, str(self.sb.shared / "bin" / "ask-ms-copilot"),
                            "--check"], capture_output=True, text=True,
                           env=self.sb.env(COPILOT_DIRECTLINE_SECRET=secret))
        self.assertEqual(r.returncode, 0)
        self.assertNotIn(secret, r.stdout + r.stderr)
        self.assertIn("Move it to the Keychain", r.stdout)


# -- 6..11. The Codex gate ---------------------------------------------------

class TestCodexGate(FDETest):
    def _ready(self, stage="implementation"):
        run_id = self.sb.start("MAX-4 codex gate")
        r = self.sb.full_roles(run_id, implementation="chatgpt_codex",
                               solutioning="chatgpt_codex")
        if r.returncode != 0:      # codex CLI is a stub, availability aside
            args = []
            for k, v in {"orchestrator": "claude_alt", "research": "claude_work",
                         "solutioning": "chatgpt_codex", "review": "claude_msc",
                         "deliveryPlanning": "claude_alt", "presentation": "claude_work",
                         "implementation": "chatgpt_codex",
                         "microsoftContext": "none"}.items():
                args += ["--set", f"{k}={v}"]
            r = self.sb.fde("roles", run_id, *args, "--allow-unavailable")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.sb.advance_to(run_id, "awaiting_implementation_approval")
        task = self.sb.run_dir(run_id) / "tasks" / "impl.md"
        task.write_text("Add a failing test for issue 412\n")
        return run_id, task

    def _approve(self, run_id, task, extra=(), ttl=None):
        args = ["approve-codex", run_id, "implementation", "--task-file", str(task),
                "--repo", str(self.sb.repo), *extra]
        if ttl is not None:
            args += ["--ttl", str(ttl)]
        return self.sb.fde(*args, stdin=f"APPROVE CODEX {run_id}\n")

    def test_read_only_cannot_modify_a_test_file(self):
        """6. Codex read-only mode cannot modify a test file."""
        victim = self.sb.repo / "canary.txt"
        victim.write_text("original")
        r = self.sb.ask_codex("--read-only", "have a look",
                              CODEX_TRY_WRITE=str(victim))
        self.assertEqual(victim.read_text(), "original")
        self.assertIn("--sandbox read-only", self.sb.codex_calls())
        self.assertIn("refusing to write", r.stderr)

    def test_read_only_argv_is_bounded(self):
        self.sb.ask_codex("--read-only", "hello")
        calls = self.sb.codex_calls()
        self.assertIn("--sandbox read-only", calls)
        self.assertIn("--ask-for-approval never", calls)

    def test_write_refuses_without_approval(self):
        """7. Codex write mode refuses to start without approval."""
        run_id, task = self._ready()
        r = self.sb.ask_codex("--write", "--run", run_id, "--stage", "implementation",
                              "--task-file", str(task))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no Codex write approval on record", r.stderr)
        self.assertEqual(self.sb.codex_calls(), "")

    def test_assigning_codex_is_not_approval(self):
        """7. Holding the implementation role authorises nothing on its own."""
        run_id, task = self._ready()
        roles = json.loads((self.sb.run_dir(run_id) / "roles.json").read_text())
        self.assertEqual(roles["assignments"]["implementation"], "chatgpt_codex")
        r = self.sb.ask_codex("--write", "--run", run_id, "--stage", "implementation",
                              "--task-file", str(task))
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.sb.codex_calls(), "")

    def test_wrong_confirmation_phrase_records_nothing(self):
        run_id, task = self._ready()
        r = self.sb.fde("approve-codex", run_id, "implementation", "--task-file",
                        str(task), "--repo", str(self.sb.repo), stdin="yes ok\n")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("did not match", r.stderr)
        self.assertFalse((self.sb.run_dir(run_id) / "approvals.jsonl").exists())

    def test_approval_shows_the_user_what_they_are_approving(self):
        run_id, task = self._ready()
        r = self._approve(run_id, task, extra=["--commands", "pytest -q"])
        self.assertEqual(r.returncode, 0, r.stderr)
        for expected in (run_id, str(self.sb.repo), "Writable root", "Branch",
                         "Task sha256", "Network", "pytest -q", "workspace-write"):
            self.assertIn(expected, r.stdout)

    def test_write_runs_once_and_is_bounded(self):
        run_id, task = self._ready()
        self.assertEqual(self._approve(run_id, task).returncode, 0)
        target = self.sb.repo / "new.txt"
        r = self.sb.ask_codex("--write", "--run", run_id, "--stage", "implementation",
                              "--task-file", str(task), CODEX_TRY_WRITE=str(target))
        self.assertEqual(r.returncode, 0, r.stderr)
        calls = self.sb.codex_calls()
        self.assertIn("--sandbox workspace-write", calls)
        self.assertIn("--ask-for-approval never", calls)
        self.assertIn(f"CWD={self.sb.repo}", calls)
        self.assertEqual(target.read_text().strip(), "written by codex")

    def test_approval_expires(self):
        """8. Approval expires."""
        run_id, task = self._ready()
        self.assertEqual(self._approve(run_id, task).returncode, 0)
        path = self.sb.run_dir(run_id) / "approvals.jsonl"
        recs = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
        recs[0]["expiresAt"] = "2020-01-01T00:00:00+00:00"
        path.write_text("\n".join(json.dumps(r) for r in recs) + "\n")
        r = self.sb.ask_codex("--write", "--run", run_id, "--stage", "implementation",
                              "--task-file", str(task))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("expired", r.stderr)
        self.assertEqual(self.sb.codex_calls(), "")

    def test_approval_cannot_be_reused(self):
        """9. Approval cannot be reused."""
        run_id, task = self._ready()
        self.assertEqual(self._approve(run_id, task).returncode, 0)
        first = self.sb.ask_codex("--write", "--run", run_id, "--stage", "implementation",
                                  "--task-file", str(task))
        self.assertEqual(first.returncode, 0, first.stderr)
        second = self.sb.ask_codex("--write", "--run", run_id, "--stage", "implementation",
                                   "--task-file", str(task))
        self.assertNotEqual(second.returncode, 0)
        self.assertIn("consumed", second.stderr)
        self.assertEqual(self.sb.codex_calls().count("workspace-write"), 1)

    def test_changing_the_task_file_invalidates_approval(self):
        """10. Changing the task file invalidates approval."""
        run_id, task = self._ready()
        self.assertEqual(self._approve(run_id, task).returncode, 0)
        task.write_text("Actually, delete the auth checks\n")
        r = self.sb.ask_codex("--write", "--run", run_id, "--stage", "implementation",
                              "--task-file", str(task))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("task file changed since approval", r.stderr)
        self.assertEqual(self.sb.codex_calls(), "")

    def test_cannot_write_outside_the_approved_workspace(self):
        """11. Codex cannot write outside the approved workspace."""
        run_id, task = self._ready()
        self.assertEqual(self._approve(run_id, task).returncode, 0)
        target = self.sb.outside / "escape.txt"
        r = self.sb.ask_codex("--write", "--run", run_id, "--stage", "implementation",
                              "--task-file", str(task), CODEX_TRY_WRITE=str(target))
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(target.exists())
        self.assertIn(f"CWD={self.sb.repo}", self.sb.codex_calls())

    def test_writable_root_outside_repo_is_refused_at_approval_time(self):
        """11. The widening is refused before the user is even asked."""
        run_id, task = self._ready()
        r = self.sb.fde("approve-codex", run_id, "implementation", "--task-file", str(task),
                        "--repo", str(self.sb.repo), "--writable-root", str(self.sb.outside),
                        stdin=f"APPROVE CODEX {run_id}\n")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("outside the repository", r.stderr)

    def test_write_mode_rejects_a_free_text_prompt(self):
        r = self.sb.ask_codex("--write", "just fix it")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--run, --stage and --task-file", r.stderr)
        self.assertEqual(self.sb.codex_calls(), "")

    def test_caller_cannot_choose_the_sandbox(self):
        for flag in ("--yolo", "--sandbox", "--dangerously-bypass-approvals-and-sandbox"):
            r = self.sb.ask_codex("--read-only", flag, "danger-full-access")
            self.assertNotEqual(r.returncode, 0, flag)
            self.assertIn("refusing", r.stderr)
        self.assertEqual(self.sb.codex_calls(), "")


# -- 12. No bypass flags anywhere -------------------------------------------

class TestNoBypassFlags(unittest.TestCase):
    FORBIDDEN = ("--yolo", "danger-full-access",
                 "--dangerously-bypass-approvals-and-sandbox")
    EXEMPT = "fde-safety-exempt"

    def test_no_command_uses_a_sandbox_bypass(self):
        """12. No command uses --yolo or danger-full-access."""
        roots = [REPO / "claude-shared", REPO / "fde-toolkit", REPO / "shell",
                 REPO / "install.sh"]
        hits = []
        for root in roots:
            files = [root] if root.is_file() else [p for p in root.rglob("*") if p.is_file()]
            for p in files:
                if p.suffix in (".pyc",) or "/.git/" in str(p):
                    continue
                for n, line in enumerate(p.read_text(errors="ignore").splitlines(), 1):
                    if self.EXEMPT in line:
                        continue
                    for flag in self.FORBIDDEN:
                        if flag in line:
                            hits.append(f"{p.relative_to(REPO)}:{n}: {line.strip()[:70]}")
        self.assertEqual(hits, [], "sandbox-bypass flags found:\n" + "\n".join(hits))

    def test_doctor_would_fail_if_one_appeared(self):
        sb = Sandbox()
        try:
            bad = sb.shared / "bin" / "rogue.sh"
            bad.write_text("#!/bin/bash\ncodex exec --yolo 'do anything'\n")
            r = sb.fde("doctor")
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("Codex flag safety", r.stdout)
            self.assertIn("BROKEN", r.stdout)
        finally:
            sb.destroy()


# -- 13. Bedrock -------------------------------------------------------------

class TestBedrock(unittest.TestCase):
    def test_wrapper_sets_no_aws_variables(self):
        """13. Bedrock uses bedrock-dev and eu-west-1, from one place."""
        src = (REPO / "shell/claude-profiles.sh").read_text()
        body = src.split("cc-bedrock()", 1)[1].split("\n}", 1)[0]
        self.assertNotIn("AWS_PROFILE", body)
        self.assertNotIn("AWS_REGION", body)
        self.assertNotIn("MAXEDA_AWS", body)
        self.assertIn("CLAUDE_CODE_USE_BEDROCK=1", body)

    def test_example_env_declares_no_aws_defaults(self):
        text = (REPO / "claude-shared/env.sh.example").read_text()
        self.assertNotIn('export MAXEDA_AWS_PROFILE', text)
        self.assertNotIn('export AWS_PROFILE', text)
        self.assertNotIn("eu-central-1", text)

    def test_profile_creation_writes_the_right_account_and_region(self):
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="fde-bedrock-"))
        try:
            env = dict(os.environ, HOME=str(tmp), CLAUDE_SHARED=str(tmp / ".claude-shared"))
            for name in ("bedrock", "work"):
                r = subprocess.run(["bash", str(REPO / "shell/claude-profile-new"), name],
                                   capture_output=True, text=True, env=env)
                self.assertEqual(r.returncode, 0, r.stderr)
            b = json.loads((tmp / ".claude-profiles/bedrock/settings.json").read_text())
            self.assertEqual(b["env"]["AWS_PROFILE"], "bedrock-dev")
            self.assertEqual(b["env"]["AWS_REGION"], "eu-west-1")
            w = json.loads((tmp / ".claude-profiles/work/settings.json").read_text())
            self.assertNotIn("env", w, "AWS settings leaked into a subscription profile")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_doctor_reports_disagreement_as_broken(self):
        sb = Sandbox()
        try:
            (sb.profiles / "bedrock" / "settings.json").write_text(json.dumps(
                {"env": {"AWS_PROFILE": "maxeda", "AWS_REGION": "eu-central-1"}}))
            r = sb.fde("doctor")
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("expected bedrock-dev", r.stdout)
            self.assertIn("expected eu-west-1", r.stdout)
        finally:
            sb.destroy()

    def test_doctor_prints_no_credential_values(self):
        sb = Sandbox()
        try:
            r = sb.fde("doctor", CONFLUENCE_API_TOKEN="ATATT-super-secret",
                       COPILOT_DIRECTLINE_SECRET="dl-super-secret")
            self.assertNotIn("ATATT-super-secret", r.stdout + r.stderr)
            self.assertNotIn("dl-super-secret", r.stdout + r.stderr)
        finally:
            sb.destroy()


# -- 14. Atlassian -----------------------------------------------------------

class TestAtlassian(FDETest):
    ENDPOINT = "https://mcp.atlassian.com/v1/mcp/authv2"

    def test_current_endpoint_over_http(self):
        """14. Atlassian uses the current endpoint."""
        src = json.loads((SRC_SHARED / "mcp/mcp-servers.json").read_text())
        a = src["servers"]["atlassian"]
        self.assertEqual(a["url"], self.ENDPOINT)
        self.assertEqual(a["transport"], "http")
        urls = [s.get("url", "") for s in src["servers"].values()]
        self.assertFalse(any("/v1/sse" in u for u in urls), urls)

    def test_no_permanently_privileged_orchestrator(self):
        src = json.loads((SRC_SHARED / "mcp/mcp-servers.json").read_text())
        self.assertEqual(src["servers"]["atlassian"]["targets"], ["role:orchestrator"])
        r = subprocess.run([sys.executable, str(self.sb.shared / "bin" / "mcp-sync")],
                           capture_output=True, text=True, env=self.sb.env())
        self.assertEqual(r.returncode, 0, r.stderr)
        global_cfg = (self.sb.shared / "fde-toolkit/plugins/fde-core/.mcp.json").read_text()
        self.assertNotIn("atlassian", global_cfg)
        self.assertIn("context7", global_cfg)

    def test_connector_wired_only_after_roles_and_only_to_the_orchestrator(self):
        run_id = self.sb.start()
        r = subprocess.run([sys.executable, str(self.sb.shared / "bin" / "mcp-sync"),
                            "--run", run_id], capture_output=True, text=True,
                           env=self.sb.env())
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no confirmed roles", r.stderr)

        self.assertEqual(self.sb.full_roles(run_id, orchestrator="claude_alt").returncode, 0)
        mcp_dir = self.sb.run_dir(run_id) / "mcp"
        self.assertTrue((mcp_dir / "claude-alt.mcp.json").exists())
        cfg = json.loads((mcp_dir / "claude-alt.mcp.json").read_text())
        self.assertEqual(cfg["mcpServers"]["atlassian"]["url"], self.ENDPOINT)
        others = [p.name for p in mcp_dir.glob("claude-*.mcp.json")]
        self.assertEqual(others, ["claude-alt.mcp.json"])

    def test_mcp_sync_merges_rather_than_overwrites(self):
        out = self.sb.shared / "fde-toolkit/plugins/fde-core/.mcp.json"
        out.write_text(json.dumps({"mcpServers": {"handmade": {"type": "http",
                                                               "url": "https://x.test/mcp"}}}))
        subprocess.run([sys.executable, str(self.sb.shared / "bin" / "mcp-sync")],
                       capture_output=True, text=True, env=self.sb.env())
        cfg = json.loads(out.read_text())
        self.assertIn("handmade", cfg["mcpServers"])
        self.assertIn("context7", cfg["mcpServers"])
        self.assertEqual(cfg["_fdeManaged"], ["context7"])

    def test_mcp_sync_prunes_what_it_no_longer_manages(self):
        out = self.sb.shared / "fde-toolkit/plugins/fde-core/.mcp.json"
        out.write_text(json.dumps({
            "_fdeManaged": ["context7", "retired"],
            "mcpServers": {"context7": {"type": "http", "url": "old"},
                           "retired": {"type": "http", "url": "gone"},
                           "handmade": {"type": "http", "url": "https://x.test/mcp"}}}))
        subprocess.run([sys.executable, str(self.sb.shared / "bin" / "mcp-sync")],
                       capture_output=True, text=True, env=self.sb.env())
        cfg = json.loads(out.read_text())
        self.assertNotIn("retired", cfg["mcpServers"])
        self.assertIn("handmade", cfg["mcpServers"])
        self.assertEqual(cfg["mcpServers"]["context7"]["url"], "https://mcp.context7.com/mcp")

    def test_atlassian_calls_are_logged(self):
        run_id = self.sb.start()
        self.sb.full_roles(run_id)
        r = self.sb.fde("log", run_id, "--tool", "atlassian.getJiraIssue",
                        "--detail", "MAX-142")
        self.assertEqual(r.returncode, 0, r.stderr)
        events = (self.sb.run_dir(run_id) / "events.jsonl").read_text()
        self.assertIn("atlassian.getJiraIssue", events)

    def test_documentation_no_longer_claims_bitbucket_is_unsupported(self):
        for name in ("README.md", "RUNBOOK.md"):
            text = (REPO / name).read_text()
            self.assertNotIn("almost certainly not covered", text)
            self.assertNotIn("very likely NOT covered", text)


# -- 15. Publication ---------------------------------------------------------

class TestPublication(FDETest):
    def test_publish_requires_a_separate_approval(self):
        """15. Jira/Confluence writes require separate approval."""
        run_id = self.sb.start()
        self.sb.full_roles(run_id, implementation="chatgpt_codex")
        self.sb.advance_to(run_id, "awaiting_implementation_approval")
        task = self.sb.run_dir(run_id) / "tasks/impl.md"
        task.write_text("do the thing\n")
        r = self.sb.fde("approve-codex", run_id, "implementation", "--task-file", str(task),
                        "--repo", str(self.sb.repo), stdin=f"APPROVE CODEX {run_id}\n")
        self.assertEqual(r.returncode, 0, r.stderr)

        # A Codex approval is not a publication approval.
        apps = [json.loads(l) for l in
                (self.sb.run_dir(run_id) / "approvals.jsonl").read_text().splitlines() if l.strip()]
        self.assertTrue(all(a["type"] != "publication-approval" for a in apps))
        self.assertFalse((self.sb.run_dir(run_id) / "publication-manifest.json").exists())

        for target in ("jira", "confluence"):
            r = self.sb.fde("approve-publish", run_id, target, "--summary", "8 stories",
                            stdin="looks fine\n")
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("did not match", r.stderr)

        r = self.sb.fde("approve-publish", run_id, "jira", "--summary", "8 stories",
                        stdin=f"APPROVE PUBLISH {run_id}\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        man = json.loads((self.sb.run_dir(run_id) / "publication-manifest.json").read_text())
        self.assertEqual(man["entries"][0]["target"], "jira")
        self.assertFalse(man["entries"][0]["published"])

        # ...and approving Jira says nothing about Confluence.
        apps = [json.loads(l) for l in
                (self.sb.run_dir(run_id) / "approvals.jsonl").read_text().splitlines() if l.strip()]
        targets = {a.get("target") for a in apps if a["type"] == "publication-approval"}
        self.assertEqual(targets, {"jira"})

    def test_every_external_target_is_gated(self):
        run_id = self.sb.start()
        self.sb.full_roles(run_id)
        for target in ("jira", "confluence", "sharepoint", "bitbucket", "email", "teams"):
            r = self.sb.fde("approve-publish", run_id, target, stdin="no\n")
            self.assertNotEqual(r.returncode, 0, target)


# -- 16. DOCX intake ---------------------------------------------------------

class TestDocxIntake(FDETest):
    def _have_docx(self):
        if shutil.which("pandoc"):
            return True
        try:
            import docx  # noqa: F401
            return True
        except ImportError:
            return False

    def test_docx_intake_works_or_doctor_says_why_not(self):
        """16. .docx intake succeeds, or fde doctor reports the missing dependency."""
        r = self.sb.fde("doctor")
        line = next(l for l in r.stdout.splitlines() if "DOCX intake" in l)
        if self._have_docx():
            self.assertIn("ok", line)
            self.assertTrue("pandoc" in line or "python-docx" in line)
        else:
            self.assertIn("BROKEN", line)
            self.assertIn("python-docx", line)

    @unittest.skipUnless(shutil.which("pandoc"), "pandoc not installed")
    def test_docx_actually_round_trips(self):
        src_md = self.sb.tmp / "note.md"
        src_md.write_text("# Returns policy\n\nThe PO wants same-day refunds.\n")
        docx = self.sb.tmp / "note.docx"
        subprocess.run(["pandoc", str(src_md), "-o", str(docx)], check=True,
                       capture_output=True)
        shutil.copy2(SRC_SHARED / "bin/ms-intake", self.sb.shared / "bin/ms-intake")
        r = subprocess.run([sys.executable, str(self.sb.shared / "bin/ms-intake"),
                            str(docx), "--title", "Returns policy review"],
                           capture_output=True, text=True, env=self.sb.env())
        self.assertEqual(r.returncode, 0, r.stderr)
        filed = list((self.sb.shared / "intake").glob("*returns-policy-review.md"))
        self.assertEqual(len(filed), 1, r.stdout)
        self.assertIn("same-day refunds", filed[0].read_text())


# -- 17. Installation is non-destructive ------------------------------------

class TestInstallPreserves(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="fde-install-"))
        self.home = self.tmp / "home"
        self.bin = self.tmp / "bin"
        (self.home).mkdir(parents=True)
        self.bin.mkdir()
        stub = self.bin / "claude"
        stub.write_text("#!/usr/bin/env bash\nexit 0\n")
        stub.chmod(0o755)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def install(self, *args, stdin=""):
        env = dict(os.environ, HOME=str(self.home),
                   PATH=f"{self.bin}:{os.environ['PATH']}")
        env.pop("CLAUDE_SHARED", None)
        env.pop("FDE_RUNS_DIR", None)
        return subprocess.run(["bash", str(REPO / "install.sh"), *args],
                              input=stdin, capture_output=True, text=True, env=env)

    def test_reinstall_preserves_everything_that_is_yours(self):
        """17. Re-running installation preserves client context and run history."""
        r = self.install("work")
        self.assertEqual(r.returncode, 0, r.stderr)
        shared = self.home / ".claude-shared"

        mine = {
            "shared/clients/maxeda.md": "# Maxeda\nErik, Berend. Same-day refunds.\n",
            "runs/RUN-1/manifest.json": '{"runId":"RUN-1","state":"complete"}\n',
            "runs/RUN-1/approvals.jsonl": '{"type":"codex-approval"}\n',
            "intake/2026-01-01-call.md": "pasted from a Teams recap\n",
            "env.sh": "export CONFLUENCE_API_TOKEN=mine\n",
            "fde-toolkit/plugins/fde-core/skills/my-skill/SKILL.md": "my own skill\n",
            "fde-toolkit/plugins/fde-core/agents/my-agent.md": "my own agent\n",
        }
        for rel, content in mine.items():
            p = shared / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
        settings = self.home / ".claude-profiles/work/settings.json"
        customised = json.loads(settings.read_text())
        customised["myOwnSetting"] = True
        settings.write_text(json.dumps(customised))
        std = shared / "shared/engineering-standards.md"
        std.write_text(std.read_text() + "\n- our own rule\n")

        r = self.install("--update")
        self.assertEqual(r.returncode, 0, r.stderr)

        for rel, content in mine.items():
            self.assertEqual((shared / rel).read_text(), content, f"{rel} was altered")
        self.assertIn("our own rule", std.read_text())
        self.assertTrue(json.loads(settings.read_text())["myOwnSetting"])

    def test_update_backs_up_before_replacing(self):
        self.install("work")
        shared = self.home / ".claude-shared"
        std = shared / "shared/engineering-standards.md"
        std.write_text("replaced wholesale\n")
        r = self.install("--update", "--yes")
        self.assertEqual(r.returncode, 0, r.stderr)
        backups = list((shared / ".backups").rglob("engineering-standards.md"))
        self.assertEqual(len(backups), 1, r.stdout)
        self.assertEqual(backups[0].read_text(), "replaced wholesale\n")
        self.assertNotEqual(std.read_text(), "replaced wholesale\n")

    def test_dry_run_writes_nothing(self):
        self.install("work")
        shared = self.home / ".claude-shared"
        std = shared / "shared/engineering-standards.md"
        std.write_text("mine\n")
        before = {p: p.stat().st_mtime_ns for p in shared.rglob("*") if p.is_file()}
        r = self.install("--update", "--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        after = {p: p.stat().st_mtime_ns for p in shared.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        self.assertEqual(std.read_text(), "mine\n")

    def test_installer_never_deletes_and_never_inits_a_repo(self):
        text = (REPO / "install.sh").read_text()
        self.assertNotIn("rm -rf", text)
        self.assertIn("--git-init", text)
        self.install("work")
        self.assertFalse((self.home / ".claude-shared/.git").exists())
        self.assertFalse((self.home / ".claude-shared/fde-toolkit/.git").exists())

    def test_secrets_file_is_never_installed(self):
        self.install("work")
        self.assertFalse((self.home / ".claude-shared/.env.sh").exists())

    def test_runs_are_gitignored(self):
        self.install("work")
        gi = (self.home / ".claude-shared/.gitignore").read_text()
        self.assertIn("runs/", gi)
        self.assertIn("env.sh", gi)
        self.assertIn("runs/", (REPO / ".gitignore").read_text())


# -- state machine and doctor -----------------------------------------------

class TestStateMachine(FDETest):
    def test_the_specified_states_all_exist_and_are_ordered(self):
        expected = ["awaiting_roles", "roles_confirmed", "intake", "research",
                    "solutioning", "review", "reconciliation", "planning",
                    "awaiting_implementation_approval", "implementation",
                    "verification", "awaiting_publication_approval", "complete",
                    "blocked"]
        run_id = self.sb.start()
        self.sb.full_roles(run_id)
        for s in expected[2:-1]:
            r = self.sb.fde("resume", run_id, "--advance", s)
            self.assertEqual(r.returncode, 0, f"{s}: {r.stderr}")
        r = self.sb.fde("status", run_id)
        self.assertIn("complete", r.stdout)

    def test_skipping_a_state_is_refused(self):
        run_id = self.sb.start()
        self.sb.full_roles(run_id)
        r = self.sb.fde("resume", run_id, "--advance", "implementation")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("illegal transition", r.stderr)

    def test_block_and_unblock_returns_to_where_it_was(self):
        run_id = self.sb.start()
        self.sb.full_roles(run_id)
        self.sb.advance_to(run_id, "research")
        self.sb.fde("resume", run_id, "--block", "gap would change the design")
        m = json.loads((self.sb.run_dir(run_id) / "manifest.json").read_text())
        self.assertEqual(m["state"], "blocked")
        self.sb.fde("resume", run_id, "--unblock")
        m = json.loads((self.sb.run_dir(run_id) / "manifest.json").read_text())
        self.assertEqual(m["state"], "research")

    def test_run_layout_matches_the_specification(self):
        run_id = self.sb.start()
        d = self.sb.run_dir(run_id)
        for rel in ("manifest.json", "requirement.md", "tasks", "inputs",
                    "artifacts/research", "artifacts/architecture", "artifacts/review",
                    "artifacts/presentation", "artifacts/delivery-plan",
                    "artifacts/implementation"):
            self.assertTrue((d / rel).exists(), rel)

    def test_doctor_is_clean_on_a_good_install(self):
        r = self.sb.fde("doctor")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for label in ("Claude work", "Claude Bedrock", "Codex", "Gemini",
                      "Microsoft Copilot Studio", "Atlassian MCP", "Confluence CLI",
                      "DOCX intake", "Run directory", "Toolkit source", "Git remote"):
            self.assertIn(label, r.stdout)

    def test_doctor_fails_on_an_outdated_atlassian_endpoint(self):
        src = self.sb.shared / "mcp/mcp-servers.json"
        data = json.loads(src.read_text())
        data["servers"]["atlassian"]["url"] = "https://mcp.atlassian.com/v1/sse"
        data["servers"]["atlassian"]["transport"] = "sse"
        src.write_text(json.dumps(data))
        r = self.sb.fde("doctor")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("expected https://mcp.atlassian.com/v1/mcp/authv2", r.stdout)


# -- live codex, when one is installed ---------------------------------------

@unittest.skipUnless(REAL_CODEX, "no real codex binary on PATH")
class TestRealCodexSandbox(FDETest):
    """Runs against the genuine CLI where it exists. Skipped otherwise, so the
    suite stays deterministic and offline by default."""

    def setUp(self):
        super().setUp()
        # Drop the stub so the real binary is found.
        (self.sb.bindir / "codex").unlink()

    def test_read_only_really_cannot_write(self):
        victim = self.sb.repo / "canary.txt"
        victim.write_text("original")
        self.sb.ask_codex("--read-only",
                          f"Write the word CHANGED into {victim} and nothing else.")
        self.assertEqual(victim.read_text(), "original")

    def test_write_mode_really_is_bounded_to_the_approved_root(self):
        run_id = self.sb.start("MAX-live real codex")
        args = []
        for k, v in {"orchestrator": "claude_alt", "research": "claude_work",
                     "solutioning": "claude_work", "review": "claude_msc",
                     "deliveryPlanning": "claude_alt", "presentation": "claude_work",
                     "implementation": "chatgpt_codex", "microsoftContext": "none"}.items():
            args += ["--set", f"{k}={v}"]
        self.assertEqual(self.sb.fde("roles", run_id, *args).returncode, 0)
        self.sb.advance_to(run_id, "awaiting_implementation_approval")
        outside = self.sb.outside / "escape.txt"
        task = self.sb.run_dir(run_id) / "tasks/impl.md"
        task.write_text(textwrap.dedent(f"""
            Create a file called inside.txt in the current directory containing OK.
            Then also try to create {outside} containing OK.
        """).strip() + "\n")
        r = self.sb.fde("approve-codex", run_id, "implementation", "--task-file", str(task),
                        "--repo", str(self.sb.repo), stdin=f"APPROVE CODEX {run_id}\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.sb.ask_codex("--write", "--run", run_id, "--stage", "implementation",
                          "--task-file", str(task))
        self.assertFalse(outside.exists(), "codex wrote outside the approved root")


if __name__ == "__main__":
    unittest.main(verbosity=2)
