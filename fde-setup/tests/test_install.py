"""Acceptance tests for install.sh's preconditions and its dry run.

Every test runs against a throwaway HOME with a PATH that deliberately has no
claude, gemini or codex on it. Nothing here writes to the operator's real
~/.claude-shared or ~/.claude-profiles.
"""
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

    def env(self, with_claude=False):
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
        return environment

    def run_install(self, *args, with_claude=False, expected=0):
        result = subprocess.run(
            ["bash", str(INSTALL), *args],
            capture_output=True, text=True, env=self.env(with_claude),
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
        for plugin in ("fde-core", "code-simplifier", "ponytail"):
            self.assertIn(f"plugin install {plugin}@fde-toolkit", calls)
        installed_skills = (
            self.home / ".claude-shared" / "fde-toolkit" / "plugins"
            / "fde-core" / "skills"
        )
        for skill in ("eli5", "brag"):
            self.assertTrue((installed_skills / skill / "SKILL.md").is_file())
            self.assertTrue((installed_skills / skill / "SOURCE.json").is_file())


if __name__ == "__main__":
    unittest.main()
