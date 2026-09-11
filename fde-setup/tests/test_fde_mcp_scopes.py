"""Acceptance coverage for MCP permission scopes and connection states.

Two properties carry most of the weight here. A scope NARROWS — it can never
hand out a tool the safety allowlist withholds — and selecting a connector
CONTACTS NOTHING. Both are easy to believe and easy to break, so both are
asserted directly rather than inferred from a green status line.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
FDE = ROOT / "claude-shared" / "bin" / "fde"
SHARED_SRC = ROOT / "claude-shared"
TOOLKIT_SRC = ROOT / "fde-toolkit"

sys.path.insert(0, str(SHARED_SRC / "lib"))
import fde_capabilities as cap  # noqa: E402
import fde_mcp  # noqa: E402

# A discard port: connecting to it fails immediately, and any attempt would show
# up as an error rather than as silence.
DEAD_URL = "http://127.0.0.1:9/mcp"

PROBE_TOOLS = [
    ("probe_read_config", True, False),
    ("probe_list_items", True, False),
    ("probe_search_items", True, False),
    ("probe_create_item", False, False),
    ("probe_update_item", False, False),
    ("probe_delete_item", False, True),
    ("probe_deploy_release", False, False),
    ("probe_grant_admin", False, False),
    ("probe_frobnicate", False, False),
]


class ScopeTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.shared = self.home / ".claude-shared"
        shutil.copytree(SHARED_SRC, self.shared,
                        ignore=shutil.ignore_patterns("runs", "__pycache__", ".env.sh", "env.sh"))
        shutil.copytree(TOOLKIT_SRC, self.shared / "fde-toolkit",
                        ignore=shutil.ignore_patterns("__pycache__", ".versions"))
        (self.shared / "runs").mkdir(exist_ok=True)
        self.env = dict(os.environ)
        self.env.update({
            "HOME": str(self.home), "CLAUDE_SHARED": str(self.shared),
            "CLAUDE_PROFILES_DIR": str(self.home / ".claude-profiles"),
            "FDE_RUNS_DIR": str(self.shared / "runs"),
        })
        self.env.pop("FDE_PLUGINS_ROOT", None)
        self.catalogue = self.shared / "mcp" / "mcp-servers.json"
        self.health = self.shared / "mcp" / "health.json"
        self.user_config = self.shared / "config" / "mcp-user-config.json"
        self.add_probe_server()

    def tearDown(self):
        self.tmp.cleanup()

    # -- fixtures -----------------------------------------------------------

    def add_probe_server(self):
        """A server with no external dependency, so the tests are deterministic."""
        document = json.loads(self.catalogue.read_text(encoding="utf-8"))
        document["servers"]["probe"] = {
            "enabled": True, "transport": "http", "url": DEAD_URL,
            "targets": ["claude"], "stages": ["implementation"], "profiles": ["coding"],
            "auth": "none", "classification": "repository-local",
            "mutation": "mutation-capable", "readOnlyPolicy": "patterns",
            "allowTools": ["^probe_read_", "^probe_list_", "^probe_search_",
                           "^probe_create_", "^probe_update_", "^probe_delete_",
                           "^probe_frobnicate$"],
            "denyTools": ["^probe_deploy_", "^probe_grant_"],
            "scopes": {"read": ["^probe_read_", "^probe_list_"],
                       "search": ["^probe_search_"],
                       "create": ["^probe_create_"],
                       "update": ["^probe_update_"],
                       "delete": ["^probe_delete_"]},
            "mutationApproval": {"gate": "implementation-write",
                                 "note": "Test fixture; its writes never leave this machine."},
            "useWhen": "A deterministic server used by the test suite.",
        }
        self.catalogue.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")

    def connect(self, *names, verified=True, outcome="ok"):
        self.user_config.write_text(json.dumps(
            {"schemaVersion": 2,
             "servers": {name: {"enabled": True} for name in names}}), encoding="utf-8")
        if verified:
            self.health.write_text(json.dumps({"schemaVersion": 2, "servers": {
                name: {"outcome": outcome,
                       "tools": [{"name": tool, "readOnlyHint": ro, "destructiveHint": de}
                                 for tool, ro, de in PROBE_TOOLS]}
                for name in names}}), encoding="utf-8")

    def template(self, scopes, *, name="probe-flow"):
        (cap.workflows_root(self.shared) / f"{name}.json").write_text(json.dumps({
            "schemaVersion": 1, "name": name, "revision": "test.1",
            "stages": [{"name": "only", "controllerStages": ["implementation"],
                        "common": {"enable": ["mcp:fde:probe"]},
                        "mcpScopes": {"mcp:fde:probe": scopes}}]}), encoding="utf-8")
        return name

    def fde(self, *args, expected=0):
        result = subprocess.run([str(FDE), *args], text=True, capture_output=True, env=self.env)
        self.assertEqual(result.returncode, expected,
                         msg=f"args={args}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        return result

    def connector(self, workflow="probe-flow", stage="only", server="probe", *args):
        document = json.loads(self.fde("config", "show", "--json", "--all",
                                       "--workflow", workflow, "--stage", stage, *args).stdout)
        entry = next(item for item in document["capabilities"] if item["name"] == server)
        return document, entry


class NothingIsContactedTest(ScopeTestCase):
    """8. Unconnected MCPs are never contacted."""

    def test_resolution_does_not_reach_the_network(self):
        self.template(["read"])
        started = time.monotonic()
        self.fde("config", "show", "--workflow", "probe-flow", "--stage", "only")
        # The probe server's URL is a discard port. A resolution that dialled it
        # would either hang or fail; it does neither, because it never tries.
        self.assertLess(time.monotonic() - started, 15)

    def test_resolution_writes_nothing_to_the_mcp_state(self):
        self.connect("probe")
        before = {path: path.read_bytes() for path in
                  (self.catalogue, self.health, self.user_config)}
        self.template(["read", "update"])
        self.fde("config", "show", "--workflow", "probe-flow", "--stage", "only")
        self.fde("capabilities", "--json")
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content, f"{path.name} was modified")

    def test_an_unconnected_server_contributes_no_tools(self):
        self.template(["read", "update"])
        _document, entry = self.connector()
        self.assertEqual(entry["mcp"]["connectionState"], "selected-but-unavailable")
        self.assertFalse(entry["active"])
        self.assertIn(entry["mcp"]["state"], ("unverified", "nothing-enforceable"))
        self.assertFalse(entry["mcp"]["tools"])

    def test_selection_does_not_switch_a_server_on(self):
        """A default-enabled MCP means 'use it when it is there', nothing more."""
        self.template(["read"])
        self.fde("config", "show", "--workflow", "probe-flow", "--stage", "only")
        self.assertFalse(self.user_config.exists(),
                         "resolving a workflow must not write the operator's MCP configuration")

    def test_no_credential_is_requested_or_read(self):
        secrets = self.shared / "secrets" / "mcp"
        secrets.mkdir(parents=True, exist_ok=True)
        self.template(["read"])
        self.fde("config", "show", "--workflow", "probe-flow", "--stage", "only")
        self.assertEqual(list(secrets.iterdir()), [])


class ConnectionStateTest(ScopeTestCase):
    """The six states, told apart."""

    def test_a_connected_healthy_server_is_selected_and_connected(self):
        self.connect("probe")
        self.template(["read"])
        _document, entry = self.connector()
        self.assertEqual(entry["mcp"]["connectionState"], "selected-and-connected")
        self.assertTrue(entry["active"])

    def test_a_server_the_operator_has_not_switched_on_is_selected_but_unavailable(self):
        self.template(["read"])
        _document, entry = self.connector()
        self.assertEqual(entry["mcp"]["connectionState"], "selected-but-unavailable")

    def test_a_switched_off_capability_is_installed_but_disabled(self):
        self.connect("probe")
        self.template(["read"])
        self.fde("config", "set", "mcp:fde:probe", "disabled")
        _document, entry = self.connector()
        self.assertEqual(entry["mcp"]["connectionState"], "installed-but-disabled")

    def test_a_refused_credential_is_authentication_required(self):
        self.connect("probe", outcome="authentication_required")
        self.template(["read"])
        _document, entry = self.connector()
        self.assertEqual(entry["mcp"]["connectionState"], "authentication-required")
        self.assertEqual(entry["health"]["state"], "degraded")

    def test_a_server_that_would_not_start_is_a_connection_error(self):
        self.connect("probe", outcome="failed")
        self.template(["read"])
        _document, entry = self.connector()
        self.assertEqual(entry["mcp"]["connectionState"], "connection-error")

    def test_a_security_forbidden_connector_is_blocked_by_policy(self):
        self.connect("probe")
        self.template(["read"])
        (self.shared / "config" / "security-policy.json").write_text(json.dumps(
            {"schemaVersion": 1, "required": ["plugin:fde"], "forbidden": ["mcp:fde:probe"]}),
            encoding="utf-8")
        _document, entry = self.connector()
        self.assertEqual(entry["mcp"]["connectionState"], "blocked-by-policy")
        self.assertFalse(entry["active"])

    def test_a_catalogue_disabled_server_is_blocked_by_policy(self):
        document = json.loads(self.catalogue.read_text(encoding="utf-8"))
        document["servers"]["probe"]["enabled"] = False
        self.catalogue.write_text(json.dumps(document, indent=2), encoding="utf-8")
        self.connect("probe")
        self.template(["read"])
        _document, entry = self.connector()
        self.assertEqual(entry["mcp"]["connectionState"], "blocked-by-policy")

    def test_every_state_this_build_reports_is_one_of_the_six(self):
        self.connect("probe")
        document = json.loads(self.fde("config", "show", "--json", "--all").stdout)
        seen = {entry["mcp"]["connectionState"] for entry in document["capabilities"]
                if entry["kind"] == "mcp"}
        self.assertTrue(seen <= set(cap.CONNECTION_STATES), seen)


class ScopeEnforcementTest(ScopeTestCase):
    """9. MCP permission scopes are enforced."""

    def setUp(self):
        super().setUp()
        self.connect("probe")

    def test_read_alone_yields_only_the_read_tools(self):
        self.template(["read"])
        _document, entry = self.connector()
        connector = entry["mcp"]
        self.assertEqual(connector["state"], "enforced")
        self.assertEqual(connector["tools"], ["probe_list_items", "probe_read_config"])
        self.assertIn("probe_update_item", connector["withheld"])
        self.assertIn("probe_delete_item", connector["withheld"])

    def test_adding_a_scope_adds_exactly_its_tools(self):
        self.template(["read", "search"])
        _document, entry = self.connector()
        self.assertEqual(entry["mcp"]["tools"],
                         ["probe_list_items", "probe_read_config", "probe_search_items"])

    def test_a_scope_can_never_widen_past_the_safety_allowlist(self):
        self.template(list(fde_mcp.SCOPES))
        _document, entry = self.connector()
        tools = set(entry["mcp"]["tools"])
        # Everything allowTools permits, and nothing denyTools withholds — even
        # though every scope in the vocabulary was granted.
        self.assertNotIn("probe_deploy_release", tools)
        self.assertNotIn("probe_grant_admin", tools)
        self.assertEqual(entry["mcp"]["withheld"], [])
        self.assertEqual(tools, set(entry["mcp"]["enforceableTools"]))

    def test_a_tool_nobody_classified_needs_the_broadest_scope(self):
        """An unrecognised tool must not ride in on a read-only grant."""
        self.template(["read", "search", "create", "update", "delete"])
        _document, entry = self.connector()
        self.assertNotIn("probe_frobnicate", entry["mcp"]["tools"])
        self.assertIn("probe_frobnicate", entry["mcp"]["withheld"])
        self.assertEqual(entry["mcp"]["byScope"]["administer"], ["probe_frobnicate"])

        self.template(["read", "administer"], name="probe-flow")
        _document, entry = self.connector()
        self.assertIn("probe_frobnicate", entry["mcp"]["tools"])

    def test_a_granted_scope_with_no_tools_behind_it_says_so(self):
        self.template(["read", "deploy"])
        _document, entry = self.connector()
        self.assertIn("deploy", entry["mcp"]["unenforceable"])
        self.assertNotIn("read", entry["mcp"]["unenforceable"])

    def test_a_connector_selected_with_no_scope_is_reported_degraded(self):
        self.template([])
        document, entry = self.connector()
        self.assertEqual(entry["mcp"]["tools"], [])
        self.assertIn("mcp:fde:probe", {item["id"] for item in document["degraded"]})

    def test_scopes_resolve_through_the_layers_like_everything_else(self):
        self.template(["read", "update"])
        self.fde("config", "set-option", "mcp.probe.scopes", "read", "--scope", "global")
        _document, entry = self.connector()
        self.assertEqual(entry["mcp"]["granted"], ["read"])

        self.fde("config", "set-option", "mcp.probe.scopes", "read,search",
                 "--scope", "stage:probe-flow/only")
        _document, entry = self.connector()
        self.assertEqual(entry["mcp"]["granted"], ["read", "search"])

        self.fde("config", "set-option", "mcp.probe.scopes", "inherit",
                 "--scope", "stage:probe-flow/only")
        _document, entry = self.connector()
        self.assertEqual(entry["mcp"]["granted"], ["read"])

    def test_the_reviewer_can_hold_a_narrower_scope_than_the_primary(self):
        self.template(["read", "update"])
        self.fde("config", "set-option", "mcp.probe.scopes", "read", "--scope", "role:reviewer")
        _document, primary = self.connector("probe-flow", "only", "probe", "--role", "primary")
        _document, reviewer = self.connector("probe-flow", "only", "probe", "--role", "reviewer")
        self.assertEqual(primary["mcp"]["granted"], ["read", "update"])
        self.assertEqual(reviewer["mcp"]["granted"], ["read"])
        self.assertLess(len(reviewer["mcp"]["tools"]), len(primary["mcp"]["tools"]))

    def test_an_unproven_server_offers_nothing_rather_than_guessing(self):
        """Patterns without a verified tool list are not an allowlist."""
        self.health.unlink()
        self.template(["read"])
        _document, entry = self.connector()
        self.assertEqual(entry["mcp"]["state"], "nothing-enforceable")
        self.assertEqual(entry["mcp"]["tools"], [])
        # The answer is complete — an empty set — so the runtime can act on it.
        self.assertTrue(entry["mcp"]["scopeEnforced"])

    def test_a_server_whose_whole_tool_set_is_safe_is_not_claimed_to_be_scoped(self):
        """context7 is read-only by server flag, so nothing filters it.

        Reporting a scope as applied here would be a claim about tools this
        machine has never listed."""
        self.user_config.write_text(json.dumps(
            {"schemaVersion": 2, "servers": {"context7": {"enabled": True}}}), encoding="utf-8")
        (cap.workflows_root(self.shared) / "c7.json").write_text(json.dumps({
            "schemaVersion": 1, "name": "c7", "revision": "test.1",
            "stages": [{"name": "only", "controllerStages": ["research"],
                        "common": {"enable": ["mcp:fde:context7"]},
                        "mcpScopes": {"mcp:fde:context7": ["read"]}}]}), encoding="utf-8")
        _document, entry = self.connector("c7", "only", "context7")
        self.assertEqual(entry["mcp"]["state"], "unverified")
        self.assertIsNone(entry["mcp"]["tools"])
        self.assertFalse(entry["mcp"]["scopeEnforced"])
        self.assertIn("fde mcp verify", entry["mcp"]["reason"])

    def test_the_granted_scopes_and_tools_reach_the_run_snapshot(self):
        self.template(["read", "search"])
        run_id = next(line.split()[1] for line in
                      self.fde("start", "a scope test run").stdout.splitlines()
                      if line.startswith("run "))
        self.fde("capabilities", "snapshot", run_id, "--workflow", "probe-flow", "--stage", "only")
        snapshot = json.loads((self.shared / "runs" / run_id / "capabilities" /
                               "snapshot-primary-1.json").read_text(encoding="utf-8"))
        probe = next(entry for entry in snapshot["connectors"] if entry["ref"] == "fde:probe")
        self.assertEqual(probe["granted"], ["read", "search"])
        self.assertIn("probe_search_items", probe["tools"])
        self.assertNotIn("probe_update_item", probe["tools"])
        self.assertEqual(probe["connectionState"], "selected-and-connected")


class ClassificationTest(unittest.TestCase):
    """How a tool is placed, and what happens when nothing places it."""

    def server(self, **overrides):
        base = {"scopes": {}, "allowTools": (), "denyTools": (), "mutation": "mutation-capable"}
        base.update(overrides)
        return base

    def test_a_catalogue_declaration_wins(self):
        server = self.server(scopes={"read": ["^delete_nothing$"]})
        self.assertEqual(fde_mcp.scope_of_tool("delete_nothing", server), "read")

    def test_the_broader_declaration_wins_when_two_match(self):
        server = self.server(scopes={"read": ["^thing$"], "administer": ["^thing$"]})
        self.assertEqual(fde_mcp.scope_of_tool("thing", server), "administer")

    def test_annotations_are_used_when_the_catalogue_is_silent(self):
        server = self.server()
        self.assertEqual(fde_mcp.scope_of_tool("zzz_thing", server, {"readOnlyHint": True}), "read")
        self.assertEqual(fde_mcp.scope_of_tool("zzz_search_thing", server,
                                               {"readOnlyHint": True}), "search")
        self.assertEqual(fde_mcp.scope_of_tool("zzz_thing", server,
                                               {"destructiveHint": True}), "delete")

    def test_names_are_used_when_annotations_are_silent(self):
        server = self.server()
        for tool, expected in (("get_thing", "read"), ("list_things", "read"),
                               ("search_things", "search"), ("create_thing", "create"),
                               ("update_thing", "update"), ("delete_thing", "delete"),
                               ("deploy_stack", "deploy"), ("execute_shell_command", "administer")):
            self.assertEqual(fde_mcp.scope_of_tool(tool, server), expected, tool)

    def test_anything_unclassified_falls_to_administer(self):
        self.assertEqual(fde_mcp.scope_of_tool("zzz_frobnicate", self.server()), "administer")

    def test_the_shipped_catalogue_classifies_its_own_allowlists(self):
        """Every tool FDE ships an allowlist for lands somewhere deliberate."""
        catalog = fde_mcp.Catalog.load(SHARED_SRC / "mcp" / "mcp-servers.json")
        for name in ("serena", "playwright", "chrome-devtools"):
            server = catalog.get(name)
            for pattern in server["allowTools"]:
                tool = pattern.strip("^$")
                scope = fde_mcp.scope_of_tool(tool, server)
                self.assertIn(scope, fde_mcp.SCOPES)
                self.assertNotEqual(scope, "administer",
                                    f"{name}:{tool} fell through to administer")


class TemplateScopeTest(ScopeTestCase):
    """Defaults are the minimum the stage needs."""

    def test_operations_grants_nothing_wider_than_search(self):
        document = json.loads(self.fde("config", "show", "--json", "--all",
                                       "--workflow", "forward-deployed-engineer",
                                       "--stage", "operations").stdout)
        connectors = [entry for entry in document["capabilities"]
                      if entry["kind"] == "mcp" and entry["state"] == "enabled"]
        self.assertTrue(connectors)
        for entry in connectors:
            self.assertTrue(set(entry["mcp"]["granted"]) <= set(fde_mcp.READ_ONLY_SCOPES),
                            f"{entry['ref']} holds {entry['mcp']['granted']}")

    def test_analysis_stages_grant_no_write_scope_anywhere(self):
        for stage in ("business-intent", "solution-requirements", "technical-architecture"):
            document = json.loads(self.fde("config", "show", "--json", "--all",
                                           "--workflow", "forward-deployed-engineer",
                                           "--stage", stage).stdout)
            for entry in document["capabilities"]:
                if entry["kind"] != "mcp" or entry["state"] != "enabled":
                    continue
                self.assertTrue(set(entry["mcp"]["granted"]) <= set(fde_mcp.READ_ONLY_SCOPES),
                                f"{stage}/{entry['ref']} holds {entry['mcp']['granted']}")

    def test_the_browser_connectors_need_update_only_where_something_is_driven(self):
        def granted(stage, server):
            document = json.loads(self.fde("config", "show", "--json", "--all",
                                           "--workflow", "forward-deployed-engineer",
                                           "--stage", stage).stdout)
            entry = next(item for item in document["capabilities"] if item["name"] == server)
            return set(entry["mcp"]["granted"])
        self.assertIn("update", granted("vertical-slice", "playwright"))
        self.assertIn("update", granted("quality-review", "playwright"))
        self.assertNotIn("update", granted("operations", "playwright"))
        self.assertNotIn("update", granted("operations", "chrome-devtools"))


if __name__ == "__main__":
    unittest.main()
