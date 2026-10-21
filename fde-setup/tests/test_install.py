"""Acceptance tests for install.sh's preconditions and its dry run.

Every test runs against a throwaway HOME with a PATH that deliberately has no
claude, gemini or codex on it. Nothing here writes to the operator's real
~/.claude-shared or ~/.claude-profiles.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
INSTALL = ROOT / "install.sh"


class InstallScriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.bindir = Path(self.tmp.name) / "bin"
        for directory in (self.home, self.bindir):
            directory.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def env(self, with_claude=False, extra=None):
        # A PATH with the usual tools but deliberately without claude.
        path = [str(self.bindir), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        environment = dict(os.environ)
        environment.update({
            "HOME": str(self.home),
            "PATH": ":".join(path),
            "CLAUDE_SHARED": str(self.home / ".claude-shared"),
            "CLAUDE_STUB_LOG": str(self.home / "claude-calls.log"),
        })
        if with_claude:
            stub = self.bindir / "claude"
            stub.write_text(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CLAUDE_STUB_LOG\"\nexit 0\n"
            )
            stub.chmod(0o755)
        environment.update(extra or {})
        return environment

    def run_install(self, *args, with_claude=False, expected=0, env_extra=None):
        result = subprocess.run(
            ["bash", str(INSTALL), *args],
            capture_output=True, text=True, env=self.env(with_claude, env_extra),
            cwd=str(ROOT), input="",
        )
        self.assertEqual(result.returncode, expected,
                         msg=f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        return result

    def test_an_update_does_not_need_the_claude_cli(self):
        """Syncing files is not something the Claude CLI is involved in."""
        result = self.run_install("--update", "--dry-run")
        self.assertIn("claude CLI not found on PATH", result.stdout)
        self.assertIn("fine for an update", result.stdout)
        self.assertIn("bin/fde", result.stdout)

    def test_changed_workflow_and_evaluation_policy_are_preserved_without_confirmation(self):
        shared = self.home / ".claude-shared"
        files = ["config/workflows/forward-deployed-engineer.json", "config/evaluation-suite.json"]
        for relative in files:
            path = shared / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{"operatorOwned": true}\n')
        result = self.run_install("--update")
        for relative in files:
            self.assertEqual((shared / relative).read_text(), '{"operatorOwned": true}\n')
            self.assertIn(relative + " differs from the shipped version", result.stdout)

    def test_a_fresh_install_still_insists_on_it_and_says_what_to_do(self):
        result = self.run_install("--dry-run", expected=1)
        self.assertIn("Install Claude Code first", result.stderr)
        self.assertIn("./install.sh --update", result.stderr)

    def test_a_dry_run_writes_nothing_at_all(self):
        self.run_install("--update", "--dry-run")
        self.assertFalse((self.home / ".claude-shared").exists())
        self.assertFalse((self.home / ".claude-profiles").exists())

    def test_an_update_reports_the_controller_it_would_install(self):
        result = self.run_install("--update", "--dry-run", with_claude=True)
        self.assertIn("bin/fde", result.stdout)
        self.assertIn("update mode: profiles, credentials and settings.json left",
                      result.stdout)

    def test_it_finds_a_claude_that_is_installed_but_not_on_path(self):
        local = self.home / ".claude" / "local"
        local.mkdir(parents=True)
        stub = local / "claude"
        stub.write_text("#!/bin/sh\nexit 0\n")
        stub.chmod(0o755)
        result = self.run_install("--dry-run")
        self.assertIn("found claude at", result.stdout)
        self.assertNotIn("Install Claude Code first", result.stderr)

    def test_a_fresh_install_registers_every_shipped_plugin(self):
        self.run_install("work", with_claude=True)
        calls = (self.home / "claude-calls.log").read_text()
        for plugin in ("addy-agent-skills", "archify", "code-simplifier", "evo",
                       "fde-core", "fde-user", "ponytail", "rea",
                       "security-guidance"):
            self.assertIn(f"plugin install {plugin}@fde-toolkit", calls)
        installed_skills = (
            self.home / ".claude-shared" / "fde-toolkit" / "plugins"
            / "fde-core" / "skills"
        )
        for skill in ("eli5", "brag"):
            self.assertTrue((installed_skills / skill / "SKILL.md").is_file())
            self.assertTrue((installed_skills / skill / "SOURCE.json").is_file())
        user_skills = (
            self.home / ".claude-shared" / "fde-toolkit" / "plugins"
            / "fde-user" / "skills"
        )
        for skill in ("humanizer", "i-have-adhd"):
            self.assertTrue((user_skills / skill / "SKILL.md").is_file())
            self.assertTrue((user_skills / skill / "SOURCE.json").is_file())

    def test_an_update_refreshes_existing_profile_plugin_caches(self):
        (self.home / ".claude-profiles" / "work").mkdir(parents=True)
        self.run_install("--update", "--yes", "work", with_claude=True)
        calls = (self.home / "claude-calls.log").read_text()
        self.assertIn("plugin marketplace update fde-toolkit", calls)
        for plugin in ("addy-agent-skills", "archify", "code-simplifier", "evo",
                       "fde-core", "fde-user", "ponytail", "rea",
                       "security-guidance"):
            self.assertIn(f"plugin update {plugin}@fde-toolkit", calls)

    def test_latest_stable_uses_highest_non_prerelease_semver_tag(self):
        remote = Path(self.tmp.name) / "upstream"
        remote.mkdir()
        subprocess.run(["git", "init", "-q", str(remote)], check=True)
        subprocess.run(["git", "-C", str(remote), "config", "user.name", "FDE test"], check=True)
        subprocess.run(["git", "-C", str(remote), "config", "user.email", "fde@example.test"], check=True)
        release_installer = remote / "install.sh"
        release_installer.write_text(
            "#!/bin/sh\nprintf '%s|%s\\n' \"$FDE_STABLE_RELEASE\" \"$*\" > \"$STABLE_LOG\"\n"
        )
        subprocess.run(["git", "-C", str(remote), "add", "install.sh"], check=True)
        subprocess.run(["git", "-C", str(remote), "commit", "-qm", "release 1.2.0"], check=True)
        subprocess.run(["git", "-C", str(remote), "tag", "v1.2.0"], check=True)
        release_installer.write_text(release_installer.read_text() + "# newer\n")
        subprocess.run(["git", "-C", str(remote), "commit", "-qam", "release 1.10.0"], check=True)
        subprocess.run(["git", "-C", str(remote), "tag", "v1.10.0"], check=True)
        release_installer.write_text(release_installer.read_text() + "# prerelease\n")
        subprocess.run(["git", "-C", str(remote), "commit", "-qam", "release candidate"], check=True)
        subprocess.run(["git", "-C", str(remote), "tag", "v2.0.0-rc.1"], check=True)

        log = Path(self.tmp.name) / "stable.log"
        result = self.run_install(
            "--update", "--latest-stable", "--dry-run", "work",
            env_extra={"FDE_UPDATE_REMOTE": str(remote), "STABLE_LOG": str(log)},
        )
        self.assertIn("newest stable FDE release: v1.10.0", result.stdout)
        self.assertEqual(log.read_text(), "v1.10.0|--update --dry-run work\n")
        self.assertFalse((self.home / ".claude-shared").exists())

    def test_addy_agent_skills_is_a_non_executable_curated_subset(self):
        plugin = ROOT / "fde-toolkit" / "plugins" / "addy-agent-skills"
        installed = {
            path.parent.name for path in (plugin / "skills").glob("*/SKILL.md")
        }
        self.assertEqual(installed, {
            "api-and-interface-design",
            "debugging-and-error-recovery",
            "deprecation-and-migration",
            "documentation-and-adrs",
            "performance-optimization",
            "security-and-hardening",
            "source-driven-development",
        })
        self.assertFalse((plugin / "hooks").exists())
        self.assertFalse((plugin / "commands").exists())
        self.assertTrue((plugin / "references" / "performance-checklist.md").is_file())
        self.assertTrue((plugin / "references" / "security-checklist.md").is_file())

    def test_security_guidance_defaults_to_local_pattern_checks_only(self):
        hooks_path = (
            ROOT / "fde-toolkit" / "plugins" / "security-guidance"
            / "hooks" / "hooks.json"
        )
        hooks = json.loads(hooks_path.read_text(encoding="utf-8"))["hooks"]
        self.assertEqual(set(hooks), {"PostToolUse"})
        entry = hooks["PostToolUse"][0]
        self.assertEqual(entry["matcher"], "Edit|Write|MultiEdit|NotebookEdit")
        command = entry["hooks"][0]["command"]
        self.assertIn("ENABLE_CODE_SECURITY_REVIEW=0", command)
        self.assertNotIn("ensure_agent_sdk.py", command)

        hook_source = (
            ROOT / "fde-toolkit" / "plugins" / "security-guidance"
            / "hooks" / "security_reminder_hook.py"
        ).read_text(encoding="utf-8")
        self.assertIn(
            'if hook_event_name == "PostToolUse" and ENABLE_CODE_SECURITY_REVIEW:',
            hook_source,
        )


if __name__ == "__main__":
    unittest.main()
