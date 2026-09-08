"""Tests for the three token-reduction levers.

Each of these guards a property that is easy to undo by accident:
the standards document must not be eagerly imported, `quiet` must filter
without losing the full log, and the sidecar prefix must stay byte-identical
across calls or provider prefix caching silently stops hitting.
"""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SHARED = ROOT / "claude-shared"
PLUGIN = ROOT / "fde-toolkit" / "plugins" / "fde-core"
STANDARDS = SHARED / "shared" / "engineering-standards.md"


def sh(*args, env=None, expected=None):
    merged = {**os.environ, "CLAUDE_SHARED": str(SHARED), **(env or {})}
    result = subprocess.run([str(a) for a in args], text=True,
                            capture_output=True, env=merged)
    if expected is not None:
        assert result.returncode == expected, (
            f"exit {result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
    return result


class StandardsAreNotEagerlyLoaded(unittest.TestCase):
    def test_shared_claude_md_does_not_import_the_standards(self):
        # The @ import cost ~11k tokens in every session, on every profile.
        text = (SHARED / "CLAUDE.md").read_text()
        self.assertNotIn("@~/.claude-shared/shared/engineering-standards.md", text)
        self.assertIn("standards show", text)

    def test_shared_claude_md_stays_small(self):
        text = (SHARED / "CLAUDE.md").read_text()
        self.assertLess(len(text), 8000, "the always-on instruction file is growing")

    def test_index_maps_every_top_level_section(self):
        index = (SHARED / "shared" / "standards-index.md").read_text()
        sections = [line.split(".")[0].removeprefix("## ").strip()
                    for line in STANDARDS.read_text().splitlines()
                    if line.startswith("## ")]
        for number in sections:
            self.assertRegex(index, rf"\|\s*{number}\s*\|",
                             f"section {number} is missing from the index")

    def test_show_returns_one_section_not_the_document(self):
        whole = len(STANDARDS.read_text().splitlines())
        section = sh(SHARED / "bin" / "standards", "show", "8", expected=0).stdout
        self.assertTrue(section.startswith("## 8."))
        self.assertLess(len(section.splitlines()), whole / 10)
        self.assertNotIn("## 9.", section)

    def test_show_handles_subsections_and_unknown_sections(self):
        sub = sh(SHARED / "bin" / "standards", "show", "16.3", expected=0).stdout
        self.assertTrue(sub.startswith("### 16.3"))
        self.assertNotIn("## 17.", sub)
        sh(SHARED / "bin" / "standards", "show", "99", expected=1)

    def test_find_reports_owning_headings(self):
        found = sh(SHARED / "bin" / "standards", "find", "timeout", expected=0).stdout
        self.assertIn("8. Error handling and resilience", found)


class QuietFiltersWithoutLosing(unittest.TestCase):
    QUIET = SHARED / "bin" / "quiet"

    def test_passing_command_collapses_to_a_summary(self):
        result = sh(self.QUIET, "bash", "-c",
                    'seq 1 300 | sed "s/^/ok /"; echo "300 passed"', expected=0)
        self.assertLess(len(result.stdout.splitlines()), 10)
        self.assertIn("300 passed", result.stdout)
        self.assertIn("log:", result.stdout)

    def test_failing_command_surfaces_the_fault_and_the_exit_code(self):
        result = sh(self.QUIET, "bash", "-c",
                    'seq 1 200 | sed "s/^/noise /";'
                    ' echo "AssertionError: expected 200, got 401"; exit 3',
                    expected=3)
        self.assertIn("AssertionError", result.stdout)
        self.assertIn("FAILED", result.stdout)
        self.assertLess(len(result.stdout.splitlines()), 120)

    def test_full_log_is_written_and_complete(self):
        result = sh(self.QUIET, "bash", "-c", 'seq 1 300 | sed "s/^/ok /"', expected=0)
        log = Path(result.stdout.rsplit("log:", 1)[1].strip())
        self.assertTrue(log.is_file(), "filtering must stay recoverable")
        self.assertEqual(len(log.read_text().splitlines()), 300)

    def test_exit_code_is_the_wrapped_command_s(self):
        self.assertEqual(sh(self.QUIET, "bash", "-c", "exit 42").returncode, 42)

    def test_keep_escape_hatch_prints_everything(self):
        result = sh(self.QUIET, "bash", "-c", 'seq 1 300',
                    env={"QUIET_KEEP": "1"}, expected=0)
        self.assertGreater(len(result.stdout.splitlines()), 300)


class QuietHandsOffToRtk(unittest.TestCase):
    """rtk is optional: absent it costs tokens, never correctness."""

    QUIET = SHARED / "bin" / "quiet"
    HELP = ("RTK: Rust Token Killer\n\nUsage: rtk [OPTIONS] <COMMAND>\n\n"
            "Commands:\n  ls    tree\n  git   status\n  npm   packages\n"
            "  help  Print this message\n\nOptions:\n  -u, --ultra-compact\n")

    def stub_rtk(self, tmp):
        d = Path(tmp) / "bin"
        d.mkdir()
        rtk = d / "rtk"
        rtk.write_text('#!/usr/bin/env bash\n'
                       f'[[ "$1" == "--help" ]] && {{ cat <<\'H\'\n{self.HELP}H\n'
                       'exit 0; }\n'
                       'echo "rtk[$1]: compressed"; exit 7\n')
        rtk.chmod(0o755)
        cache = Path(tmp) / "cache"
        cache.mkdir()
        return {"PATH": f"{d}:{os.environ['PATH']}", "TMPDIR": str(cache)}

    def test_known_command_is_delegated_and_exit_code_survives(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = sh(self.QUIET, "npm", "test", env=self.stub_rtk(tmp))
            self.assertIn("rtk[npm]: compressed", result.stdout)
            self.assertEqual(result.returncode, 7)

    def test_unknown_command_still_uses_the_builtin_filter(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = sh(self.QUIET, "bash", "-c", 'seq 1 200; echo "200 passed"',
                        env=self.stub_rtk(tmp), expected=0)
            self.assertIn("200 passed", result.stdout)
            self.assertIn("log:", result.stdout)
            self.assertNotIn("compressed", result.stdout)

    def test_supported_command_list_is_parsed_from_rtk_help(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stub_rtk(tmp)
            sh(self.QUIET, "ls", env=env)
            listed = (Path(env["TMPDIR"]) / ".quiet-rtk-commands").read_text().split()
            self.assertEqual(sorted(listed), ["git", "ls", "npm"])
            # "help" is rtk's own, and section headings are not commands: a
            # parse that swept those up would delegate commands rtk cannot run.
            self.assertNotIn("help", listed)
            self.assertNotIn("Options", listed)

    def test_opt_out_skips_rtk(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {**self.stub_rtk(tmp), "QUIET_NO_RTK": "1"}
            result = sh(self.QUIET, "npm", "--version", env=env)
            self.assertNotIn("compressed", result.stdout)

    def test_no_global_rtk_hooks_are_shipped(self):
        # Global hooks would also rewrite the reads a review finding cites.
        hooks = (PLUGIN / "hooks" / "hooks.json").read_text()
        self.assertNotIn("rtk", hooks)


class SidecarPrefixIsCacheable(unittest.TestCase):
    """A prefix that shifts by one byte is a full cache miss."""

    def compose(self, question, env=None):
        # ask-gemini's composition, exercised through a stand-in for the CLI.
        # The stub lives in a temporary directory: a test that writes into the
        # repository is a test that changes what it is measuring.
        with tempfile.TemporaryDirectory() as tmp:
            # The Antigravity CLI (agy) is what ask-gemini calls now. The stub
            # echoes back the value of -p, which is the composed prompt, so this
            # measures composition and nothing else.
            stub = Path(tmp) / "agy"
            stub.write_text('#!/usr/bin/env bash\n'
                            'while [[ $# -gt 0 ]]; do\n'
                            '  [[ "$1" == "-p" ]] && { printf "%s" "$2"; exit 0; }\n'
                            '  shift\ndone\n')
            stub.chmod(0o755)
            merged = {"PATH": f"{tmp}:{os.environ['PATH']}", **(env or {})}
            return sh(SHARED / "bin" / "ask-gemini", question,
                      env=merged, expected=0).stdout

    def test_preamble_is_first_and_identical_across_questions(self):
        a = self.compose("is this migration reversible?")
        b = self.compose("what would break in production?")
        preamble = (SHARED / "prompts" / "sidecar-preamble.md").read_text()
        self.assertTrue(a.startswith(preamble))
        self.assertTrue(b.startswith(preamble))

    def test_question_is_last(self):
        a = self.compose("is this migration reversible?")
        self.assertTrue(a.rstrip().endswith("is this migration reversible?"))
        self.assertLess(a.index("# Question"), a.index("is this migration reversible?"))

    def test_stable_context_files_sit_in_the_cacheable_prefix(self):
        env = {"FDE_SIDECAR_CONTEXT": str(STANDARDS)}
        a = self.compose("does this diff violate anything?", env=env)
        b = self.compose("and is the error handling sound?", env=env)
        common = os.path.commonprefix([a, b])
        # Both providers only cache prefixes above ~1024 tokens; the brief alone
        # is under that, which is what the context slot exists to fix.
        self.assertGreater(len(common) / 4, 1024)
        self.assertIn("# Reference: engineering-standards.md", common)

    def test_opt_out_sends_the_bare_question(self):
        bare = self.compose("bare question", env={"FDE_NO_PREAMBLE": "1"})
        self.assertEqual(bare.strip(), "bare question")

    def test_write_mode_prompt_is_not_wrapped(self):
        # The approval is hash-bound to the task file: what Codex is told in
        # write mode must be exactly what the user approved.
        codex = (SHARED / "bin" / "ask-codex").read_text()
        write_path = codex.split("# -------------------------------------------------------------------- write --")[1]
        self.assertNotIn("compose_prompt", write_path)
        self.assertIn('"$(cat "$task_file")"', write_path)


if __name__ == "__main__":
    unittest.main()
