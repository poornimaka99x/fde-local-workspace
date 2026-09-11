"""Acceptance coverage for capability discovery, inheritance and snapshots.

The numbered tests are the ones the capability-bundle requirement asks for by
name. They are written against the controller's CLI rather than the library,
because the requirement is about what an operator and the runtime actually get,
and a library that resolves correctly behind a command that does not wire it up
is not a passing state.
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
import fde_capabilities as cap  # noqa: E402
import fde_mcp  # noqa: E402


class CapabilityTestCase(unittest.TestCase):
    """A throwaway installation: the real toolkit, an empty configuration."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.shared = self.home / ".claude-shared"
        shutil.copytree(SHARED_SRC, self.shared,
                        ignore=shutil.ignore_patterns("runs", "__pycache__", ".env.sh", "env.sh"))
        shutil.copytree(TOOLKIT_SRC, self.shared / "fde-toolkit",
                        ignore=shutil.ignore_patterns("__pycache__"))
        (self.shared / "runs").mkdir(exist_ok=True)
        self.plugins = self.shared / "fde-toolkit" / "plugins"
        self.env = dict(os.environ)
        self.env.update({
            "HOME": str(self.home),
            "CLAUDE_SHARED": str(self.shared),
            "CLAUDE_PROFILES_DIR": str(self.home / ".claude-profiles"),
            "FDE_RUNS_DIR": str(self.shared / "runs"),
        })

    def tearDown(self):
        self.tmp.cleanup()

    # -- helpers ------------------------------------------------------------

    def fde(self, *args, expected=0):
        result = subprocess.run([str(FDE), *args], text=True, capture_output=True, env=self.env)
        self.assertEqual(result.returncode, expected,
                         msg=f"args={args}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        return result

    def resolved(self, *args):
        out = self.fde("config", "show", "--json", "--all", *args).stdout
        document = json.loads(out)
        return document, {entry["id"]: entry for entry in document["capabilities"]}

    def install_plugin(self, name, *, skills=("alpha",), agents=("beta",)):
        """A second plugin, so parent/child behaviour is tested against a real one."""
        root = self.plugins / name
        (root / ".claude-plugin").mkdir(parents=True)
        (root / ".claude-plugin" / "plugin.json").write_text(
            json.dumps({"name": name, "version": "1.0.0", "description": f"{name} test plugin"}),
            encoding="utf-8")
        for skill in skills:
            directory = root / "skills" / skill
            directory.mkdir(parents=True)
            (directory / "SKILL.md").write_text(
                f"---\nname: {skill}\ndescription: A test skill named {skill}.\n---\n\n# {skill}\n",
                encoding="utf-8")
        for agent in agents:
            directory = root / "agents"
            directory.mkdir(parents=True, exist_ok=True)
            (directory / f"{agent}.md").write_text(
                f"---\nname: {agent}\ndescription: A test agent named {agent}.\n---\n\n# {agent}\n",
                encoding="utf-8")
        return cap.plugin_namespace(name)

    def new_run(self):
        out = self.fde("start", "a capability test run").stdout
        return next(line.split()[1] for line in out.splitlines() if line.startswith("run "))


class DiscoveryTest(CapabilityTestCase):
    def test_discovery_finds_every_installed_capability_kind(self):
        catalog = json.loads(self.fde("capabilities", "--json").stdout)
        counts = catalog["counts"]
        self.assertEqual(catalog["warnings"], [])
        for kind in ("plugin", "skill", "agent", "mcp", "tool", "command", "hook", "script", "workflow"):
            self.assertGreater(counts[kind], 0, f"nothing discovered for {kind}")
        # The inventory is discovered, not hardcoded: the skills on disk and the
        # skills reported are the same set.
        on_disk = {path.name for path in (self.plugins / "fde-core" / "skills").iterdir() if path.is_dir()}
        reported = {item["name"] for item in catalog["items"]
                    if item["kind"] == "skill" and item["namespace"] == "fde"}
        self.assertEqual(on_disk, reported)
        vendored = {path.name for path in (self.plugins / "ponytail" / "skills").iterdir() if path.is_dir()}
        self.assertEqual(vendored, {item["name"] for item in catalog["items"]
                                    if item["kind"] == "skill" and item["namespace"] == "ponytail"})

    def test_a_newly_installed_plugin_appears_without_any_registration(self):
        before = json.loads(self.fde("capabilities", "--json").stdout)["counts"]["skill"]
        self.install_plugin("acme", skills=("deploy-check",), agents=())
        after = json.loads(self.fde("capabilities", "--json").stdout)
        self.assertEqual(after["counts"]["skill"], before + 1)
        self.assertIn("skill:user:acme:deploy-check", {item["id"] for item in after["items"]})

    def test_namespaces_keep_same_named_capabilities_apart(self):
        self.install_plugin("acme", skills=("crosscheck",), agents=())
        ids = {item["id"] for item in json.loads(self.fde("capabilities", "--json").stdout)["items"]}
        self.assertIn("skill:fde:crosscheck", ids)
        self.assertIn("skill:user:acme:crosscheck", ids)

    def test_every_capability_carries_provenance_and_health(self):
        for item in json.loads(self.fde("capabilities", "--json").stdout)["items"]:
            self.assertIn("provenance", item, item["id"])
            self.assertIn(item["health"]["state"],
                          ("ok", "degraded", "invalid", "unavailable", "unknown"), item["id"])
            self.assertIn(item["availability"], ("available", "unavailable", "blocked"), item["id"])

    def test_an_invalid_manifest_is_reported_rather_than_dropped(self):
        self.install_plugin("acme", skills=(), agents=())
        broken = self.plugins / "acme" / "skills" / "broken"
        broken.mkdir(parents=True)
        (broken / "SKILL.md").write_text("no front matter here\n", encoding="utf-8")
        result = self.fde("capabilities", "validate", "--json", expected=0)
        catalog = json.loads(self.fde("capabilities", "--json").stdout)
        self.assertIn("skill:user:acme:broken", {item["id"] for item in catalog["items"]})
        self.assertEqual(json.loads(result.stdout)["problems"], [])

    def test_validate_fails_when_a_referenced_file_is_missing(self):
        self.install_plugin("acme", skills=("alpha",), agents=())
        (self.plugins / "acme" / "skills" / "alpha" / "SKILL.md").unlink()
        result = self.fde("capabilities", "validate", "--json", expected=1)
        problems = {entry["id"] for entry in json.loads(result.stdout)["problems"]}
        self.assertIn("skill:user:acme:alpha", problems)


class DefaultsTest(CapabilityTestCase):
    """1. Sensible FDE defaults are active on first use."""

    def test_the_forward_deployed_engineer_workflow_is_separately_selectable(self):
        workflows = json.loads(self.fde("workflows", "--json").stdout)["workflows"]
        names = {entry["name"] for entry in workflows}
        self.assertIn("forward-deployed-engineer", names)
        template = next(entry for entry in workflows if entry["name"] == "forward-deployed-engineer")
        self.assertEqual(len(template["stages"]), 9)

    def test_every_stage_has_a_usable_default_bundle_with_no_configuration(self):
        self.assertFalse(cap.config_file(self.shared).exists(),
                         "the fixture must start with no operator configuration")
        template = json.loads(self.fde("workflow", "show", "forward-deployed-engineer",
                                       "--json").stdout)["workflow"]
        for stage in template["stages"]:
            document, entries = self.resolved("--workflow", "forward-deployed-engineer",
                                              "--stage", stage["name"])
            kinds = {entries[cid]["kind"] for cid in document["enabled"]}
            self.assertIn("skill", kinds, f"{stage['name']} has no skill")
            self.assertIn("agent", kinds, f"{stage['name']} has no sub-agent")
            for tool in ("tool:fde:Read", "tool:fde:Grep", "tool:fde:Glob"):
                self.assertIn(tool, document["enabled"], f"{stage['name']} lacks {tool}")
            self.assertEqual(document["missing"], [],
                             f"{stage['name']} names capabilities that are not installed")
            self.assertEqual(document["inconsistent"], [],
                             f"{stage['name']} enables a capability whose plugin it leaves off")

    def _template(self, name, stage):
        target = cap.workflows_root(self.shared) / f"{name}.json"
        target.write_text(json.dumps({
            "schemaVersion": 1, "name": name, "revision": "test.1",
            "stages": [{"name": "only", "controllerStages": ["intake"], **stage}]}),
            encoding="utf-8")

    def test_a_bundle_entry_that_is_not_installed_is_reported_never_invented(self):
        self._template("probe", {"common": {"enable": ["skill:fde:nonexistent",
                                                       "agent:user:ghost:missing"]}})
        document, entries = self.resolved("--workflow", "probe", "--stage", "only")
        self.assertEqual({entry["id"] for entry in document["missing"]},
                         {"skill:fde:nonexistent", "agent:user:ghost:missing"})
        for entry in document["missing"]:
            self.assertEqual(entry["reason"], "not installed")
            self.assertNotIn(entry["id"], entries,
                             "a capability that is not installed must not appear as resolved")

    def test_a_bundle_that_forgets_the_parent_plugin_is_named_not_swallowed(self):
        self._template("probe", {"common": {"enable": ["skill:ponytail:ponytail"]}})
        document, entries = self.resolved("--workflow", "probe", "--stage", "only")
        self.assertNotIn("skill:ponytail:ponytail", document["enabled"])
        self.assertEqual(entries["skill:ponytail:ponytail"]["effective"], "parent-disabled")
        self.assertEqual([entry["id"] for entry in document["inconsistent"]],
                         ["skill:ponytail:ponytail"])

    def test_a_stage_bundle_is_a_selection_not_the_whole_installation(self):
        document, _ = self.resolved("--workflow", "forward-deployed-engineer",
                                    "--stage", "business-intent")
        # Analysis reads and writes. It does not get a shell by default.
        self.assertIn("tool:fde:WebSearch", document["enabled"])
        self.assertNotIn("tool:fde:Bash", document["enabled"])
        self.assertNotIn("agent:fde:release-manager", document["enabled"])

    def test_operations_defaults_to_read_only_investigation(self):
        document, _ = self.resolved("--workflow", "forward-deployed-engineer", "--stage", "operations")
        self.assertNotIn("tool:fde:Bash", document["enabled"])
        self.assertNotIn("tool:fde:Edit", document["enabled"])
        template = json.loads(self.fde("workflow", "show", "forward-deployed-engineer",
                                       "--json").stdout)["workflow"]
        stage = next(entry for entry in template["stages"] if entry["name"] == "operations")
        for scope in stage["mcpScopes"].values():
            self.assertTrue(set(scope) <= {"read", "search"}, scope)

    def test_outside_a_workflow_the_whole_installed_surface_is_available(self):
        document, entries = self.resolved()
        self.assertIn("skill:fde:engage", document["enabled"])
        self.assertEqual(entries["skill:fde:engage"]["effective"], "inherited-enabled")


class DisableTest(CapabilityTestCase):
    """2-7. Switching things off, and the ways that must not be undone."""

    def test_every_non_protected_default_can_be_disabled(self):
        document, entries = self.resolved("--workflow", "forward-deployed-engineer",
                                          "--stage", "vertical-slice")
        defaults = [cid for cid in document["enabled"] if not entries[cid]["protected"]]
        self.assertGreater(len(defaults), 5)
        for cid in defaults:
            self.fde("config", "set", cid, "disabled")
        after, _ = self.resolved("--workflow", "forward-deployed-engineer", "--stage", "vertical-slice")
        self.assertEqual([cid for cid in after["enabled"] if cid in defaults], [])

    def test_a_protected_capability_cannot_be_disabled(self):
        result = self.fde("config", "set", "plugin:fde", "disabled", expected=2)
        self.assertIn("required by the FDE control plane", result.stderr)
        document, _ = self.resolved()
        self.assertIn("plugin:fde", document["enabled"])

    def test_an_explicit_disable_survives_an_upgrade(self):
        self.fde("config", "set", "skill:fde:implementation", "disabled")
        target = cap.workflows_root(self.shared) / "forward-deployed-engineer.json"
        template = json.loads(target.read_text(encoding="utf-8"))
        # A newer FDE ships a newer template that still wants this skill on.
        template["revision"] = "2099-01-01.1"
        for stage in template["stages"]:
            stage["common"]["enable"] = sorted(set(stage["common"]["enable"]) | {"skill:fde:implementation"})
        target.write_text(json.dumps(template, indent=2), encoding="utf-8")
        document, entries = self.resolved("--workflow", "forward-deployed-engineer",
                                          "--stage", "vertical-slice")
        self.assertEqual(document["workflowRevision"], "2099-01-01.1")
        self.assertNotIn("skill:fde:implementation", document["enabled"])
        self.assertEqual(entries["skill:fde:implementation"]["effective"], "user-disabled")

    def test_resetting_an_override_returns_it_to_the_inherited_default(self):
        self.fde("config", "set", "skill:fde:implementation", "disabled")
        _document, entries = self.resolved("--workflow", "forward-deployed-engineer",
                                           "--stage", "vertical-slice")
        self.assertEqual(entries["skill:fde:implementation"]["state"], "disabled")
        self.fde("config", "reset", "skill:fde:implementation")
        document, entries = self.resolved("--workflow", "forward-deployed-engineer",
                                          "--stage", "vertical-slice")
        self.assertIn("skill:fde:implementation", document["enabled"])
        self.assertEqual(entries["skill:fde:implementation"]["effective"], "fde-default")
        self.assertEqual(entries["skill:fde:implementation"]["layer"], "builtin")

    def test_disabling_a_parent_plugin_makes_its_contributions_ineffective(self):
        self.install_plugin("acme", skills=("alpha",), agents=("beta",))
        self.fde("config", "set", "plugin:user:acme", "disabled")
        document, entries = self.resolved()
        self.assertNotIn("skill:user:acme:alpha", document["enabled"])
        self.assertNotIn("agent:user:acme:beta", document["enabled"])
        self.assertEqual(entries["skill:user:acme:alpha"]["effective"], "parent-disabled")

    def test_re_enabling_a_parent_restores_what_the_operator_had_not_a_default(self):
        self.install_plugin("acme", skills=("alpha", "gamma"), agents=())
        self.fde("config", "set", "skill:user:acme:gamma", "disabled")
        self.fde("config", "set", "plugin:user:acme", "disabled")
        self.fde("config", "set", "plugin:user:acme", "enabled")
        document, _ = self.resolved()
        self.assertIn("skill:user:acme:alpha", document["enabled"])
        self.assertNotIn("skill:user:acme:gamma", document["enabled"])

    def test_disabling_a_child_leaves_its_parent_and_siblings_alone(self):
        self.install_plugin("acme", skills=("alpha", "gamma"), agents=("beta",))
        self.install_plugin("other", skills=("delta",), agents=())
        self.fde("config", "set", "skill:user:acme:alpha", "disabled")
        document, _ = self.resolved()
        self.assertNotIn("skill:user:acme:alpha", document["enabled"])
        for survivor in ("plugin:user:acme", "skill:user:acme:gamma", "agent:user:acme:beta",
                         "plugin:user:other", "skill:user:other:delta"):
            self.assertIn(survivor, document["enabled"], survivor)

    def test_a_disabled_capability_is_not_restored_by_a_stage_bundle(self):
        self.fde("config", "set", "skill:fde:quality-gates", "disabled")
        for stage in ("development-planning", "vertical-slice", "quality-review"):
            document, _ = self.resolved("--workflow", "forward-deployed-engineer", "--stage", stage)
            self.assertNotIn("skill:fde:quality-gates", document["enabled"], stage)

    def test_a_disabled_capability_is_not_restored_by_another_plugin(self):
        self.fde("config", "set", "skill:fde:crosscheck", "disabled")
        self.install_plugin("acme", skills=("crosscheck",), agents=())
        document, _ = self.resolved()
        self.assertNotIn("skill:fde:crosscheck", document["enabled"])
        self.assertIn("skill:user:acme:crosscheck", document["enabled"])

    def test_a_narrower_scope_overrides_a_broader_one_in_both_directions(self):
        self.fde("config", "set", "skill:fde:crosscheck", "disabled")
        self.fde("config", "set", "skill:fde:crosscheck", "enabled",
                 "--scope", "stage:forward-deployed-engineer/vertical-slice")
        wide, _ = self.resolved("--workflow", "forward-deployed-engineer", "--stage", "quality-review")
        narrow, entries = self.resolved("--workflow", "forward-deployed-engineer",
                                        "--stage", "vertical-slice")
        self.assertNotIn("skill:fde:crosscheck", wide["enabled"])
        self.assertIn("skill:fde:crosscheck", narrow["enabled"])
        self.assertEqual(entries["skill:fde:crosscheck"]["layer"], "stage")

    def test_the_reviewer_bundle_differs_from_the_primary_one(self):
        primary, _ = self.resolved("--workflow", "forward-deployed-engineer",
                                   "--stage", "vertical-slice", "--role", "primary")
        reviewer, _ = self.resolved("--workflow", "forward-deployed-engineer",
                                    "--stage", "vertical-slice", "--role", "reviewer")
        self.assertIn("tool:fde:Edit", primary["enabled"])
        self.assertNotIn("tool:fde:Edit", reviewer["enabled"])
        self.assertNotIn("tool:fde:Bash", reviewer["enabled"])
        self.assertNotIn("tool:fde:Task", reviewer["enabled"])
        self.assertIn("tool:fde:Write", reviewer["enabled"])


class McpSelectionTest(CapabilityTestCase):
    """An MCP default means 'selected when available', never 'go and connect'."""

    def test_an_unconnected_server_is_selected_but_not_active(self):
        _document, entries = self.resolved("--workflow", "forward-deployed-engineer",
                                           "--stage", "vertical-slice")
        serena = entries["mcp:fde:serena"]
        self.assertEqual(serena["state"], "enabled")
        self.assertFalse(serena["active"])
        self.assertEqual(serena["effective"], "unavailable")
        # The code is the MCP library's own lifecycle state, not a second
        # opinion invented here — that is what keeps the console and the
        # runtime from disagreeing about a connector.
        self.assertIn(serena["health"]["code"], fde_mcp.LIFECYCLE_STATES)
        self.assertNotIn(serena["health"]["code"], (fde_mcp.READY, fde_mcp.ACTIVE))
        self.assertEqual(serena["mcp"]["connectionState"], "selected-but-unavailable")

    def test_resolution_never_writes_to_the_mcp_catalogue_or_health(self):
        catalogue = self.shared / "mcp" / "mcp-servers.json"
        health = self.shared / "mcp" / "health.json"
        before = catalogue.read_bytes()
        health_before = health.read_bytes() if health.exists() else None
        self.resolved("--workflow", "forward-deployed-engineer", "--stage", "operations")
        self.assertEqual(catalogue.read_bytes(), before)
        self.assertEqual(health.read_bytes() if health.exists() else None, health_before)

    def test_a_degraded_capability_is_reported_with_its_reason(self):
        document, _ = self.resolved("--workflow", "forward-deployed-engineer", "--stage", "operations")
        degraded = {entry["ref"]: entry["reason"] for entry in document["degraded"]}
        self.assertIn("fde:aws", degraded)
        # Whatever the reason is, it has to be the real one and it has to name
        # something the operator can act on.
        self.assertTrue(degraded["fde:aws"])
        self.assertNotEqual(degraded["fde:aws"], "This capability is not usable right now.")


class FailClosedTest(CapabilityTestCase):
    """19. Malformed policy files fail closed."""

    def _corrupt(self, relative, body):
        target = self.shared / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")

    def test_an_unreadable_capability_configuration_refuses_to_resolve(self):
        self._corrupt("config/capability-config.json", "{ not json")
        result = self.fde("config", "show", expected=2)
        self.assertIn("could not be read", result.stderr)

    def test_a_wrong_schema_capability_configuration_refuses_to_resolve(self):
        self._corrupt("config/capability-config.json", json.dumps({"schemaVersion": 99}))
        self.fde("config", "show", expected=2)

    def test_an_unknown_state_refuses_rather_than_defaulting_to_enabled(self):
        self._corrupt("config/capability-config.json",
                      json.dumps({"schemaVersion": 1, "global": {"skill:fde:engage": "maybe"}}))
        result = self.fde("config", "show", expected=2)
        self.assertIn("enabled, disabled or inherit", result.stderr)

    def test_an_unreadable_security_policy_refuses_to_resolve(self):
        self._corrupt("config/security-policy.json", "{}")
        self.fde("config", "show", expected=2)

    def test_a_capability_both_required_and_forbidden_is_refused(self):
        self._corrupt("config/security-policy.json", json.dumps(
            {"schemaVersion": 1, "required": ["plugin:fde"], "forbidden": ["plugin:fde"]}))
        result = self.fde("config", "show", expected=2)
        self.assertIn("both required and forbidden", result.stderr)

    def test_a_forbidden_capability_cannot_be_enabled_by_any_layer(self):
        self._corrupt("config/security-policy.json", json.dumps(
            {"schemaVersion": 1, "required": ["plugin:fde"], "forbidden": ["tool:fde:Bash"]}))
        # The command refuses outright, because a decision layer 1 overrides is
        # worse than useless: it looks like it worked.
        result = self.fde("config", "set", "tool:fde:Bash", "enabled", expected=2)
        self.assertIn("forbidden by the runtime security policy", result.stderr)
        # And resolution refuses again, for anything written another way.
        config = cap.Config.load(self.shared)
        config.doc["global"]["tool:fde:Bash"] = "enabled"
        config.save()
        document, entries = self.resolved("--workflow", "forward-deployed-engineer",
                                          "--stage", "vertical-slice")
        self.assertNotIn("tool:fde:Bash", document["enabled"])
        self.assertEqual(entries["tool:fde:Bash"]["effective"], "blocked")
        self.assertEqual(entries["tool:fde:Bash"]["layer"], "security")

    def test_an_unreadable_plugin_lock_refuses_to_discover(self):
        self._corrupt("fde-toolkit/plugins/ponytail/.claude-plugin/fde-lock.json", "{ not json")
        self.fde("capabilities", "--json", expected=2)

    def test_a_wrong_schema_plugin_lock_refuses_to_discover(self):
        self._corrupt("fde-toolkit/plugins/ponytail/.claude-plugin/fde-lock.json",
                      json.dumps({"schemaVersion": 99}))
        self.fde("capabilities", "--json", expected=2)

    def test_an_invalid_workflow_template_is_skipped_and_named(self):
        self._corrupt("config/workflows/broken.json", json.dumps({"schemaVersion": 1, "name": "broken"}))
        catalog = json.loads(self.fde("capabilities", "--json").stdout)
        self.assertTrue(any("broken.json" in warning for warning in catalog["warnings"]))
        self.fde("workflow", "show", "broken", expected=2)
        # The valid template beside it is unaffected.
        self.fde("workflow", "show", "forward-deployed-engineer")

    def test_a_malformed_legacy_policy_migrates_nothing(self):
        cap.config_file(self.shared).unlink(missing_ok=True)
        self._corrupt("config/capability-policy.json", json.dumps({"schemaVersion": 1, "disabled": "all"}))
        self.fde("config", "show", expected=2)
        self.assertTrue((self.shared / "config" / "capability-policy.json").exists(),
                        "a failed migration must not consume the legacy file")
        self.assertFalse(cap.config_file(self.shared).exists(),
                         "a failed migration must not leave a half-written configuration")


class MigrationTest(CapabilityTestCase):
    """The v1 boolean policy comes forward without losing a decision."""

    def _legacy(self, document):
        (self.shared / "config" / "capability-policy.json").write_text(
            json.dumps(document), encoding="utf-8")

    def test_every_legacy_disable_survives_in_its_namespaced_form(self):
        self._legacy({"schemaVersion": 1,
                      "disabled": ["skill:fde-core:engage", "tool:WebFetch", "mcp:aws",
                                   "plugin:fde-core", "hook:fde-core:SessionStart",
                                   "script:fde-core:bin:which-account.sh"],
                      "disabledHooks": {"hook:fde-core:SessionStart": {"payload": [{"matcher": "startup"}]}}})
        exported = json.loads(self.fde("config", "export", "--json").stdout)
        self.assertEqual(set(exported["config"]["global"]), {
            "skill:fde:engage", "tool:fde:WebFetch", "mcp:fde:aws", "plugin:fde",
            "hook:fde:SessionStart", "script:fde:which-account.sh"})
        self.assertIn("hook:fde:SessionStart", exported["hookPayloads"])

    def test_migration_is_idempotent(self):
        self._legacy({"schemaVersion": 1, "disabled": ["skill:fde-core:engage"]})
        first = json.loads(self.fde("config", "export", "--json").stdout)["config"]
        second = json.loads(self.fde("config", "export", "--json").stdout)["config"]
        self.assertEqual(first, second)

    def test_the_v1_file_is_kept_in_step_so_the_runtime_never_widens(self):
        """fde-start still reads the v1 file. A migration must not empty it."""
        legacy_path = self.shared / "config" / "capability-policy.json"
        self._legacy({"schemaVersion": 1, "disabled": ["skill:fde-core:engage", "tool:WebFetch"]})
        self.fde("config", "show", "--json")
        self.assertTrue(legacy_path.exists(), "the v1 file is still the runtime's input")
        self.assertEqual(sorted(json.loads(legacy_path.read_text())["disabled"]),
                         ["skill:fde-core:engage", "tool:WebFetch"])

        # A decision made through the new commands reaches the old file too.
        self.fde("config", "set", "tool:fde:Bash", "disabled")
        self.assertIn("tool:Bash", json.loads(legacy_path.read_text())["disabled"])
        self.fde("config", "reset", "skill:fde:engage")
        self.assertNotIn("skill:fde-core:engage", json.loads(legacy_path.read_text())["disabled"])

    def test_a_decision_written_to_the_v1_file_by_the_console_is_picked_up(self):
        self.fde("config", "set", "tool:fde:Bash", "disabled")
        legacy_path = self.shared / "config" / "capability-policy.json"
        document = json.loads(legacy_path.read_text())
        document["disabled"].append("skill:fde-core:handover")
        legacy_path.write_text(json.dumps(document), encoding="utf-8")
        exported = json.loads(self.fde("config", "export", "--json").stdout)["config"]["global"]
        self.assertEqual(exported.get("skill:fde:handover"), "disabled")
        self.assertEqual(exported.get("tool:fde:Bash"), "disabled")

    def test_a_scope_narrower_than_global_is_not_flattened_into_the_v1_file(self):
        """The v1 file has one layer. Only the global one may be projected into it."""
        self.fde("config", "set", "skill:fde:handover", "disabled",
                 "--scope", "workflow:forward-deployed-engineer")
        legacy = json.loads((self.shared / "config" / "capability-policy.json").read_text())
        self.assertEqual(legacy["disabled"], [])

    def test_migrate_id_maps_every_legacy_shape(self):
        self.assertEqual(cap.migrate_id("skill:fde-core:crosscheck"), "skill:fde:crosscheck")
        self.assertEqual(cap.migrate_id("agent:fde-core:reviewer"), "agent:fde:reviewer")
        self.assertEqual(cap.migrate_id("tool:Read"), "tool:fde:Read")
        self.assertEqual(cap.migrate_id("mcp:serena"), "mcp:fde:serena")
        self.assertEqual(cap.migrate_id("plugin:fde-core"), "plugin:fde")
        self.assertEqual(cap.migrate_id("plugin:acme"), "plugin:user:acme")
        self.assertEqual(cap.migrate_id("skill:acme:thing"), "skill:user:acme:thing")
        self.assertIsNone(cap.migrate_id("nonsense"))


class ExportImportTest(CapabilityTestCase):
    """20. Export and import preserve explicit user overrides."""

    def test_a_round_trip_preserves_every_explicit_decision(self):
        self.install_plugin("acme", skills=("alpha",), agents=())
        decisions = [
            ("skill:fde:engage", "disabled", "global"),
            ("skill:user:acme:alpha", "disabled", "global"),
            ("mcp:fde:aws", "enabled", "workflow:forward-deployed-engineer"),
            ("tool:fde:Bash", "disabled", "stage:forward-deployed-engineer/operations"),
            ("agent:fde:reviewer", "enabled", "role:reviewer"),
            ("skill:fde:handover", "disabled", "workspace:maxeda"),
        ]
        for cid, state, scope in decisions:
            self.fde("config", "set", cid, state, "--scope", scope)
        exported = json.loads(self.fde("config", "export", "--json").stdout)
        target = self.home / "export.json"
        target.write_text(json.dumps(exported), encoding="utf-8")

        # A clean slate means both stores: the transitional shim keeps the v1
        # file in step, so leaving it behind would re-migrate the decisions we
        # are trying to remove.
        cap.config_file(self.shared).unlink()
        cap.legacy_policy_file(self.shared).unlink(missing_ok=True)
        self.assertEqual(json.loads(self.fde("config", "export", "--json").stdout)["config"],
                         {"global": {}})
        self.fde("config", "import", str(target))
        restored = json.loads(self.fde("config", "export", "--json").stdout)
        self.assertEqual(restored["config"], exported["config"])

    def test_import_replaces_by_default_and_merges_on_request(self):
        self.fde("config", "set", "skill:fde:engage", "disabled")
        exported = self.home / "export.json"
        exported.write_text(self.fde("config", "export", "--json").stdout, encoding="utf-8")
        self.fde("config", "reset", "skill:fde:engage")
        self.fde("config", "set", "skill:fde:handover", "disabled")

        self.fde("config", "import", str(exported))
        after = json.loads(self.fde("config", "export", "--json").stdout)["config"]["global"]
        self.assertEqual(after, {"skill:fde:engage": "disabled"})

        self.fde("config", "set", "skill:fde:handover", "disabled")
        self.fde("config", "import", str(exported), "--merge")
        merged = json.loads(self.fde("config", "export", "--json").stdout)["config"]["global"]
        self.assertEqual(merged, {"skill:fde:engage": "disabled", "skill:fde:handover": "disabled"})

    def test_an_import_of_the_wrong_shape_is_refused(self):
        target = self.home / "bad.json"
        target.write_text(json.dumps({"schemaVersion": 1, "config": {"global": {"nope": "disabled"}}}),
                          encoding="utf-8")
        self.fde("config", "import", str(target), expected=2)


class SnapshotTest(CapabilityTestCase):
    """Every run has a reproducible capability snapshot."""

    def _snapshot(self, run_id, role, sequence):
        target = self.shared / "runs" / run_id / "capabilities" / f"snapshot-{role}-{sequence}.json"
        return json.loads(target.read_text(encoding="utf-8"))

    def test_a_run_records_an_independent_snapshot_for_each_role(self):
        run_id = self.new_run()
        self.fde("capabilities", "snapshot", run_id, "--stage", "vertical-slice")
        primary = self._snapshot(run_id, "primary", 1)
        reviewer = self._snapshot(run_id, "reviewer", 1)
        self.assertNotEqual(primary["digest"], reviewer["digest"])
        primary_ids = {entry["id"] for entry in primary["capabilities"]}
        reviewer_ids = {entry["id"] for entry in reviewer["capabilities"]}
        self.assertIn("tool:fde:Edit", primary_ids)
        self.assertNotIn("tool:fde:Edit", reviewer_ids)
        for document in (primary, reviewer):
            self.assertEqual(document["workflow"], "forward-deployed-engineer")
            self.assertTrue(document["digest"].startswith("sha256:"))

    def test_a_snapshot_is_written_once_and_never_rewritten(self):
        run_id = self.new_run()
        self.fde("capabilities", "snapshot", run_id, "--stage", "vertical-slice")
        target = self.shared / "runs" / run_id / "capabilities" / "snapshot-primary-1.json"
        self.assertEqual(target.stat().st_mode & 0o777, 0o400)
        before = target.read_bytes()
        self.fde("capabilities", "snapshot", run_id, "--stage", "vertical-slice")
        self.assertEqual(target.read_bytes(), before)
        self.assertFalse((target.parent / "snapshot-primary-2.json").exists())

    def test_a_changed_resolution_supersedes_rather_than_edits(self):
        run_id = self.new_run()
        self.fde("capabilities", "snapshot", run_id, "--stage", "vertical-slice")
        self.fde("config", "set", "skill:fde:implementation", "disabled", "--scope", f"run:{run_id}")
        self.fde("capabilities", "snapshot", run_id, "--stage", "vertical-slice")
        first = self._snapshot(run_id, "primary", 1)
        second = self._snapshot(run_id, "primary", 2)
        self.assertIn("skill:fde:implementation", {e["id"] for e in first["capabilities"]})
        self.assertNotIn("skill:fde:implementation", {e["id"] for e in second["capabilities"]})
        index = [json.loads(line) for line in
                 (self.shared / "runs" / run_id / "capabilities" / "snapshots.jsonl")
                 .read_text(encoding="utf-8").splitlines() if line.strip()]
        primary = [entry for entry in index if entry["role"] == "primary"]
        self.assertEqual(primary[1]["supersedes"], primary[0]["digest"])

    def test_a_snapshot_records_what_it_takes_to_reproduce_the_run(self):
        run_id = self.new_run()
        self.fde("capabilities", "snapshot", run_id, "--stage", "quality-review")
        document = self._snapshot(run_id, "primary", 1)
        self.assertTrue(document["workflowRevision"])
        for entry in document["capabilities"]:
            self.assertIn("id", entry)
            self.assertIn("source", entry)
        self.assertTrue(any(entry["layer"] == "builtin" for entry in document["decisions"]))

    def test_a_run_id_that_is_a_path_is_refused(self):
        self.fde("capabilities", "snapshot", "../escape", expected=2)


class IdentityTest(unittest.TestCase):
    """The id grammar, which everything else keys on."""

    def test_ids_round_trip(self):
        for kind, namespace, name in (("skill", "fde", "crosscheck"),
                                      ("skill", "ponytail", "ponytail-review"),
                                      ("skill", "user:acme", "deploy-check"),
                                      ("tool", "fde", "Read")):
            cid = cap.make_id(kind, namespace, name)
            self.assertEqual(cap.parse_id(cid), (kind, namespace, name))

    def test_a_plugin_id_stops_at_its_namespace(self):
        self.assertEqual(cap.make_id("plugin", "user:acme"), "plugin:user:acme")
        self.assertEqual(cap.parse_id("plugin:user:acme"), ("plugin", "user:acme", None))

    def test_an_unusable_id_is_refused(self):
        for bad in ("", "skill", "nonsense:fde:x", "skill:fde", None, 7):
            self.assertFalse(cap.valid_id(bad), bad)

    def test_reserved_namespaces_are_not_reachable_by_an_imported_plugin(self):
        self.assertEqual(cap.plugin_namespace("fde-core"), "fde")
        self.assertEqual(cap.plugin_namespace("ponytail"), "ponytail")
        self.assertEqual(cap.plugin_namespace("anything-else"), "user:anything-else")


if __name__ == "__main__":
    unittest.main()
