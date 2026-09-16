"""Governed MCP inside a run: activation, the record, and the approval gates.

The catalogue tests in test_fde_mcp.py prove the rules. These prove the run
actually obeys them — that what the operator was shown before typing the
approval phrase is what the generated configuration contains, and that a
mutation still needs its own approval afterwards.

Nothing here reaches the network or starts an MCP server.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "claude-shared" / "lib"))

from test_fde import FDETest  # noqa: E402
import fde_mcp as mcp  # noqa: E402


class RunActivation(FDETest):
    """A run reaches exactly what its approved plan and roles call for."""

    def effective(self, run_id):
        return json.loads((self.sb.run_dir(run_id) / "mcp" / "effective.json").read_text())

    def test_the_effective_set_is_persisted_under_the_run(self):
        run_id = self.sb.start_full()
        self.assertEqual(self.sb.full_roles(run_id, orchestrator="claude_alt").returncode, 0)
        effective = self.effective(run_id)
        self.assertEqual(effective["runId"], run_id)
        self.assertEqual(sorted(effective["servers"]), ["atlassian", "figma"])
        self.assertEqual(effective["servers"]["atlassian"]["identities"],
                         ["claude_alt", "claude_msc"])
        self.assertEqual(effective["servers"]["atlassian"]["mutation"], "mutation-capable")

    def test_activation_is_recorded_server_by_server(self):
        run_id = self.sb.start_full()
        self.sb.full_roles(run_id, orchestrator="claude_alt")
        events = [json.loads(line) for line in
                  (self.sb.run_dir(run_id) / "events.jsonl").read_text().splitlines() if line]
        activated = [e for e in events if e.get("event") == "mcp.server.activated"]
        self.assertEqual(sorted(e["server"] for e in activated), ["atlassian", "figma"])
        for event in activated:
            self.assertIn("classification", event)
            self.assertIn("toolScope", event)
            # A record of an activation is not a place to put a credential, an
            # argument or a result.
            self.assertNotIn("secret", json.dumps(event).lower())

    def test_a_server_the_run_cannot_use_is_recorded_with_its_reason(self):
        run_id = self.sb.start_full()
        self.sb.full_roles(run_id, orchestrator="claude_alt")
        effective = self.effective(run_id)
        refused = effective["refused"]
        self.assertTrue(refused, "the run should record why the rest were not activated")
        for name, item in refused.items():
            self.assertIn(item["state"], mcp.LIFECYCLE_STATES)
            self.assertTrue(item["reason"])

    def test_an_invocation_carries_the_config_and_the_settings_that_scope_it(self):
        run_id = self.sb.start_full()
        self.assertEqual(self.sb.full_roles(run_id, orchestrator="claude_alt").returncode, 0)
        self.sb.advance_to(run_id, "intake")
        task = self.sb.run_dir(run_id) / "tasks/mcp.md"
        task.parent.mkdir(parents=True, exist_ok=True)
        task.write_text("Read the approved source through MCP")
        result = self.sb.fde("invoke", run_id, "claude_alt", str(task),
                             "--stage", "intake", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = json.loads(result.stdout)["argv"]
        self.assertIn("--mcp-config", argv)
        self.assertIn("--settings", argv)
        self.assertIn(str(self.sb.run_dir(run_id) / "mcp/claude-alt.settings.json"), argv)

    def test_servers_are_withheld_when_their_tool_scope_was_not_generated(self):
        """The two files travel together. A config without its settings would
        hand the session tools the run never approved, so it hands it none."""
        run_id = self.sb.start_full()
        self.assertEqual(self.sb.full_roles(run_id, orchestrator="claude_alt").returncode, 0)
        (self.sb.run_dir(run_id) / "mcp/claude-alt.settings.json").unlink()
        self.sb.advance_to(run_id, "intake")
        task = self.sb.run_dir(run_id) / "tasks/mcp.md"
        task.parent.mkdir(parents=True, exist_ok=True)
        task.write_text("Read the approved source through MCP")
        result = self.sb.fde("invoke", run_id, "claude_alt", str(task),
                             "--stage", "intake", "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        argv = json.loads(result.stdout)["argv"]
        self.assertNotIn("--mcp-config", argv)
        self.assertIn("tool scope", result.stderr)

    def test_a_reassigned_role_takes_its_connector_with_it(self):
        run_id = self.sb.start_full()
        self.sb.full_roles(run_id, orchestrator="claude_alt")
        mcp_dir = self.sb.run_dir(run_id) / "mcp"
        self.assertTrue((mcp_dir / "claude-alt.mcp.json").exists())
        self.assertEqual(
            self.sb.fde("roles", run_id, "--set", "orchestrator=claude_work",
                        "--reassign").returncode, 0)
        self.assertFalse((mcp_dir / "claude-alt.mcp.json").exists(),
                         "a connector must not survive the role that granted it")
        self.assertFalse((mcp_dir / "claude-alt.settings.json").exists())
        self.assertTrue((mcp_dir / "claude-work.mcp.json").exists())

    def test_the_generated_directory_holds_no_credential(self):
        run_id = self.sb.start_full()
        self.sb.full_roles(run_id, orchestrator="claude_alt")
        for path in (self.sb.run_dir(run_id) / "mcp").iterdir():
            if not path.is_file():
                continue
            body = path.read_text(errors="replace")
            self.assertEqual(body, mcp.redact(body),
                             f"{path.name} contains something that reads as a credential")


class ApprovalBoundMutations(FDETest):
    """A mutation-capable connector still needs the approval FDE already had."""

    def approved_run(self):
        """The shortest plan that still ends at a publication gate."""
        run_id = self.sb.start("Publish the ACME-142 findings", orchestrator="claude_alt")
        result = self.sb.plan(run_id, "intake", "publication")
        assert result.returncode == 0, result.stderr
        result = self.sb.fde("roles", run_id, "--set", "orchestrator=claude_alt",
                             "--allow-unassigned")
        assert result.returncode == 0, result.stderr
        return run_id

    def test_a_publication_approval_names_the_connectors_it_covers(self):
        run_id = self.approved_run()
        self.sb.advance_to(run_id, "awaiting_publication_approval")
        result = self.sb.fde("approve-publish", run_id, "jira", "--summary", "ACME-142",
                             stdin=f"APPROVE PUBLISH {run_id}\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("atlassian", result.stdout)
        events = [json.loads(line) for line in
                  (self.sb.run_dir(run_id) / "events.jsonl").read_text().splitlines() if line]
        granted = next(e for e in events if e.get("event") == "approval.publish.granted")
        self.assertEqual(granted["mcpServers"], ["atlassian"])

    def test_an_approval_covers_only_the_target_it_was_typed_for(self):
        """Atlassian is the connector this run holds, and it writes to Jira and
        Confluence. Approving a Figma publication therefore authorises none of
        its tools — an approval is not a general unlock."""
        run_id = self.approved_run()
        self.sb.advance_to(run_id, "awaiting_publication_approval")
        result = self.sb.fde("approve-publish", run_id, "figma", "--summary", "reconciled design",
                             stdin=f"APPROVE PUBLISH {run_id}\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        events = [json.loads(line) for line in
                  (self.sb.run_dir(run_id) / "events.jsonl").read_text().splitlines() if line]
        granted = next(e for e in events if e.get("event") == "approval.publish.granted")
        self.assertEqual(granted["target"], "figma")
        self.assertEqual(granted["mcpServers"], [])
        self.assertNotIn("atlassian", granted["mcpServers"])

    def test_a_read_only_flag_is_only_dropped_under_an_approval(self):
        """The AWS and Azure proxies run with --read-only, so their write tools
        are absent from the process rather than merely discouraged. Only an
        explicit approval decision removes that flag, and it never persists."""
        catalog = mcp.Catalog.load(
            Path(self.sb.shared) / "mcp" / "mcp-servers.json")
        settings = {"values": {"awsProfile": "delivery", "endpointRegion": "us-east-1",
                               "operationRegion": "eu-west-1"}, "tools": {}}
        default = mcp.render_claude({"aws": catalog.get("aws")},
                                    settings_by_name={"aws": settings})
        self.assertIn("--read-only", default["aws"]["args"])
        with_approval = mcp.client_view("aws", catalog.get("aws"), "claude",
                                        settings=settings, approved_mutation=True)
        self.assertNotIn("--read-only", with_approval["args"])
        # Rendering again without the approval flag is read-only once more: the
        # approval leaves no configuration behind.
        again = mcp.render_claude({"aws": catalog.get("aws")},
                                  settings_by_name={"aws": settings})
        self.assertIn("--read-only", again["aws"]["args"])

    def test_an_expired_or_consumed_approval_stops_covering_anything(self):
        run_id = self.approved_run()
        self.sb.advance_to(run_id, "awaiting_publication_approval")
        self.sb.fde("approve-publish", run_id, "jira", "--summary", "ACME-142", "--ttl", "1",
                    stdin=f"APPROVE PUBLISH {run_id}\n")
        approvals = [json.loads(line) for line in
                     (self.sb.run_dir(run_id) / "approvals.jsonl").read_text().splitlines()
                     if line]
        granted = next(a for a in approvals if a.get("type") == "publication-approval")
        self.assertEqual(granted["target"], "jira")
        self.assertFalse(granted["consumed"])
        self.assertLess(granted["issuedAt"], granted["expiresAt"])
        # An approval is one target, one use, with an expiry. Nothing in the
        # generated MCP configuration references it, so it cannot outlive itself.
        for path in (self.sb.run_dir(run_id) / "mcp").glob("*.json"):
            self.assertNotIn(granted["approvalId"], path.read_text())


class CombinedApprovalSummary(FDETest):
    """Access is shown before it is granted, and never widened silently."""

    def test_the_proposed_connectors_appear_in_the_approval_summary(self):
        run_id = self.sb.start("Publish the ACME-142 findings", shape="full",
                               orchestrator="claude_alt")
        self.assertEqual(self.sb.fde("plan", run_id, "--shape", "full",
                                     "--require-approval").returncode, 0)
        self.sb.full_roles(run_id, orchestrator="claude_alt")
        result = self.sb.fde("approve-plan", run_id, stdin="no\n")
        self.assertIn("connectors", result.stdout)
        self.assertIn("atlassian", result.stdout)
        self.assertIn("tenant-data", result.stdout)
        # And the honest caveat, before the phrase is typed rather than after.
        self.assertIn("unscoped", result.stdout)
        self.assertNotEqual(result.returncode, 0, "an unmatched phrase approves nothing")


if __name__ == "__main__":
    unittest.main()
