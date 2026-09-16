"""The governed MCP catalogue: schema, lifecycle, activation and rendering.

Nothing here touches the network, starts an MCP server, or downloads a package.
Where a tool list would normally come from a real `tools/list`, the test writes
the health record directly — which is also the honest model, because FDE never
treats an unverified server as governable.
"""
import importlib.machinery
import importlib.util
import json
import os
import pathlib
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "claude-shared" / "lib"
CATALOG = ROOT / "claude-shared" / "mcp" / "mcp-servers.json"
MCP_SYNC = ROOT / "claude-shared" / "bin" / "mcp-sync"
FDE = ROOT / "claude-shared" / "bin" / "fde"

sys.path.insert(0, str(LIB))
import fde_mcp as mcp  # noqa: E402


def load_fde():
    """The controller as a module, so its vocabulary can be compared directly."""
    loader = importlib.machinery.SourceFileLoader("fde_controller_under_test", str(FDE))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


V1_CATALOGUE = {
    "_comment": "the shipped three-server catalogue, before governance metadata",
    "servers": {
        "context7": {
            "transport": "http", "url": "https://mcp.context7.com/mcp",
            "targets": ["claude", "gemini", "codex"],
            "note": "up-to-date library and framework docs.",
        },
        "atlassian": {
            "transport": "http", "url": "https://mcp.atlassian.com/v2/mcp",
            "targets": ["role:orchestrator"], "note": "Jira and Confluence through Rovo.",
        },
        "figma": {
            "transport": "http", "url": "https://mcp.figma.com/mcp",
            "targets": ["role:uiUxDesign", "role:orchestrator"], "note": "Figma MCP.",
        },
    },
}


def catalogue(servers, profiles=None):
    return {"schemaVersion": 2, "profiles": profiles or {}, "servers": servers}


def http_server(**overrides):
    base = {"transport": "http", "url": "https://mcp.example.com/mcp",
            "targets": ["claude"], "mutation": "read-only",
            "readOnlyPolicy": "server-flag"}
    base.update(overrides)
    return base


class Migration(unittest.TestCase):
    """1. The existing three-server catalogue must survive, unchanged in effect."""

    def test_v1_migrates_and_still_renders_the_same_client_configuration(self):
        catalog = mcp.Catalog(V1_CATALOGUE)
        self.assertEqual(catalog.doc["schemaVersion"], mcp.SCHEMA_VERSION)
        self.assertEqual(sorted(catalog.names()), ["atlassian", "context7", "figma"])
        self.assertEqual(sorted(catalog.global_servers()), ["context7"])
        self.assertEqual(sorted(catalog.role_servers()), ["atlassian", "figma"])
        rendered = mcp.render_claude({"context7": catalog.get("context7")})
        self.assertEqual(rendered, {"context7": {"type": "http",
                                                 "url": "https://mcp.context7.com/mcp"}})

    def test_v1_entries_are_not_silently_assumed_safe(self):
        catalog = mcp.Catalog(V1_CATALOGUE)
        self.assertEqual(catalog.get("context7")["mutation"], "read-only")
        # Atlassian and Figma can write; migration says so rather than inheriting
        # the old file's silence as permission.
        for name in ("atlassian", "figma"):
            self.assertEqual(catalog.get(name)["mutation"], "mutation-capable")
            # Their OAuth token belongs to the MCP client, so FDE cannot ask them
            # for a tool list — and says so rather than inventing a safe subset.
            self.assertEqual(catalog.get(name)["readOnlyPolicy"], "client-credential")

    def test_a_hand_added_v1_server_migrates_to_blocked_rather_than_trusted(self):
        raw = json.loads(json.dumps(V1_CATALOGUE))
        raw["servers"]["mine"] = {"transport": "http", "url": "https://mine.example.com/mcp",
                                  "targets": ["claude"], "note": "added by hand under v1"}
        catalog = mcp.Catalog(raw)
        server = catalog.get("mine")
        self.assertEqual(server["mutationApproval"]["gate"], "denied")
        state, reason = mcp.server_state("mine", server, {"values": {}, "tools": {}}, {})
        self.assertEqual(state, mcp.BLOCKED)
        self.assertIn("mutation tools cannot be governed", reason)

    def test_an_unknown_schema_version_is_refused_rather_than_guessed(self):
        with self.assertRaises(mcp.CatalogError) as caught:
            mcp.Catalog({"schemaVersion": 99, "servers": {}})
        self.assertEqual(caught.exception.code, "catalog_version")

    def test_the_shipped_catalogue_is_valid_and_current(self):
        catalog = mcp.Catalog.load(CATALOG)
        self.assertEqual(catalog.problems, [])
        self.assertEqual(catalog.doc["schemaVersion"], mcp.SCHEMA_VERSION)

    @unittest.skipUnless(FDE.is_file(), "the controller is not present in this tree")
    def test_the_library_and_the_controller_share_one_vocabulary(self):
        fde = load_fde()
        self.assertEqual(list(mcp.KNOWN_ROLES), list(fde.ALL_ROLES))
        self.assertEqual(list(mcp.KNOWN_STAGES), list(fde.STAGE_ORDER))
        self.assertEqual(set(mcp.PUBLICATION_TARGETS), set(fde.PUBLICATION_TARGETS))


