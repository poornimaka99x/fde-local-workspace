"""Acceptance coverage for the v0.3 specialist and evidence lifecycle."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
FDE = ROOT / "claude-shared" / "bin" / "fde"
AGENTS = ROOT / "claude-shared" / "config" / "agents.json"
TEMPLATES = ROOT / "claude-shared" / "config" / "provider-templates.json"


class FdeV03ControllerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.shared = self.home / ".claude-shared"
        (self.shared / "config").mkdir(parents=True)
        shutil.copy2(AGENTS, self.shared / "config" / "agents.json")
        shutil.copy2(TEMPLATES, self.shared / "config" / "provider-templates.json")
        (self.home / ".claude-profiles" / "work").mkdir(parents=True)
        self.env = dict(os.environ)
        self.env.update({
            "HOME": str(self.home),
            "CLAUDE_SHARED": str(self.shared),
            "CLAUDE_PROFILES_DIR": str(self.home / ".claude-profiles"),
            "FDE_RUNS_DIR": str(self.shared / "runs"),
        })

    def tearDown(self):
        self.tmp.cleanup()

    def run_fde(self, *args, input_text=None, expected=0):
        result = subprocess.run(
            [str(FDE), *args], input=input_text, text=True,
            capture_output=True, env=self.env,
        )
        self.assertEqual(
            result.returncode, expected,
            msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}",
        )
        return result

    def new_release_run(self):
        start = self.run_fde("start", "release the verified service")
        run_id = next(
            line.split()[1] for line in start.stdout.splitlines()
            if line.startswith("run ")
        )
        self.run_fde("orchestrator", run_id, "work", "--shape", "release")
        return run_id

    def test_capability_registry_has_no_fixed_account_roles(self):
        data = json.loads(AGENTS.read_text())
        for identity in data["agents"].values():
            self.assertIn("capabilities", identity)
            for forbidden in ("role", "defaultRole", "preferred", "default"):
                self.assertNotIn(forbidden, identity)
        self.assertTrue(data["agents"]["chatgpt_codex"]["write_requires_approval"])
        self.assertIn(
            "source-code-edit",
            data["agents"]["microsoft_copilot"]["forbidden"],
        )

    def test_release_requires_evidence_and_deployment_approval(self):
        run_id = self.new_release_run()
        plan = json.loads(
            (self.shared / "runs" / run_id / "plan.json").read_text()
        )
        self.assertEqual(
            plan["stages"], ["verification", "deployment", "observability"]
        )
        for role in ("testEngineering", "releaseManagement", "observability"):
            self.assertIn(role, plan["rolesNeeded"])

        self.run_fde(
            "roles", run_id,
            "--set", "testEngineering=work",
            "--set", "releaseManagement=work",
            "--set", "observability=work",
        )
        self.run_fde("resume", run_id, "--next")
        report = (
            self.shared / "runs" / run_id / "artifacts" /
            "implementation" / "verification-report.md"
        )
        report.write_text("# Verification\n\nAll declared release checks passed.\n")
        missing = self.run_fde("resume", run_id, "--next", expected=9)
        self.assertIn("no checkpoint is recorded", missing.stderr)
        self.run_fde(
            "checkpoint", run_id, "--stage", "verification",
            "--status", "pass",
            "--evidence", "artifacts/implementation/verification-report.md",
            "--command", "python3 -m unittest",
        )
        self.run_fde("resume", run_id, "--next")
        blocked = self.run_fde("resume", run_id, "--next", expected=7)
        self.assertIn("no deployment has been approved", blocked.stderr)

        self.run_fde(
            "approve-publish", run_id, "deployment",
            "--summary", "test environment release",
            input_text=f"APPROVE PUBLISH {run_id}\n",
        )
        self.assertIn("state      deployment", self.run_fde("status", run_id).stdout)

        self.run_fde("resume", run_id, "--next")
        observability = (
            self.shared / "runs" / run_id / "artifacts" /
            "observability" / "observability-plan.md"
        )
        observability.write_text("# Observability\n\nSLO and rollout watch evidence.\n")
        self.run_fde(
            "checkpoint", run_id, "--stage", "observability",
            "--status", "pass",
            "--evidence", "artifacts/observability/observability-plan.md",
        )
        self.run_fde("resume", run_id, "--next")
        self.assertIn("state      complete", self.run_fde("status", run_id).stdout)

    def test_pr_review_shape_is_provider_neutral(self):
        shapes = self.run_fde("shapes")
        self.assertIn("pr-review", shapes.stdout)
        self.assertIn("adversarial review", shapes.stdout)
        self.assertIn("verification", shapes.stdout)

    def test_combined_plan_and_roles_require_exact_approval(self):
        start = self.run_fde("start")
        run_id = next(
            line.split()[1] for line in start.stdout.splitlines()
            if line.startswith("run ")
        )
        self.run_fde("orchestrator", run_id, "work")
        self.run_fde("request", run_id, "research the returns journey")

        preview = self.run_fde(
            "plan", run_id, "--preview", "--stages", "intake,research",
        )
        self.assertIn("preview only", preview.stdout)
        self.assertFalse((self.shared / "runs" / run_id / "plan.json").exists())

        self.run_fde(
            "plan", run_id, "--require-approval", "--stages", "intake,research",
        )
        self.run_fde(
            "roles", run_id,
            "--set", "research=work",
            "--set", "productManagement=none",
            "--set", "microsoftContext=none",
        )
        run_dir = self.shared / "runs" / run_id
        manifest = json.loads((run_dir / "manifest.json").read_text())
        roles = json.loads((run_dir / "roles.json").read_text())
        self.assertEqual(manifest["state"], "awaiting_roles")
        self.assertIn("selectedAt", roles)
        self.assertNotIn("confirmedAt", roles)
        blocked = self.run_fde(
            "guard", run_id, "--activity", "reading Jira", expected=6,
        )
        self.assertIn("not confirmed", blocked.stderr)

        refused = self.run_fde(
            "approve-plan", run_id, input_text="yes\n", expected=8,
        )
        self.assertIn("nothing was approved", refused.stderr)
        approved = self.run_fde(
            "approve-plan", run_id,
            input_text=f"APPROVE PLAN {run_id}\n",
        )
        self.assertIn("request research the returns journey", approved.stdout)
        self.assertIn("research/research-brief.md", approved.stdout)
        manifest = json.loads((run_dir / "manifest.json").read_text())
        plan = json.loads((run_dir / "plan.json").read_text())
        roles = json.loads((run_dir / "roles.json").read_text())
        self.assertEqual(manifest["state"], "roles_confirmed")
        self.assertIn("executionApprovedAt", plan)
        self.assertIn("confirmedAt", roles)
        self.run_fde("guard", run_id, "--activity", "reading Jira")

    def test_lesson_is_unreviewed_and_rejects_obvious_secrets(self):
        run_id = self.new_release_run()
        self.run_fde(
            "roles", run_id,
            "--set", "testEngineering=work",
            "--set", "releaseManagement=work",
            "--set", "observability=work",
        )
        body = self.shared / "runs" / run_id / "lesson.md"
        body.write_text(
            "Prefer provider detection before retrieving pull-request metadata.\n"
        )
        saved = self.run_fde(
            "learn", run_id, "--title", "Detect SCM provider",
            "--kind", "pattern", "--body-file", str(body),
        )
        lesson_path = Path(saved.stdout.splitlines()[0].split(maxsplit=1)[1])
        self.assertIn("trust: unreviewed", lesson_path.read_text())

        body.write_text('api_key = "abcdefghijklmnop"\n')
        refused = self.run_fde(
            "learn", run_id, "--title", "Unsafe",
            "--body-file", str(body), expected=10,
        )
        self.assertIn("credential", refused.stderr)


if __name__ == "__main__":
    unittest.main()
