"""Acceptance coverage for plugin import, pinning and the Ponytail integration.

The import path is the only door third-party code comes through, so most of
what is asserted here is what the door REFUSES. A test that only proves a good
plugin installs proves nothing about the ones that matter.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
FDE = ROOT / "claude-shared" / "bin" / "fde"
SHARED_SRC = ROOT / "claude-shared"
TOOLKIT_SRC = ROOT / "fde-toolkit"

sys.path.insert(0, str(SHARED_SRC / "lib"))
import fde_capabilities as cap        # noqa: E402
import fde_plugin_import as imports   # noqa: E402

PONYTAIL_COMMIT = "356918eba965ee1eac64bd3a7f0dd02108350de5"


class PluginTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.shared = self.home / ".claude-shared"
        shutil.copytree(SHARED_SRC, self.shared,
                        ignore=shutil.ignore_patterns("runs", "__pycache__", ".env.sh", "env.sh"))
        shutil.copytree(TOOLKIT_SRC, self.shared / "fde-toolkit",
                        ignore=shutil.ignore_patterns("__pycache__", ".versions"))
        (self.shared / "runs").mkdir(exist_ok=True)
        self.plugins = self.shared / "fde-toolkit" / "plugins"
        self.env = dict(os.environ)
        self.env.update({
            "HOME": str(self.home), "CLAUDE_SHARED": str(self.shared),
            "CLAUDE_PROFILES_DIR": str(self.home / ".claude-profiles"),
            "FDE_RUNS_DIR": str(self.shared / "runs"),
        })
        self.env.pop("FDE_PLUGINS_ROOT", None)

    def tearDown(self):
        self.tmp.cleanup()

    def fde(self, *args, expected=0):
        result = subprocess.run([str(FDE), *args], text=True, capture_output=True, env=self.env)
        self.assertEqual(result.returncode, expected,
                         msg=f"args={args}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        return result

    def resolved(self, *args):
        document = json.loads(self.fde("config", "show", "--json", "--all", *args).stdout)
        return document, {entry["id"]: entry for entry in document["capabilities"]}

    # -- fixtures -----------------------------------------------------------

    def candidate(self, name="acme", *, hooks=False, executable=False, symlink=None,
                  package_json=False, files=1, manifest=True, manifest_name=None):
        """A plugin tree outside the install, ready to be imported."""
        root = self.home / "candidates" / name
        (root / ".claude-plugin").mkdir(parents=True)
        if manifest:
            (root / ".claude-plugin" / "plugin.json").write_text(json.dumps(
                {"name": manifest_name or name, "version": "1.0.0",
                 "description": f"{name} test plugin", "license": "MIT"}), encoding="utf-8")
        (root / "LICENSE").write_text("MIT License\n\nCopyright (c) 2026 Test\n", encoding="utf-8")
        (root / "skills").mkdir()
        for index in range(files):
            directory = root / "skills" / f"alpha{index or ''}"
            directory.mkdir()
            (directory / "SKILL.md").write_text(
                f"---\nname: alpha{index or ''}\ndescription: A test skill.\n---\n\n# alpha\n",
                encoding="utf-8")
        if hooks:
            (root / "hooks").mkdir()
            (root / "hooks" / "hooks.json").write_text(json.dumps(
                {"hooks": {"SessionStart": [{"hooks": [
                    {"type": "command", "command": "node ${CLAUDE_PLUGIN_ROOT}/hooks/go.js"}]}]}}),
                encoding="utf-8")
            (root / "hooks" / "go.js").write_text("process.exit(0)\n", encoding="utf-8")
        if executable:
            (root / "bin").mkdir()
            script = root / "bin" / "tool.sh"
            script.write_text("#!/bin/sh\necho hi\n", encoding="utf-8")
            script.chmod(0o755)
        if package_json:
            (root / "package.json").write_text(json.dumps(
                {"name": name, "scripts": {"postinstall": f"touch {self.home}/POSTINSTALL-RAN"}}),
                encoding="utf-8")
        if symlink is not None:
            (root / "escape").symlink_to(symlink)
        return root

    def git_fixture(self, name="gitplug", **kwargs):
        """A local git repository holding a plugin, so the git path is really exercised."""
        source = self.candidate(name, **kwargs)
        subprocess.run(["git", "init", "--quiet", "-b", "main"], cwd=source, check=True)
        subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=source, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=source, check=True)
        # A shallow fetch of an exact object needs the server to allow it.
        subprocess.run(["git", "config", "uploadpack.allowAnySHA1InWant", "true"],
                       cwd=source, check=True)
        subprocess.run(["git", "add", "-A"], cwd=source, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "plugin"], cwd=source, check=True)
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=source, check=True,
                                text=True, capture_output=True).stdout.strip()
        return f"file://{source}", commit


class ImportRefusalTest(PluginTestCase):
    """What the door turns away, and why."""

    def test_a_plain_plugin_imports_and_is_namespaced_under_user(self):
        source = self.candidate("acme")
        self.fde("plugins", "add", str(source))
        catalog = json.loads(self.fde("capabilities", "--json").stdout)
        ids = {item["id"] for item in catalog["items"]}
        self.assertIn("plugin:user:acme", ids)
        self.assertIn("skill:user:acme:alpha", ids)

    def test_an_import_records_a_checksum_and_its_provenance(self):
        source = self.candidate("acme")
        self.fde("plugins", "add", str(source), "--ref", "v1.0.0",
                 "--url", "https://example.invalid/acme", "--note", "reviewed for the test")
        lock = json.loads((self.plugins / "acme" / ".claude-plugin" / "fde-lock.json")
                          .read_text(encoding="utf-8"))
        self.assertEqual(lock["schemaVersion"], 1)
        self.assertEqual(lock["url"], "https://example.invalid/acme")
        self.assertEqual(lock["ref"], "v1.0.0")
        self.assertEqual(lock["license"], "MIT")
        self.assertEqual(lock["validationStatus"], "valid")
        self.assertTrue(lock["treeSha256"])
        self.assertTrue(lock["installedAt"])
        self.assertEqual(lock["reviewNote"], "reviewed for the test")
        self.assertTrue(all(entry["sha256"] for entry in lock["files"]))

    def test_hooks_are_not_imported_until_somebody_has_read_them(self):
        source = self.candidate("acme", hooks=True)
        result = self.fde("plugins", "add", str(source), expected=2)
        self.assertIn("--accept-hooks", result.stderr)
        self.assertFalse((self.plugins / "acme").exists())
        self.fde("plugins", "add", str(source), "--accept-hooks")
        self.assertTrue((self.plugins / "acme").exists())

    def test_executables_are_not_imported_until_somebody_has_read_them(self):
        source = self.candidate("acme", executable=True)
        result = self.fde("plugins", "add", str(source), expected=2)
        self.assertIn("--accept-executables", result.stderr)
        self.fde("plugins", "add", str(source), "--accept-executables")

    def test_a_symbolic_link_is_refused(self):
        source = self.candidate("acme", symlink="/etc/passwd")
        result = self.fde("plugins", "add", str(source), expected=2)
        self.assertIn("symbolic link", result.stderr)
        self.assertFalse((self.plugins / "acme").exists())

    def test_a_link_to_a_directory_outside_the_tree_is_refused(self):
        source = self.candidate("acme", symlink=str(self.home))
        self.fde("plugins", "add", str(source), expected=2)
        self.assertFalse((self.plugins / "acme").exists())

    def test_a_manifest_that_does_not_parse_is_refused(self):
        source = self.candidate("acme")
        (source / ".claude-plugin" / "plugin.json").write_text("{ not json", encoding="utf-8")
        result = self.fde("plugins", "add", str(source), expected=2)
        self.assertIn("manifest", result.stderr)

    def test_a_missing_manifest_is_refused(self):
        source = self.candidate("acme", manifest=False)
        self.fde("plugins", "add", str(source), expected=2)

    def test_a_manifest_naming_a_different_plugin_is_refused(self):
        source = self.candidate("acme", manifest_name="something-else")
        result = self.fde("plugins", "add", str(source), "--name", "acme", expected=2)
        self.assertIn("something-else", result.stderr)

    def test_the_built_in_plugin_cannot_be_replaced_by_an_import(self):
        source = self.candidate("fde-core", manifest_name="fde-core")
        result = self.fde("plugins", "add", str(source), expected=2)
        self.assertIn("built-in", result.stderr)

    def test_a_reserved_namespace_cannot_be_claimed_by_an_unrelated_plugin(self):
        source = self.candidate("ponytail", manifest_name="ponytail")
        result = self.fde("plugins", "add", str(source), expected=2)
        self.assertIn("reserved namespace", result.stderr)

    def test_a_tree_over_the_file_cap_is_refused(self):
        source = self.candidate("acme", files=3)
        original = imports.MAX_FILES
        try:
            imports.MAX_FILES = 2
            report = imports.inspect_tree(source)
            problems = imports.validate_import(report)
            self.assertIn("too-many-files", {problem["code"] for problem in problems})
        finally:
            imports.MAX_FILES = original

    def test_an_installation_script_is_reported_and_never_run(self):
        source = self.candidate("acme", package_json=True)
        summary = json.loads(self.fde("plugins", "add", str(source), "--json").stdout)
        self.assertIn("package.json", summary["installFiles"])
        self.assertFalse((self.home / "POSTINSTALL-RAN").exists(),
                         "FDE must never execute a plugin's installation script")
        self.assertIn("package.json",
                      {entry.get("name") for entry in summary["dependencies"]})

    def test_a_dry_run_installs_nothing(self):
        source = self.candidate("acme")
        summary = json.loads(self.fde("plugins", "add", str(source), "--dry-run", "--json").stdout)
        self.assertTrue(summary["dryRun"])
        self.assertTrue(summary["treeSha256"])
        self.assertFalse((self.plugins / "acme").exists())

    def test_include_patterns_prune_the_tree_and_are_recorded(self):
        source = self.candidate("acme", files=2)
        self.fde("plugins", "add", str(source), "--include", ".claude-plugin/plugin.json",
                 "--include", "LICENSE", "--include", "skills/alpha")
        installed = {str(path.relative_to(self.plugins / "acme"))
                     for path in (self.plugins / "acme").rglob("*") if path.is_file()}
        self.assertIn("skills/alpha/SKILL.md", installed)
        self.assertNotIn("skills/alpha1/SKILL.md", installed)
        lock = json.loads((self.plugins / "acme" / ".claude-plugin" / "fde-lock.json")
                          .read_text(encoding="utf-8"))
        self.assertEqual(lock["importedPaths"],
                         [".claude-plugin/plugin.json", "LICENSE", "skills/alpha"])

    def test_the_dependency_report_names_the_runtime_a_hook_needs(self):
        source = self.candidate("acme", hooks=True)
        summary = json.loads(self.fde("plugins", "add", str(source), "--accept-hooks",
                                      "--json").stdout)
        self.assertIn("node", {entry.get("name") for entry in summary["dependencies"]})


class GitImportTest(PluginTestCase):
    """A git source is pinned to a commit or it is not imported."""

    def test_a_git_source_without_a_commit_is_refused(self):
        url, _commit = self.git_fixture()
        result = self.fde("plugins", "add", url, expected=2)
        self.assertIn("commit", result.stderr.lower())
        self.assertFalse((self.plugins / "gitplug").exists())

    def test_a_branch_name_is_not_accepted_as_a_pin(self):
        url, _commit = self.git_fixture()
        self.fde("plugins", "add", url, "--commit", "main", expected=2)

    def test_a_pinned_commit_is_fetched_and_verified(self):
        url, commit = self.git_fixture()
        summary = json.loads(self.fde("plugins", "add", url, "--commit", commit,
                                      "--ref", "v1", "--json").stdout)
        self.assertEqual(summary["source"]["commit"], commit)
        lock = json.loads((self.plugins / "gitplug" / ".claude-plugin" / "fde-lock.json")
                          .read_text(encoding="utf-8"))
        self.assertTrue(lock["commitVerified"],
                        "a commit FDE fetched itself is verified, not merely asserted")
        self.assertTrue(lock["commitDate"])
        self.assertFalse((self.plugins / "gitplug" / ".git").exists(),
                         "the git metadata must not be installed with the plugin")

    def test_a_commit_that_does_not_exist_is_refused(self):
        url, _commit = self.git_fixture()
        self.fde("plugins", "add", url, "--commit", "0" * 40, expected=2)
        self.assertFalse((self.plugins / "gitplug").exists())

    def test_a_locally_supplied_commit_is_recorded_but_not_claimed_as_verified(self):
        source = self.candidate("acme")
        self.fde("plugins", "add", str(source), "--commit", "a" * 40)
        lock = json.loads((self.plugins / "acme" / ".claude-plugin" / "fde-lock.json")
                          .read_text(encoding="utf-8"))
        self.assertEqual(lock["commit"], "a" * 40)
        self.assertFalse(lock["commitVerified"])


class VerifyRollbackTest(PluginTestCase):
    def test_verify_notices_an_edited_file(self):
        source = self.candidate("acme")
        self.fde("plugins", "add", str(source))
        self.fde("plugins", "verify", "acme")
        target = self.plugins / "acme" / "skills" / "alpha" / "SKILL.md"
        target.write_text(target.read_text(encoding="utf-8") + "\ntampered\n", encoding="utf-8")
        result = self.fde("plugins", "verify", "acme", expected=1)
        payload = json.loads(self.fde("plugins", "verify", "acme", "--json", expected=0).stdout)
        self.assertEqual(payload["results"][0]["state"], "drifted")
        self.assertIn("skills/alpha/SKILL.md", payload["results"][0]["changed"])
        self.assertIn("drifted", result.stdout)

    def test_verify_notices_an_added_and_a_removed_file(self):
        source = self.candidate("acme")
        self.fde("plugins", "add", str(source))
        (self.plugins / "acme" / "EXTRA.md").write_text("hello\n", encoding="utf-8")
        (self.plugins / "acme" / "LICENSE").unlink()
        payload = json.loads(self.fde("plugins", "verify", "acme", "--json").stdout)["results"][0]
        self.assertEqual(payload["state"], "drifted")
        self.assertIn("EXTRA.md", payload["added"])
        self.assertIn("LICENSE", payload["removed"])

    def test_an_unpinned_plugin_says_so_rather_than_reporting_valid(self):
        source = self.candidate("acme")
        self.fde("plugins", "add", str(source))
        (self.plugins / "acme" / ".claude-plugin" / "fde-lock.json").unlink()
        payload = json.loads(self.fde("plugins", "verify", "acme", "--json").stdout)["results"][0]
        self.assertEqual(payload["state"], "unpinned")

    def test_an_update_keeps_the_version_it_replaced_and_rollback_restores_it(self):
        source = self.candidate("acme")
        self.fde("plugins", "add", str(source))
        first = json.loads((self.plugins / "acme" / ".claude-plugin" / "fde-lock.json")
                           .read_text(encoding="utf-8"))["treeSha256"]

        (source / "skills" / "alpha" / "SKILL.md").write_text(
            "---\nname: alpha\ndescription: A revised test skill.\n---\n\n# alpha v2\n",
            encoding="utf-8")
        self.fde("plugins", "update", str(source), "--name", "acme")
        second = json.loads((self.plugins / "acme" / ".claude-plugin" / "fde-lock.json")
                            .read_text(encoding="utf-8"))["treeSha256"]
        self.assertNotEqual(first, second)
        self.assertTrue(imports.versions_of(self.shared, "acme"))

        self.fde("plugins", "rollback", "acme")
        restored = json.loads((self.plugins / "acme" / ".claude-plugin" / "fde-lock.json")
                              .read_text(encoding="utf-8"))["treeSha256"]
        self.assertEqual(restored, first)
        self.fde("plugins", "verify", "acme")

    def test_update_refuses_a_plugin_that_is_not_installed(self):
        source = self.candidate("acme")
        self.fde("plugins", "update", str(source), "--name", "acme", expected=2)

    def test_rollback_with_nothing_to_roll_back_to_is_refused(self):
        source = self.candidate("acme")
        self.fde("plugins", "add", str(source))
        self.fde("plugins", "rollback", "acme", expected=2)

    def test_remove_keeps_the_tree_and_delists_it(self):
        source = self.candidate("acme")
        self.fde("plugins", "add", str(source))
        marketplace = self.shared / "fde-toolkit" / ".claude-plugin" / "marketplace.json"
        self.assertIn("acme", {entry["name"] for entry in
                               json.loads(marketplace.read_text(encoding="utf-8"))["plugins"]})
        payload = json.loads(self.fde("plugins", "remove", "acme", "--json").stdout)
        self.assertFalse((self.plugins / "acme").exists())
        self.assertTrue(Path(payload["keptAs"]).is_dir())
        self.assertNotIn("acme", {entry["name"] for entry in
                                  json.loads(marketplace.read_text(encoding="utf-8"))["plugins"]})

    def test_the_built_in_plugin_cannot_be_removed(self):
        self.fde("plugins", "remove", "fde-core", expected=2)


class PonytailTest(PluginTestCase):
    """Ponytail is pinned, validated, namespaced and configurable."""

    def test_ponytail_ships_pinned_with_its_licence_recorded(self):
        payload = json.loads(self.fde("plugins", "show", "ponytail", "--json").stdout)["plugin"]
        self.assertEqual(payload["namespace"], "ponytail")
        self.assertEqual(payload["origin"], "external")
        self.assertEqual(payload["commit"], PONYTAIL_COMMIT)
        self.assertEqual(payload["license"], "MIT")
        self.assertTrue(payload["pinned"])
        self.assertTrue(payload["checksum"].startswith("sha256:"))
        self.assertEqual(payload["url"], "https://github.com/dietrichgebert/ponytail")

    def test_the_vendored_tree_still_matches_its_pin(self):
        payload = json.loads(self.fde("plugins", "verify", "ponytail", "--json").stdout)
        self.assertEqual(payload["results"][0]["state"], "valid")

    def test_its_licence_text_travels_with_it(self):
        licence = (self.plugins / "ponytail" / "LICENSE").read_text(encoding="utf-8")
        self.assertIn("MIT License", licence)

    def test_every_contributed_capability_is_namespaced_and_visible(self):
        catalog = json.loads(self.fde("capabilities", "--namespace", "ponytail", "--json").stdout)
        ids = {item["id"] for item in catalog["items"]}
        self.assertIn("plugin:ponytail", ids)
        for skill in ("ponytail", "ponytail-review", "ponytail-audit", "ponytail-debt",
                      "ponytail-gain", "ponytail-help"):
            self.assertIn(f"skill:ponytail:{skill}", ids)
        for event in ("SessionStart", "SubagentStart", "UserPromptSubmit"):
            self.assertIn(f"hook:ponytail:{event}", ids)

    def test_its_node_dependency_is_surfaced(self):
        payload = json.loads(self.fde("plugins", "show", "ponytail", "--json").stdout)["plugin"]
        self.assertIn("node", {entry.get("name") for entry in payload["dependencies"]})

    def test_each_contributed_capability_can_be_disabled_on_its_own(self):
        for cid in ("skill:ponytail:ponytail", "hook:ponytail:SessionStart",
                    "hook:ponytail:UserPromptSubmit"):
            self.fde("config", "set", cid, "disabled")
            document, _ = self.resolved("--workflow", "forward-deployed-engineer",
                                        "--stage", "vertical-slice")
            self.assertNotIn(cid, document["enabled"])
            self.fde("config", "reset", cid)
        document, _ = self.resolved("--workflow", "forward-deployed-engineer",
                                    "--stage", "vertical-slice")
        self.assertIn("skill:ponytail:ponytail", document["enabled"])

    def test_disabling_the_plugin_takes_every_contribution_with_it(self):
        self.fde("config", "set", "plugin:ponytail", "disabled")
        document, entries = self.resolved("--workflow", "forward-deployed-engineer",
                                          "--stage", "vertical-slice")
        self.assertEqual([cid for cid in document["enabled"] if "ponytail" in cid], [])
        self.assertEqual(entries["hook:ponytail:SessionStart"]["effective"], "parent-disabled")
        self.assertEqual(document["settings"]["ponytail.mode"]["value"], "off")

    def test_disabling_one_hook_leaves_the_others_alone(self):
        self.fde("config", "set", "hook:ponytail:SessionStart", "disabled")
        document, _ = self.resolved("--workflow", "forward-deployed-engineer",
                                    "--stage", "vertical-slice")
        self.assertNotIn("hook:ponytail:SessionStart", document["enabled"])
        self.assertIn("hook:ponytail:SubagentStart", document["enabled"])
        self.assertIn("skill:ponytail:ponytail", document["enabled"])

    def test_its_hooks_are_off_in_stages_where_ponytail_is_off(self):
        for stage in ("business-intent", "solution-requirements", "technical-architecture",
                      "development-planning", "documentation", "scm-build-deploy", "operations"):
            document, _ = self.resolved("--workflow", "forward-deployed-engineer", "--stage", stage)
            self.assertEqual([cid for cid in document["enabled"] if "ponytail" in cid], [], stage)

    def test_the_mode_is_full_for_implementation_and_lite_for_review(self):
        for stage, expected in (("vertical-slice", "full"), ("quality-review", "lite"),
                                ("business-intent", "off")):
            document, _ = self.resolved("--workflow", "forward-deployed-engineer", "--stage", stage)
            self.assertEqual(document["settings"]["ponytail.mode"]["value"], expected, stage)

    def test_the_mode_is_selectable_by_workflow_and_by_stage(self):
        self.fde("config", "set-option", "ponytail.mode", "ultra",
                 "--scope", "stage:forward-deployed-engineer/vertical-slice")
        self.fde("config", "set-option", "ponytail.mode", "lite",
                 "--scope", "workflow:forward-deployed-engineer")
        narrow, _ = self.resolved("--workflow", "forward-deployed-engineer", "--stage", "vertical-slice")
        wide, _ = self.resolved("--workflow", "forward-deployed-engineer", "--stage", "quality-review")
        self.assertEqual(narrow["settings"]["ponytail.mode"]["value"], "ultra")
        self.assertEqual(narrow["settings"]["ponytail.mode"]["layer"], "stage")
        self.assertEqual(wide["settings"]["ponytail.mode"]["value"], "lite")
        self.assertEqual(wide["settings"]["ponytail.mode"]["layer"], "workflow")

    def test_a_mode_the_template_does_not_offer_is_refused(self):
        result = self.fde("config", "set-option", "ponytail.mode", "aggressive", expected=2)
        self.assertIn("off, lite, full, ultra", result.stderr)

    def test_the_expensive_repository_wide_skills_are_offered_never_enabled(self):
        template = json.loads(self.fde("workflow", "show", "forward-deployed-engineer",
                                       "--json").stdout)["workflow"]
        offered = {cid for stage in template["stages"] for cid in stage.get("optional", [])}
        for skill in ("ponytail-audit", "ponytail-debt", "ponytail-gain"):
            self.assertIn(f"skill:ponytail:{skill}", offered)
        for stage in template["stages"]:
            document, _ = self.resolved("--workflow", "forward-deployed-engineer",
                                        "--stage", stage["name"])
            for skill in ("ponytail-audit", "ponytail-debt", "ponytail-gain"):
                self.assertNotIn(f"skill:ponytail:{skill}", document["enabled"], stage["name"])

    def test_an_offered_skill_can_be_switched_on_when_the_work_calls_for_it(self):
        self.fde("config", "set", "skill:ponytail:ponytail-audit", "enabled",
                 "--scope", "stage:forward-deployed-engineer/quality-review")
        document, _ = self.resolved("--workflow", "forward-deployed-engineer",
                                    "--stage", "quality-review")
        self.assertIn("skill:ponytail:ponytail-audit", document["enabled"])


class GovernanceTest(PluginTestCase):
    """Ponytail cannot override security or acceptance requirements."""

    def test_the_workflow_states_what_no_plugin_may_override(self):
        document, _ = self.resolved("--workflow", "forward-deployed-engineer",
                                    "--stage", "vertical-slice")
        governance = document["governance"]
        self.assertIn("take precedence", governance["statement"])
        for protected in ("business acceptance criteria", "security requirements",
                          "privacy requirements", "accessibility requirements",
                          "required error handling", "data-loss protection",
                          "regulatory controls", "recorded architectural decisions",
                          "required testing", "human approval gates"):
            self.assertIn(protected, governance["neverOverridden"])

    def test_governance_travels_into_the_run_snapshot(self):
        run_id = next(line.split()[1] for line in
                      self.fde("start", "a governance test run").stdout.splitlines()
                      if line.startswith("run "))
        self.fde("capabilities", "snapshot", run_id, "--stage", "vertical-slice")
        snapshot = json.loads((self.shared / "runs" / run_id / "capabilities" /
                               "snapshot-primary-1.json").read_text(encoding="utf-8"))
        self.assertIn("skill:ponytail:ponytail", {e["id"] for e in snapshot["capabilities"]})
        self.assertEqual(snapshot["settings"]["ponytail.mode"]["value"], "full")
        self.assertTrue(snapshot["governance"]["neverOverridden"])

    def test_a_security_required_capability_stays_on_in_a_ponytail_stage(self):
        (self.shared / "config" / "security-policy.json").write_text(json.dumps(
            {"schemaVersion": 1, "required": ["plugin:fde", "skill:fde:tdd-evidence"],
             "forbidden": []}), encoding="utf-8")
        self.fde("config", "set", "skill:fde:tdd-evidence", "disabled", expected=2)
        document, entries = self.resolved("--workflow", "forward-deployed-engineer",
                                          "--stage", "vertical-slice")
        self.assertIn("skill:fde:tdd-evidence", document["enabled"])
        self.assertEqual(entries["skill:fde:tdd-evidence"]["layer"], "security")

    def test_a_security_forbidden_capability_stays_off_in_a_ponytail_stage(self):
        (self.shared / "config" / "security-policy.json").write_text(json.dumps(
            {"schemaVersion": 1, "required": ["plugin:fde"],
             "forbidden": ["skill:ponytail:ponytail"]}), encoding="utf-8")
        # Refused at the command, because a decision layer 1 will override is
        # worse than useless: it looks like it worked.
        result = self.fde("config", "set", "skill:ponytail:ponytail", "enabled", expected=2)
        self.assertIn("forbidden by the runtime security policy", result.stderr)
        # And refused again at resolution, for anything that got in another way.
        config = cap.Config.load(self.shared)
        config.doc["global"]["skill:ponytail:ponytail"] = "enabled"
        config.save()
        document, entries = self.resolved("--workflow", "forward-deployed-engineer",
                                          "--stage", "vertical-slice")
        self.assertNotIn("skill:ponytail:ponytail", document["enabled"])
        self.assertEqual(entries["skill:ponytail:ponytail"]["effective"], "blocked")
        self.assertEqual(entries["skill:ponytail:ponytail"]["layer"], "security")

    def test_the_plugin_cannot_grant_itself_a_tool_the_stage_withholds(self):
        """A bundle is the selection. Importing a plugin does not widen it."""
        for stage in ("business-intent", "solution-requirements"):
            document, _ = self.resolved("--workflow", "forward-deployed-engineer", "--stage", stage)
            self.assertNotIn("tool:fde:Bash", document["enabled"], stage)
            self.assertNotIn("tool:fde:Edit", document["enabled"], stage)


if __name__ == "__main__":
    unittest.main()