class Validation(unittest.TestCase):
    """2. Invalid targets, unsafe commands, secret literals and bad profiles."""

    def problems(self, servers, profiles=None):
        return mcp.validate(mcp.migrate(catalogue(servers, profiles)))

    def test_an_unknown_target_is_rejected(self):
        problems = self.problems({"x": http_server(targets=["claude", "copilot"])})
        self.assertTrue(any("unknown target 'copilot'" in p for p in problems), problems)

    def test_an_unknown_role_target_is_rejected(self):
        problems = self.problems({"x": http_server(targets=["role:archmage"])})
        self.assertTrue(any("unknown role" in p for p in problems), problems)

    def test_a_server_may_not_be_both_global_and_role_scoped(self):
        problems = self.problems({"x": http_server(targets=["claude", "role:orchestrator"])})
        self.assertTrue(any("either global or role-scoped" in p for p in problems), problems)

    def test_a_shell_command_string_is_refused(self):
        problems = self.problems({"x": {
            "transport": "stdio", "command": "sh -c 'npx thing | tee /tmp/x'",
            "args": [], "targets": ["claude"], "mutation": "read-only",
            "readOnlyPolicy": "server-flag"}})
        self.assertTrue(any("no shell metacharacters" in p for p in problems), problems)

    def test_args_must_be_a_list_not_a_string(self):
        problems = self.problems({"x": {
            "transport": "stdio", "command": "npx", "args": "-y thing",
            "targets": ["claude"], "mutation": "read-only",
            "readOnlyPolicy": "server-flag"}})
        self.assertTrue(any("args must be a list" in p for p in problems), problems)

    def test_an_unsafe_environment_variable_name_is_refused(self):
        problems = self.problems({"x": http_server(env={"not a name": "value"})})
        self.assertTrue(any("safe environment variable name" in p for p in problems), problems)

    def test_a_literal_credential_anywhere_is_refused(self):
        for server in (
            http_server(env={"TOKEN": "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}),
            {"transport": "stdio", "command": "npx", "targets": ["claude"],
             "args": ["--dsn", "postgres://user:hunter2@db/app"],
             "mutation": "read-only", "readOnlyPolicy": "server-flag"},
        ):
            problems = self.problems({"x": server})
            self.assertTrue(any("literal credential" in p for p in problems), problems)

    def test_an_insecure_or_credentialed_url_is_refused(self):
        for url in ("http://mcp.example.com/mcp", "https://u:p@mcp.example.com/mcp",
                    "https://mcp.example.com/mcp#frag"):
            problems = self.problems({"x": http_server(url=url)})
            self.assertTrue(problems, url)

    def test_a_loopback_http_url_is_allowed(self):
        self.assertEqual(self.problems({"x": http_server(url="http://localhost:3000/mcp")}), [])

    def test_a_profile_that_is_not_declared_is_refused(self):
        problems = self.problems({"x": http_server(profiles=["ghost"])})
        self.assertTrue(any("not declared in the catalogue's profiles" in p
                            for p in problems), problems)

    def test_a_package_may_not_be_pinned_to_latest(self):
        problems = self.problems({"x": http_server(
            package={"manager": "npm", "name": "thing", "version": "latest"})})
        self.assertTrue(any("never 'latest'" in p for p in problems), problems)

    def test_a_header_must_name_a_declared_secret_variable(self):
        problems = self.problems({"x": http_server(
            httpHeaders={"Authorization": {"envVar": "FDE_MCP_NOT_DECLARED"}})})
        self.assertTrue(any("which no secret userConfig field provides" in p
                            for p in problems), problems)

    def test_a_secret_field_must_reference_an_environment_variable(self):
        problems = self.problems({"x": http_server(
            userConfig=[{"name": "token", "label": "Token", "required": True,
                         "secret": True}])})
        self.assertTrue(any("must declare a safe envVar" in p for p in problems), problems)

    def test_a_generated_file_may_not_escape_its_directory(self):
        problems = self.problems({"x": http_server(
            generatedFiles=[{"path": "../../etc/thing.toml", "template": "x"}])})
        self.assertTrue(any("may not escape" in p for p in problems), problems)


class ClientRendering(unittest.TestCase):
    """3 and 4. One definition, three clients, and Serena's two contexts."""

    def setUp(self):
        self.catalog = mcp.Catalog.load(CATALOG)
        self.health = {"serena": {"initialize": 200, "authenticated": True, "outcome": "ok",
                                  "tools": [{"name": "find_symbol", "readOnlyHint": True},
                                            {"name": "list_dir", "readOnlyHint": True},
                                            {"name": "replace_symbol_body"},
                                            {"name": "execute_shell_command"}]}}

    def selection(self, *names):
        return {name: self.catalog.get(name) for name in names}

    def test_claude_codex_and_gemini_each_get_their_own_dialect(self):
        selection = self.selection("context7")
        self.assertEqual(mcp.render_claude(selection)["context7"],
                         {"type": "http", "url": "https://mcp.context7.com/mcp"})
        self.assertEqual(mcp.render_gemini(selection)["context7"],
                         {"httpUrl": "https://mcp.context7.com/mcp"})
        block = mcp.render_codex_block(selection)
        self.assertIn("[mcp_servers.context7]", block)
        self.assertIn('url = "https://mcp.context7.com/mcp"', block)

    def test_serena_runs_a_different_context_for_claude_and_for_codex(self):
        selection = self.selection("serena")
        claude = mcp.render_claude(selection, health=self.health)["serena"]
        codex = mcp.render_codex_block(selection, health=self.health)
        self.assertIn("--context", claude["args"])
        self.assertEqual(claude["args"][claude["args"].index("--context") + 1], "claude-code")
        self.assertIn('"--context", "codex"', codex)
        self.assertNotIn('"--context", "claude-code"', codex)

    def test_a_startup_timeout_reaches_each_client_the_way_that_client_takes_it(self):
        selection = self.selection("serena")
        self.assertIn("startup_timeout_sec = 120",
                      mcp.render_codex_block(selection, health=self.health))
        self.assertEqual(mcp.claude_launch_env(selection), {"MCP_TIMEOUT": "120000"})
        self.assertEqual(mcp.render_gemini(selection, health=self.health)["serena"]["timeout"],
                         120000)

    def test_the_tool_allowlist_is_rendered_in_each_clients_own_mechanism(self):
        selection = self.selection("serena")
        self.assertIn('enabled_tools = ["find_symbol", "list_dir"]',
                      mcp.render_codex_block(selection, health=self.health))
        self.assertEqual(mcp.render_gemini(selection, health=self.health)["serena"]["includeTools"],
                         ["find_symbol", "list_dir"])
        permissions = mcp.render_claude_permissions(selection, health=self.health)["permissions"]
        self.assertEqual(permissions["allow"],
                         ["mcp__serena__find_symbol", "mcp__serena__list_dir"])
        self.assertEqual(permissions["deny"], ["mcp__serena"])

    def test_a_read_only_server_needs_no_filtering_and_is_allowed_whole(self):
        permissions = mcp.render_claude_permissions(self.selection("context7"))["permissions"]
        self.assertEqual(permissions, {"allow": ["mcp__context7"], "deny": []})


class Activation(unittest.TestCase):
    """5 and 6. Role, stage and profile decide; readiness has a veto."""

    def setUp(self):
        self.catalog = mcp.Catalog.load(CATALOG)
        self.tmp = tempfile.TemporaryDirectory()
        self.secrets = Path(self.tmp.name) / "secrets"
        self.user = {"schemaVersion": 2, "servers": {}}
        self.health = {}

    def tearDown(self):
        self.tmp.cleanup()

    def effective(self, **kwargs):
        kwargs.setdefault("user_doc", self.user)
        kwargs.setdefault("health", self.health)
        kwargs.setdefault("secrets_dir", self.secrets)
        return mcp.effective_servers(self.catalog, **kwargs)

    def make_ready(self, name, tools):
        self.health[name] = {"initialize": 200, "authenticated": True, "outcome": "ok",
                             "tools": tools}

    def test_a_catalogue_entry_is_not_automatically_active(self):
        # Every role that could hold a connector, every stage that could use one,
        # and still only what is actually ready comes through.
        chosen, rejected = self.effective(roles=set(mcp.KNOWN_ROLES),
                                          stages=list(mcp.KNOWN_STAGES))
        self.assertEqual(sorted(chosen), ["atlassian", "context7", "figma"])
        for name in ("dbhub", "langfuse", "aws", "azure", "playwright", "chrome-devtools"):
            self.assertIn(name, rejected, f"{name} should not be active out of the box")

    def test_a_connector_whose_tools_cannot_be_scoped_is_bound_but_flagged(self):
        """Atlassian and Figma sign in inside the MCP client, so FDE holds no token
        and can build no allowlist. Withholding them would break the only way to
        sign in; pretending they are read-only would be a lie. They are bound, and
        every surface says the writes are gated only at publication."""
        chosen, _rejected = self.effective(roles={"orchestrator"}, stages=["intake"])
        self.assertIn("atlassian", chosen)
        record = mcp.status_record("atlassian", self.catalog.get("atlassian"),
                                   mcp.server_settings(self.user, "atlassian"), self.health)
        self.assertEqual(record["state"], mcp.READY)
        self.assertTrue(record["unscopedWrites"])
        self.assertIsNone(record["enforceableTools"])
        self.assertIn("cannot be scoped", record["reason"])
        self.assertIn("approve-publish", record["reason"])

    def test_an_operator_can_pin_that_allowlist_and_it_becomes_enforced(self):
        user = {"schemaVersion": 2, "servers": {"atlassian": {
            "enabled": True, "values": {"allowTools": "getJiraIssue, searchConfluence"}}}}
        server = self.catalog.get("atlassian")
        settings = mcp.server_settings(user, "atlassian")
        self.assertEqual(mcp.enforceable_tools("atlassian", server, settings, {}),
                         ["getJiraIssue", "searchConfluence"])
        permissions = mcp.render_claude_permissions({"atlassian": server},
                                                    settings_by_name={"atlassian": settings})
        self.assertEqual(permissions["permissions"]["allow"],
                         ["mcp__atlassian__getJiraIssue", "mcp__atlassian__searchConfluence"])
        self.assertEqual(permissions["permissions"]["deny"], ["mcp__atlassian"])
        record = mcp.status_record("atlassian", server, settings, {})
        self.assertFalse(record["unscopedWrites"])

    def test_a_role_that_does_not_hold_the_connector_never_sees_it(self):
        _chosen, rejected = self.effective(roles={"implementation"}, stages=["implementation"])
        self.assertEqual(rejected["atlassian"][0], mcp.BLOCKED)
        self.assertIn("no role in this run holds", rejected["atlassian"][1])

    def test_a_stage_the_plan_omits_keeps_the_connector_out(self):
        chosen, rejected = self.effective(roles={"orchestrator"}, stages=["intake"])
        self.assertIn("atlassian", chosen)
        chosen, rejected = self.effective(roles={"orchestrator"}, stages=["verification"])
        self.assertNotIn("atlassian", chosen)
        self.assertIn("no approved stage", rejected["atlassian"][1])

    def test_reviewers_receive_review_stage_evidence_connectors(self):
        chosen, _rejected = self.effective(roles={"review"}, stages=["review"],
                                           profile="client-delivery")
        self.assertIn("atlassian", chosen)
        self.assertIn("figma", chosen)

    def test_orchestrator_gets_the_isolated_browser_in_every_profile_and_stage(self):
        server = self.catalog.get("playwright")
        self.assertIn("role:orchestrator", server["targets"])
        self.assertEqual(server["profiles"], [])
        self.assertTrue(set(mcp.KNOWN_STAGES) <= set(server["stages"]))
        self.make_ready("playwright", [
            {"name": "browser_navigate"},
            {"name": "browser_snapshot", "readOnlyHint": True},
        ])
        chosen, _rejected = self.effective(
            roles={"orchestrator"}, stages=["research"], profile="data")
        self.assertIn("playwright", chosen)

    def test_browser_navigation_is_search_scope_not_page_mutation(self):
        server = self.catalog.get("playwright")
        self.assertEqual(mcp.scope_of_tool("browser_navigate", server), "search")
        self.assertEqual(mcp.scope_of_tool("browser_navigate_back", server), "search")
        self.assertEqual(mcp.scope_of_tool("browser_click", server), "update")

    def test_every_orchestrator_evidence_connector_declares_review_scope(self):
        for name in ("atlassian", "figma", "dbhub", "aws", "azure"):
            server = self.catalog.get(name)
            self.assertIn("role:review", server["targets"], name)
            self.assertIn("review", server["stages"], name)

    def test_a_profile_narrows_the_effective_set(self):
        chosen, rejected = self.effective(roles={"orchestrator"}, stages=["intake"],
                                          profile="data")
        self.assertNotIn("atlassian", chosen)
        self.assertIn("outside the 'data' profile", rejected["atlassian"][1])

    def test_an_unconfigured_server_never_reaches_a_generated_configuration(self):
        chosen, rejected = self.effective(roles={"research", "solutioning"},
                                          stages=["research"], profile="data")
        self.assertNotIn("dbhub", chosen)
        self.assertEqual(rejected["dbhub"][0], mcp.NOT_CONFIGURED)
        self.assertIn("Read-only PostgreSQL DSN", rejected["dbhub"][1])

    def test_an_unavailable_dependency_is_named_with_its_exact_setup_action(self):
        state, reason = mcp.server_state("serena", self.catalog.get("serena"),
                                         mcp.server_settings(self.user, "serena"),
                                         self.health, secrets_dir=self.secrets)
        if state == mcp.UNAVAILABLE:
            self.assertIn("uv tool install -p 3.13 serena-agent", reason)
        else:  # serena happens to be installed on this machine
            self.assertIn(state, (mcp.NOT_CONFIGURED, mcp.READY, mcp.BLOCKED))


class MutationProtection(unittest.TestCase):
    """13 and 14. Mutation tools are absent until an approval says otherwise."""

    def setUp(self):
        self.catalog = mcp.Catalog.load(CATALOG)

    def test_a_provider_with_no_enforceable_read_only_subset_is_blocked(self):
        server = mcp.with_defaults(http_server(mutation="mutation-capable",
                                               readOnlyPolicy="none"))
        state, reason = mcp.server_state("x", server, {"values": {}, "tools": {}}, {})
        self.assertEqual(state, mcp.BLOCKED)
        self.assertIn("mutation tools cannot be governed", reason)

    def test_a_verified_tool_list_with_no_read_only_tools_stays_blocked(self):
        server = mcp.with_defaults(http_server(mutation="mutation-capable",
                                               readOnlyPolicy="annotations"))
        health = {"x": {"initialize": 200, "authenticated": True, "outcome": "ok",
                        "tools": [{"name": "create_prompt", "readOnlyHint": False}]}}
        state, reason = mcp.server_state("x", server, {"values": {}, "tools": {}}, health)
        self.assertEqual(state, mcp.BLOCKED)
        self.assertIn("no enforceable read-only subset", reason)

    def test_mutation_tools_are_absent_from_the_rendered_configuration(self):
        health = {"langfuse": {"initialize": 200, "authenticated": True, "outcome": "ok",
                               "tools": [{"name": "get_traces", "readOnlyHint": True},
                                         {"name": "create_prompt", "readOnlyHint": False}]}}
        selection = {"langfuse": self.catalog.get("langfuse")}
        block = mcp.render_codex_block(selection, health=health)
        self.assertIn('enabled_tools = ["get_traces"]', block)
        self.assertNotIn("create_prompt", block)

    def test_an_approval_is_the_only_thing_that_drops_a_read_only_flag(self):
        aws = self.catalog.get("aws")
        settings = {"values": {"awsProfile": "delivery", "endpointRegion": "us-east-1",
                               "operationRegion": "eu-west-1"}, "tools": {}}
        without = mcp.client_view("aws", aws, "claude", settings=settings)
        self.assertIn("--read-only", without["args"])
        withapproval = mcp.client_view("aws", aws, "claude", settings=settings,
                                       approved_mutation=True)
        self.assertNotIn("--read-only", withapproval["args"])
        # And nothing in the catalogue can set that by itself.
        self.assertEqual(mcp.render_claude({"aws": aws}, settings_by_name={"aws": settings})
                         ["aws"]["args"].count("--read-only"), 1)

    def test_every_mutation_capable_server_names_the_approval_its_writes_need(self):
        for name, server in self.catalog.servers.items():
            if server["mutation"] != "mutation-capable":
                continue
            approval = server["mutationApproval"] or {}
            self.assertTrue(approval.get("targets") or approval.get("gate"),
                            f"{name} can write but names no approval for its writes")
            if approval.get("gate") == "publication" or approval.get("targets"):
                self.assertTrue(mcp.mutation_targets(server),
                                f"{name} claims a publication gate but names no target")

    def test_a_mutation_capable_server_without_an_approval_is_a_catalogue_error(self):
        problems = mcp.validate(mcp.migrate(catalogue({"x": http_server(
            mutation="mutation-capable", readOnlyPolicy="annotations")})))
        self.assertTrue(any("must say which approval" in p for p in problems), problems)


class Secrets(unittest.TestCase):
    """9, 10, 11 and 15. Referenced, injected, composed at launch, never stored."""

    def setUp(self):
        self.catalog = mcp.Catalog.load(CATALOG)
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_stored_secret_is_owner_only_and_never_in_metadata(self):
        path = mcp.store_secret("dbhub", "password", "hunter2-not-real", self.root)
        self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")
        self.assertEqual(oct(path.parent.stat().st_mode & 0o777), "0o700")
        user = {"schemaVersion": 2, "servers": {}}
        mcp.set_server_settings(user, "dbhub", values={"connectionMode": "dsn"})
        self.assertNotIn("hunter2", json.dumps(user))

    def test_dbhub_generates_a_toml_that_references_the_variable_not_the_dsn(self):
        settings = {"values": {"connectionMode": "parts", "host": "db.internal",
                               "database": "orders", "username": "fde_readonly",
                               "readOnlyAccount": "yes"}, "tools": {}}
        generated = self.root / "generated"
        written = mcp.generated_files("dbhub", self.catalog.get("dbhub"), settings,
                                      root=generated)
        body = Path(written[0]).read_text()
        self.assertIn('dsn = "${FDE_MCP_DBHUB_DSN}"', body)
        self.assertIn("readonly = true", body)
        self.assertIn("max_rows = 1000", body)
        self.assertNotIn("fde_readonly:", body)
        self.assertEqual(oct(Path(written[0]).stat().st_mode & 0o777), "0o600")

    def test_dbhub_composes_its_dsn_only_into_the_child_environment(self):
        mcp.store_secret("dbhub", "password", "a-real-looking-password", self.root)
        settings = {"values": {"connectionMode": "parts", "host": "db.internal",
                               "database": "orders", "username": "fde_readonly"},
                    "tools": {}}
        env = mcp.child_environment("dbhub", self.catalog.get("dbhub"), settings=settings,
                                    secrets_dir=self.root)
        self.assertTrue(env["FDE_MCP_DBHUB_DSN"].startswith("postgres://fde_readonly:"))
        rendered = mcp.render_claude({"dbhub": self.catalog.get("dbhub")},
                                     settings_by_name={"dbhub": settings})
        self.assertEqual(rendered["dbhub"]["env"]["FDE_MCP_DBHUB_DSN"], "${FDE_MCP_DBHUB_DSN}")
        self.assertNotIn("a-real-looking-password", json.dumps(rendered))

    def test_langfuse_basic_authentication_is_composed_and_never_persisted(self):
        mcp.store_secret("langfuse", "publicKey", "pk-lf-0000-public", self.root)
        mcp.store_secret("langfuse", "secretKey", "sk-lf-0000-secret", self.root)
        server = self.catalog.get("langfuse")
        settings = {"values": {"region": "eu",
                               "endpoint": "https://cloud.langfuse.com/api/public/mcp"},
                    "tools": {}}
        env = mcp.child_environment("langfuse", server, settings=settings,
                                    secrets_dir=self.root)
        self.assertTrue(env["FDE_MCP_LANGFUSE_AUTH"].startswith("Basic "))
        health = {"langfuse": {"initialize": 200, "authenticated": True, "outcome": "ok",
                               "tools": [{"name": "get_traces", "readOnlyHint": True}]}}
        rendered = mcp.render_claude({"langfuse": server},
                                     settings_by_name={"langfuse": settings}, health=health)
        self.assertEqual(rendered["langfuse"]["headers"],
                         {"Authorization": "${FDE_MCP_LANGFUSE_AUTH}"})
        self.assertNotIn("Basic ", json.dumps(rendered))
        block = mcp.render_codex_block({"langfuse": server},
                                       settings_by_name={"langfuse": settings}, health=health)
        self.assertIn('"Authorization" = "FDE_MCP_LANGFUSE_AUTH"', block)

    def test_cloud_configuration_never_persists_a_cloud_credential(self):
        for name in ("aws", "azure"):
            server = self.catalog.get(name)
            self.assertEqual(server["auth"], "local-credential-chain")
            self.assertEqual(mcp.secret_fields(server), [],
                             f"{name} must use the local credential chain, not a stored secret")

    def test_redaction_covers_headers_dsns_tokens_and_key_pairs(self):
        blob = ("Authorization: Bearer abcdef123456\n"
                "postgres://user:hunter2@db.internal:5432/app\n"
                "cookie: session=abc\n"
                "pk-lf-1234abcd sk-lf-1234abcd ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
                "password: verysecretvalue")
        safe = mcp.redact(blob)
        for leaked in ("abcdef123456", "hunter2", "session=abc", "pk-lf-1234abcd",
                       "sk-lf-1234abcd", "ghp_aaaa", "verysecretvalue"):
            self.assertNotIn(leaked, safe)

    def test_a_status_record_carries_no_secret_value(self):
        mcp.store_secret("langfuse", "secretKey", "sk-lf-9999-unmistakable", self.root)
        record = mcp.status_record("langfuse", self.catalog.get("langfuse"),
                                   {"values": {}, "tools": {}}, {}, secrets_dir=self.root)
        self.assertNotIn("sk-lf-9999-unmistakable", json.dumps(record))
        self.assertTrue(record["credentialsPresent"]["secretKey"])


class GatewayPlanning(unittest.TestCase):
    """8. Docker is optional, and a server is never configured twice."""

    def setUp(self):
        self.catalog = mcp.Catalog.load(CATALOG)

    def test_without_docker_everything_runs_directly(self):
        plan = mcp.gateway_plan(self.catalog, available=False)
        self.assertEqual(plan["routedThroughGateway"], {})
        self.assertIn("serena", plan["runDirectly"])

    def test_with_docker_a_routed_server_leaves_the_direct_set(self):
        plan = mcp.gateway_plan(self.catalog, available=True)
        overlap = set(plan["routedThroughGateway"]) & set(plan["runDirectly"])
        self.assertEqual(overlap, set(), "a server may not be both direct and routed")
        self.assertEqual(sorted(plan["dockerProfiles"]),
                         ["coding", "data", "frontend-testing", "client-delivery",
                          "observability"])

    def test_a_profile_restricts_what_the_gateway_would_own(self):
        plan = mcp.gateway_plan(self.catalog, profile="data", available=True)
        self.assertEqual(sorted(plan["routedThroughGateway"]),
                         ["context7", "dbhub", "playwright"])


class SyncBehaviour(unittest.TestCase):
    """6, 7 and 18. What mcp-sync writes, prunes, and refuses to do."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.shared = self.root / "shared"
        (self.shared / "config").mkdir(parents=True)
        (self.shared / "fde-toolkit/plugins/fde-core").mkdir(parents=True)
        self.runs = self.root / "runs"
        self.env = {
            **os.environ,
            "HOME": str(self.root / "home"),
            "CLAUDE_SHARED": str(self.shared),
            "FDE_RUNS_DIR": str(self.runs),
            "FDE_MCP_CATALOG": str(CATALOG),
            "FDE_MCP_USER_CONFIG": str(self.root / "mcp-user-config.json"),
            "FDE_MCP_SECRETS_DIR": str(self.root / "secrets"),
            "FDE_MCP_GENERATED_DIR": str(self.root / "generated"),
            "FDE_MCP_HEALTH_FILE": str(self.root / "health.json"),
            "FDE_AGY_BIN": "definitely-not-installed",
        }
        (self.root / "home").mkdir()
        (self.shared / "config" / "agents.json").write_text(json.dumps({"agents": {
            "claude_work": {"kind": "claude", "profile": "work", "label": "Claude work"},
            "codex_work": {"kind": "codex", "label": "Codex work"},
            "gemini": {"kind": "gemini", "label": "Gemini"},
        }}))

    def tearDown(self):
        self.tmp.cleanup()

    def sync(self, *args, code=0):
        result = subprocess.run([sys.executable, str(MCP_SYNC), *args],
                                capture_output=True, text=True, env=self.env)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result

    def make_run(self, run_id, assignments, stages, profile=None):
        run_dir = self.runs / run_id
        (run_dir / "mcp").mkdir(parents=True)
        (run_dir / "roles.json").write_text(json.dumps(
            {"assignments": assignments, "confirmedAt": "2026-01-01T00:00:00Z"}))
        (run_dir / "plan.json").write_text(json.dumps(
            {"stages": stages, **({"mcpProfile": profile} if profile else {})}))
        (run_dir / "manifest.json").write_text(json.dumps({"runId": run_id}))
        return run_dir

    def write_health(self, servers):
        (self.root / "health.json").write_text(json.dumps(
            {"schemaVersion": 2, "servers": servers}))

    def test_a_dry_run_writes_nothing_and_starts_nothing(self):
        result = self.sync("--dry-run")
        self.assertIn("would write", result.stdout)
        self.assertFalse((self.shared / "fde-toolkit/plugins/fde-core/.mcp.json").exists())
        # No npx, uvx or docker invocation may be implied by planning alone.
        for forbidden in ("npm install", "uvx mcp-proxy", "npx -y @playwright"):
            self.assertNotIn(forbidden, result.stdout)

    def test_the_global_configuration_holds_only_ready_read_only_servers(self):
        self.sync()
        generated = json.loads(
            (self.shared / "fde-toolkit/plugins/fde-core/.mcp.json").read_text())
        self.assertEqual(sorted(generated["mcpServers"]), ["context7"])
        self.assertEqual(generated["_fdeManaged"], ["context7"])

    def test_a_hand_added_server_survives_and_a_dropped_one_is_pruned(self):
        target = self.shared / "fde-toolkit/plugins/fde-core/.mcp.json"
        target.write_text(json.dumps({
            "mcpServers": {"mine": {"type": "http", "url": "https://mine.example.com/mcp"},
                           "gone": {"type": "http", "url": "https://gone.example.com/mcp"}},
            "_fdeManaged": ["gone"]}))
        self.sync()
        generated = json.loads(target.read_text())
        self.assertIn("mine", generated["mcpServers"])
        self.assertNotIn("gone", generated["mcpServers"])

    def test_a_run_binding_needs_confirmed_roles(self):
        run_dir = self.runs / "run-x"
        (run_dir / "mcp").mkdir(parents=True)
        (run_dir / "roles.json").write_text(json.dumps({"assignments": {}}))
        self.sync("--run", "run-x", code=1)

    def test_a_run_gets_mcp_config_and_the_permissions_that_scope_it(self):
        # A pinned allowlist is what makes an OAuth connector scopable at all;
        # this is the shape a run's generated pair must take when one exists.
        pathlib.Path(self.env["FDE_MCP_USER_CONFIG"]).write_text(json.dumps({
            "schemaVersion": 2,
            "servers": {"atlassian": {"enabled": True,
                                      "values": {"allowTools": "getJiraIssue"}}}}))
        run_dir = self.make_run("run-a", {"orchestrator": "claude_work"}, ["intake"])
        self.sync("--run", "run-a")
        config = json.loads((run_dir / "mcp/claude-work.mcp.json").read_text())
        self.assertEqual(sorted(config["mcpServers"]), ["atlassian"])
        permissions = json.loads((run_dir / "mcp/claude-work.settings.json").read_text())
        self.assertEqual(permissions["permissions"]["allow"],
                         ["mcp__atlassian__getJiraIssue"])
        self.assertEqual(permissions["permissions"]["deny"], ["mcp__atlassian"])
        effective = json.loads((run_dir / "mcp/effective.json").read_text())
        self.assertEqual(effective["servers"]["atlassian"]["identities"], ["claude_work"])
        self.assertEqual(oct((run_dir / "mcp/claude-work.mcp.json").stat().st_mode & 0o777),
                         "0o600")

    def test_bedrock_orchestrator_binding_contains_ready_browser_tools(self):
        self.write_health({"playwright": {
            "initialize": 200,
            "authenticated": True,
            "outcome": "ok",
            "tools": [
                {"name": "browser_navigate"},
                {"name": "browser_snapshot", "readOnlyHint": True},
                {"name": "browser_click"},
            ],
        }})
        run_dir = self.make_run(
            "run-browser", {"orchestrator": "claude_work"}, ["research"], profile="data")
        self.sync("--run", "run-browser")
        config = json.loads((run_dir / "mcp/claude-work.mcp.json").read_text())
        self.assertIn("playwright", config["mcpServers"])
        permissions = json.loads((run_dir / "mcp/claude-work.settings.json").read_text())
        self.assertIn("mcp__playwright__browser_navigate", permissions["permissions"]["allow"])
        self.assertIn("mcp__playwright__browser_snapshot", permissions["permissions"]["allow"])
        self.assertIn("mcp__playwright__browser_click", permissions["permissions"]["allow"])

    def test_a_stale_binding_is_removed_when_the_role_moves(self):
        run_dir = self.make_run("run-b", {"orchestrator": "claude_work"}, ["intake"])
        self.sync("--run", "run-b")
        self.assertTrue((run_dir / "mcp/claude-work.mcp.json").exists())
        (run_dir / "roles.json").write_text(json.dumps(
            {"assignments": {"orchestrator": "codex_work"},
             "confirmedAt": "2026-01-01T00:00:00Z"}))
        self.sync("--run", "run-b")
        self.assertFalse((run_dir / "mcp/claude-work.mcp.json").exists())
        self.assertFalse((run_dir / "mcp/claude-work.settings.json").exists())
        self.assertTrue((run_dir / "mcp/codex.toml").exists())

    def test_gemini_uses_an_explicit_evidence_handoff_not_a_dead_config(self):
        run_dir = self.make_run("run-gemini", {"review": "gemini"}, ["review"],
                                profile="client-delivery")
        stale = run_dir / "mcp/gemini.json"
        stale.write_text('{"mcpServers":{"atlassian":{}}}')
        stale_readme = run_dir / "mcp/README.md"
        stale_readme.write_text("old live binding")
        result = self.sync("--run", "run-gemini")
        self.assertIn("fde invoke --context-file", result.stdout)
        self.assertFalse(stale.exists())
        self.assertFalse(stale_readme.exists())
        effective = json.loads((run_dir / "mcp/effective.json").read_text())
        self.assertEqual(effective["servers"], {})

    def test_an_unconfigured_connector_is_refused_with_its_reason(self):
        run_dir = self.make_run("run-c", {"observability": "claude_work"},
                                ["observability"])
        result = self.sync("--run", "run-c")
        self.assertIn("langfuse", result.stdout)
        self.assertIn("not_configured", result.stdout)
        self.assertFalse((run_dir / "mcp/claude-work.mcp.json").exists())

    def test_the_generated_readme_names_a_connector_it_cannot_scope(self):
        run_dir = self.make_run("run-d", {"orchestrator": "claude_work"}, ["intake"])
        self.sync("--run", "run-d")
        readme = (run_dir / "mcp/README.md").read_text()
        self.assertIn("unscoped", readme)
        self.assertIn("approve-publish", readme)
        self.assertIn("--settings", readme)

    def test_an_invalid_catalogue_stops_everything_before_a_write(self):
        broken = self.root / "broken.json"
        broken.write_text(json.dumps(catalogue({"x": http_server(targets=["copilot"])})))
        result = subprocess.run(
            [sys.executable, str(MCP_SYNC)], capture_output=True, text=True,
            env={**self.env, "FDE_MCP_CATALOG": str(broken)})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown target", result.stderr)
        self.assertFalse((self.shared / "fde-toolkit/plugins/fde-core/.mcp.json").exists())

    def test_the_gateway_plan_reports_without_changing_anything(self):
        result = self.sync("--gateway-plan")
        self.assertIn("Docker MCP Gateway", result.stdout)
        self.assertFalse((self.shared / "fde-toolkit/plugins/fde-core/.mcp.json").exists())


if __name__ == "__main__":
    unittest.main()
