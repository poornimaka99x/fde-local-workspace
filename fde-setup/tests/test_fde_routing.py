#!/usr/bin/env python3
"""Acceptance and unit coverage for intelligent routing.

Every test runs against the throwaway HOME built by the Sandbox in test_fde.py,
and every routing test that asserts a model choice installs its OWN fake policy
first. That matters: a test that depended on the shipped tier list would start
failing the day an operator re-weighted their own costs, and a test that
depended on a real provider price would be asserting something nobody can date.
No test here calls a model provider.

  python3 -m unittest discover -s tests -v
"""
import importlib.machinery
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import unittest

from test_fde import FDETest, REPO, SRC_SHARED

FDE_PATH = SRC_SHARED / "bin" / "fde"
ACCOUNTS_TS = REPO / "fde-gui" / "server" / "src" / "services" / "accounts.ts"


def load_fde_module():
    """Import the controller as a module so its pure functions can be unit-tested."""
    loader = importlib.machinery.SourceFileLoader("fde_routing_test_module", str(FDE_PATH))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


FDE = load_fde_module()


# A catalogue with invented names and invented relative weights. Three tiers,
# one obvious cheap option and one obvious expensive one, so a strategy's
# behaviour is visible rather than inferred.
FAKE_POLICY = {
    "schemaVersion": 1,
    "policyRevision": "test-fixture-1",
    "strategies": ["balanced", "quality_first", "cost_first", "manual"],
    "defaultStrategy": "balanced",
    "tiers": {"economy": 0, "standard": 1, "premium": 2},
    "efforts": ["auto", "low", "medium", "high", "xhigh", "max"],
    "effortCostMultiplier": {"auto": 1.0, "low": 0.5, "medium": 1.0, "high": 2.0,
                             "xhigh": 3.0, "max": 4.0},
    "expectedRetry": {"tierBelowBand": 0.6, "tierAtBand": 0.1, "tierAboveBand": 0.05},
    "providers": {
        "anthropic": {
            "label": "Fake Claude",
            "models": [
                {"id": "tiny", "label": "Tiny", "tier": "economy", "efforts": ["auto"],
                 "costWeight": 1, "contextTokens": None, "strengths": ["extraction"],
                 "limitations": ["not for judgement"]},
                {"id": "mid", "label": "Mid", "tier": "standard",
                 "efforts": ["auto", "low", "medium", "high", "max"], "costWeight": 4,
                 "contextTokens": None, "strengths": ["implementation"], "limitations": []},
                {"id": "big", "label": "Big", "tier": "premium",
                 "efforts": ["auto", "low", "medium", "high", "xhigh", "max"],
                 "costWeight": 20, "contextTokens": None,
                 "strengths": ["architecture"], "limitations": []},
            ],
        },
        "bedrock": {
            "label": "Fake Bedrock",
            "models": [
                {"id": "mid", "label": "Mid (Bedrock)", "tier": "standard",
                 "efforts": ["auto", "medium", "high"], "costWeight": 4,
                 "contextTokens": None, "strengths": [], "limitations": ["no web search"]},
                {"id": "big", "label": "Big (Bedrock)", "tier": "premium",
                 "efforts": ["high", "xhigh"], "costWeight": 20, "contextTokens": None,
                 "strengths": [], "limitations": ["no web search"]},
            ],
        },
        "codex": {
            "label": "Fake Codex",
            "models": [
                {"id": "cx-small", "label": "CX Small", "tier": "standard",
                 "efforts": ["low", "medium", "high"], "costWeight": 3,
                 "contextTokens": None, "strengths": [], "limitations": ["no auto effort"]},
                {"id": "cx-large", "label": "CX Large", "tier": "premium",
                 "efforts": ["medium", "high", "xhigh"], "costWeight": 18,
                 "contextTokens": None, "strengths": [], "limitations": []},
            ],
        },
    },
    "unroutableKinds": {"gemini": "no model selection through this toolkit",
                        "copilot-studio": "the tenant's model, not this controller's"},
    "floors": {
        "low": {"minimumTier": "economy", "minimumEffort": "auto"},
        "standard": {"minimumTier": "standard", "minimumEffort": "medium"},
        "high": {"minimumTier": "standard", "minimumEffort": "high"},
        "critical": {"minimumTier": "premium", "minimumEffort": "high"},
    },
    "taskFloors": {
        "intake": "low", "research": "standard", "solutioning": "high", "review": "high",
        "reconciliation": "high", "presentation": "standard", "planning": "standard",
        "implementation": "standard", "verification": "high", "deployment": "critical",
        "observability": "standard", "publication": "high",
    },
    "riskFloors": {
        "security": "critical", "authentication": "critical", "production": "critical",
        "destructive": "critical", "dataMigration": "critical",
        "legalCompliance": "critical", "payments": "critical", "irreversible": "critical",
        "deployment": "high", "publication": "high", "privacy": "high",
        "codeChange": "standard",
    },
    "bands": {
        "simple": {"maxScore": 3, "recommendedTier": "economy", "preferredEffort": "auto",
                   "floor": "low"},
        "standard": {"maxScore": 7, "recommendedTier": "standard",
                     "preferredEffort": "medium", "floor": "standard"},
        "complex": {"maxScore": 10, "recommendedTier": "premium",
                    "preferredEffort": "high", "floor": "high"},
        "critical": {"maxScore": 14, "recommendedTier": "premium",
                     "preferredEffort": "high", "floor": "critical"},
    },
    "limits": {
        "simple": {"maxSpecialists": 1, "maxSpecialistsPerStage": 1, "maxParallel": 1,
                   "maxRetries": 1, "maxCostUnits": 20, "maxAutomaticTier": "standard",
                   "maxAutomaticEffort": "medium", "requireIndependentReview": False},
        "standard": {"maxSpecialists": 6, "maxSpecialistsPerStage": 1, "maxParallel": 2,
                     "maxRetries": 1, "maxCostUnits": 80, "maxAutomaticTier": "standard",
                     "maxAutomaticEffort": "high", "requireIndependentReview": False},
        "complex": {"maxSpecialists": 8, "maxSpecialistsPerStage": 2, "maxParallel": 3,
                    "maxRetries": 1, "maxCostUnits": 400, "maxAutomaticTier": "premium",
                    "maxAutomaticEffort": "high", "requireIndependentReview": False},
        "critical": {"maxSpecialists": 10, "maxSpecialistsPerStage": 3, "maxParallel": 3,
                     "maxRetries": 2, "maxCostUnits": 2000, "maxAutomaticTier": "premium",
                     "maxAutomaticEffort": "xhigh", "requireIndependentReview": True},
    },
    "escalation": {
        "ladder": [
            {"tier": "economy", "effort": "auto"},
            {"tier": "standard", "effort": "medium"},
            {"tier": "standard", "effort": "high"},
            {"tier": "premium", "effort": "high"},
            {"tier": "premium", "effort": "xhigh"},
        ],
        "requireRecordedFailureAbove": {"tier": "premium", "effort": "high"},
    },
    "specialists": {
        "orchestrator": None, "productManagement": "product-analyst",
        "research": "researcher", "solutioning": "solutioner",
        "uiUxDesign": "ui-ux-designer", "designSystem": "design-system-steward",
        "review": "reviewer", "prReview": "pr-analyst",
        "standardsReview": "standards-reviewer", "securityReview": "security-reviewer",
        "deliveryPlanning": "delivery-manager", "presentation": None,
        "implementation": "implementation-engineer", "testEngineering": "test-engineer",
        "ciInvestigation": "ci-investigator", "releaseManagement": "release-manager",
        "observability": "sre-observability", "microsoftContext": None,
    },
    "independentReviewMethods": {"default": "reliability-reviewer",
                                 "security": "security-reviewer",
                                 "authentication": "security-reviewer"},
}

SIMPLE_REQUEST = "Rename the column header in export.csv from 'qty' to 'quantity'."
STANDARD_REQUEST = (
    "ACME-142 Add a paginated /orders endpoint to the existing NestJS API so that the web "
    "app can page through orders; it must return 50 per page and keep the existing "
    "response envelope.")
CRITICAL_REQUEST = (
    "We need to rethink how authentication works across the estate before we go live in "
    "production - explore the options and figure out what is better.")


class RoutingTest(FDETest):
    """A sandbox whose routing policy is a fixture, not the shipped one."""

    def setUp(self):
        super().setUp()
        self.policy_path = self.sb.shared / "config" / "routing-policy.json"
        self.install_policy(FAKE_POLICY)

    def install_policy(self, policy):
        self.policy_path.write_text(json.dumps(policy, indent=2), encoding="utf-8")

    def preview(self, requirement, *extra, expect=0, **envkw):
        result = self.sb.fde("routing", "preview", "-o", "work", "--requirement-stdin",
                             *extra, "--json", stdin=requirement, **envkw)
        self.assertEqual(result.returncode, expect,
                         f"stdout={result.stdout}\nstderr={result.stderr}")
        return json.loads(result.stdout)

    def routed_run(self, requirement=STANDARD_REQUEST, stages=("intake", "solutioning",
                                                               "review"),
                   orchestrator="claude_work", strategy="balanced", roles=None):
        """A run created with automatic routing, planned and role-assigned."""
        result = self.sb.fde("start", requirement, "--orchestrator", orchestrator,
                             "--routing", "auto", "--strategy", strategy)
        self.assertEqual(result.returncode, 0, result.stderr)
        run_id = next(line.split()[1] for line in result.stdout.splitlines()
                      if line.startswith("run "))
        plan = self.sb.fde("plan", run_id, "--stages", ",".join(stages),
                           "--require-approval")
        self.assertEqual(plan.returncode, 0, plan.stderr)
        assignment = dict(roles or {})
        args = []
        for role in json.loads((self.sb.shared / "runs" / run_id / "plan.json")
                               .read_text())["rolesNeeded"]:
            if role == "orchestrator":
                continue
            args += ["--set", f"{role}={assignment.get(role, 'none')}"]
        assigned = self.sb.fde("roles", run_id, *args)
        self.assertEqual(assigned.returncode, 0, assigned.stderr)
        return run_id

    def routing_doc(self, run_id):
        return json.loads((self.sb.shared / "runs" / run_id / "routing.json").read_text())

    def approve(self, run_id, expect=0):
        result = self.sb.fde("approve-plan", run_id, stdin=f"APPROVE PLAN {run_id}\n")
        self.assertEqual(result.returncode, expect,
                         f"stdout={result.stdout}\nstderr={result.stderr}")
        return result


# -- 1. the policy is data, and it is checked --------------------------------

class TestPolicyValidation(RoutingTest):
    def test_shipped_policy_is_valid(self):
        """The policy this toolkit ships passes its own strict validation."""
        policy = FDE.validate_routing_policy(
            json.loads((SRC_SHARED / "config" / "routing-policy.json").read_text()))
        self.assertEqual(policy["schemaVersion"], 1)
        self.assertTrue(policy["policyRevision"])

    def test_ambiguous_default_model_is_refused(self):
        """'default' cannot be routed to: it is not comparable on quality or cost."""
        broken = json.loads(json.dumps(FAKE_POLICY))
        broken["providers"]["anthropic"]["models"].append(
            {"id": "default", "label": "Account default", "tier": "standard",
             "efforts": ["auto"], "costWeight": 4, "contextTokens": None,
             "strengths": [], "limitations": []})
        with self.assertRaises(FDE.RoutingError) as caught:
            FDE.validate_routing_policy(broken)
        self.assertEqual(caught.exception.code, "routing-policy-invalid")
        self.assertIn("default", caught.exception.message)

    def test_effort_the_controller_cannot_pass_is_refused(self):
        """A policy may not name an effort this controller cannot hand to a provider."""
        broken = json.loads(json.dumps(FAKE_POLICY))
        broken["providers"]["codex"]["models"][0]["efforts"].append("ultra")
        with self.assertRaises(FDE.RoutingError) as caught:
            FDE.validate_routing_policy(broken)
        self.assertIn("ultra", caught.exception.message)

    def test_monetary_price_needs_a_source_currency_and_date(self):
        """A bare number is not a price anybody can date or check."""
        broken = json.loads(json.dumps(FAKE_POLICY))
        broken["providers"]["anthropic"]["models"][1]["price"] = {"amount": 3}
        with self.assertRaises(FDE.RoutingError) as caught:
            FDE.validate_routing_policy(broken)
        self.assertIn("source", caught.exception.message)

    def test_ceiling_below_its_own_floor_is_refused(self):
        """A band whose ceiling cannot satisfy its own floor can never route."""
        broken = json.loads(json.dumps(FAKE_POLICY))
        broken["limits"]["critical"]["maxAutomaticTier"] = "standard"
        with self.assertRaises(FDE.RoutingError) as caught:
            FDE.validate_routing_policy(broken)
        self.assertIn("quality floor", caught.exception.message)

    def test_descending_escalation_ladder_is_refused(self):
        broken = json.loads(json.dumps(FAKE_POLICY))
        broken["escalation"]["ladder"] = [
            {"tier": "premium", "effort": "high"},
            {"tier": "economy", "effort": "auto"},
        ]
        with self.assertRaises(FDE.RoutingError) as caught:
            FDE.validate_routing_policy(broken)
        self.assertIn("ascend", caught.exception.message)

    def test_broken_policy_reports_actionably_and_does_not_crash_version(self):
        """`fde version` still answers when automatic routing is unavailable."""
        self.policy_path.write_text("{ not json", encoding="utf-8")
        version = self.sb.fde("version", "--json")
        self.assertEqual(version.returncode, 0, version.stderr)
        payload = json.loads(version.stdout)
        self.assertEqual(payload["routingPolicy"]["state"], "unavailable")
        self.assertIn("routing.preview", payload["capabilities"])
        preview = self.sb.fde("routing", "preview", "-o", "work", "--json",
                              stdin="anything")
        self.assertEqual(preview.returncode, 2)
        self.assertEqual(json.loads(preview.stdout)["error"]["code"],
                         "routing-policy-invalid")


class TestPolicyMatchesConsoleCatalogue(unittest.TestCase):
    """The shipped policy may only name combinations the console will accept.

    `AccountService.validateSelection` is the availability boundary, and it lives
    in TypeScript. Rather than trust two files to agree, this reads the
    console's own catalogue and refuses a policy entry the console would reject.
    If accounts.ts is restructured this test fails loudly, which is the correct
    outcome: the invariant is not optional."""

    @staticmethod
    def console_catalogue():
        source = ACCOUNTS_TS.read_text(encoding="utf-8")
        catalogues = {}
        for name in ("MODELS", "CODEX_MODELS"):
            match = re.search(
                r"const " + name + r": ModelOption\[\] = \[(.*?)\n\]", source, re.S)
            assert match, f"could not find {name} in {ACCOUNTS_TS}"
            entries = {}
            for entry in re.finditer(
                    r"\{\s*id:\s*'([^']+)'.*?efforts:\s*\[([^\]]*)\]", match.group(1),
                    re.S):
                efforts = re.findall(r"'([^']+)'", entry.group(2))
                spread = "...EFFORTS" in entry.group(2)
                entries[entry.group(1)] = (
                    ["auto", "low", "medium", "high", "xhigh", "max", "ultra"]
                    if spread else efforts)
            catalogues[name] = entries
        return catalogues

    def test_every_routable_combination_is_offered_by_the_console(self):
        policy = json.loads((SRC_SHARED / "config" / "routing-policy.json").read_text())
        catalogues = self.console_catalogue()
        for provider, spec in policy["providers"].items():
            offered = catalogues["CODEX_MODELS" if provider == "codex" else "MODELS"]
            for model in spec["models"]:
                self.assertIn(
                    model["id"], offered,
                    f"routing policy offers {provider}/{model['id']}, which the console "
                    f"does not list, so validateSelection would reject it")
                for effort in model["efforts"]:
                    self.assertIn(
                        effort, offered[model["id"]],
                        f"routing policy offers {provider}/{model['id']} at '{effort}', "
                        f"which the console does not list for that model")


# -- 2. the assessment is pure, and says what it saw -------------------------

class TestAssessment(unittest.TestCase):
    def setUp(self):
        self.policy = FDE.validate_routing_policy(json.loads(json.dumps(FAKE_POLICY)))

    def assess(self, requirement, stages=(), **extra):
        request = {"requirement": requirement, "stages": list(stages),
                   "attachments": [], "repoCount": 0}
        request.update(extra)
        return FDE.assess_run_request(self.policy, request)

    def test_every_dimension_is_scored_with_evidence(self):
        assessment = self.assess(STANDARD_REQUEST, ["intake", "implementation"])
        ids = [d["id"] for d in assessment["dimensions"]]
        self.assertEqual(ids, ["scopeBreadth", "ambiguity", "reasoningDepth",
                               "contextVolume", "coordination", "reversibility",
                               "verification"])
        for dimension in assessment["dimensions"]:
            self.assertIn(dimension["score"], (0, 1, 2))
            self.assertTrue(dimension["evidence"], dimension)

    def test_assessment_is_deterministic_and_reads_nothing(self):
        first = self.assess(CRITICAL_REQUEST, ["intake", "solutioning"])
        second = self.assess(CRITICAL_REQUEST, ["intake", "solutioning"])
        self.assertEqual(first, second)

    def test_a_precise_short_request_is_not_treated_as_ambiguous(self):
        """Naming concrete things is evidence of specification, not of brevity."""
        assessment = self.assess(SIMPLE_REQUEST, ["intake"])
        ambiguity = next(d for d in assessment["dimensions"] if d["id"] == "ambiguity")
        self.assertEqual(ambiguity["score"], 0, ambiguity)
        self.assertEqual(assessment["band"], "simple")

    def test_risk_overrides_the_arithmetic_score(self):
        """A security concern raises the band whatever the score adds up to."""
        plain = self.assess("Add a tooltip to the saveDraft button in editor.tsx.",
                            ["intake"])
        risky = self.assess(
            "Add a tooltip to the saveDraft button in editor.tsx. It must not leak the "
            "session token or weaken CSRF protection in production.", ["intake"])
        self.assertEqual(plain["band"], "simple")
        self.assertEqual(risky["band"], "critical")
        self.assertEqual(risky["qualityFloor"], "critical")
        self.assertTrue(any(entry["flag"] == "security" for entry in risky["riskFlags"]))
        self.assertTrue(any("risk raised the band" in note
                            for note in risky["overrides"]))

    def test_low_confidence_raises_the_band_and_asks_a_question(self):
        """An uncertain assessment is never routed downward."""
        assessment = self.assess("improve it somehow", ["intake"])
        self.assertEqual(assessment["confidence"], "low")
        self.assertTrue(assessment["clarification"])
        self.assertTrue(any("low assessment confidence" in note
                            for note in assessment["overrides"]))
        self.assertNotEqual(assessment["band"], "simple")

    def test_missing_request_is_reported_not_guessed(self):
        assessment = self.assess("", [])
        self.assertEqual(assessment["confidence"], "low")
        self.assertTrue(any("request itself" in item
                            for item in assessment["missingInformation"]))

    def test_attachment_metadata_only(self):
        """Volume comes from size and count; nothing opens an attachment."""
        light = self.assess(STANDARD_REQUEST, ["intake"], attachments=[])
        heavy = self.assess(STANDARD_REQUEST, ["intake"], attachments=[
            {"size": 900_000, "mediaType": "application/pdf"},
            {"size": 900_000, "mediaType": "application/pdf"},
        ])
        self.assertGreater(
            next(d["score"] for d in heavy["dimensions"] if d["id"] == "contextVolume"),
            next(d["score"] for d in light["dimensions"] if d["id"] == "contextVolume"))


# -- 3. selection is a constraint filter, not a preference ------------------

class TestModelSelection(unittest.TestCase):
    def setUp(self):
        self.policy = FDE.validate_routing_policy(json.loads(json.dumps(FAKE_POLICY)))

    def candidates(self, band, floor):
        return FDE.model_candidates(
            self.policy, "anthropic", band=band, floor=floor,
            limits=self.policy["limits"][band])

    def test_choices_below_the_floor_are_refused_with_a_reason(self):
        accepted, rejected = self.candidates("critical", "critical")
        self.assertTrue(accepted)
        for choice in accepted:
            self.assertEqual(choice["tier"], "premium")
            self.assertIn(choice["effort"], ("high", "xhigh"))
        reasons = {(entry["model"], entry["effort"]): entry["reason"] for entry in rejected}
        self.assertIn(("tiny", "auto"), reasons)
        self.assertIn("below the 'critical' quality floor", reasons[("tiny", "auto")])

    def test_choices_above_the_ceiling_are_refused_with_a_reason(self):
        accepted, rejected = self.candidates("simple", "low")
        self.assertNotIn("premium", {choice["tier"] for choice in accepted})
        self.assertTrue(any("above the automatic ceiling" in entry["reason"]
                            for entry in rejected))

    def test_expected_cost_penalises_an_underpowered_attempt(self):
        """Cheap and likely to be repeated is not cheap."""
        accepted, _rejected = self.candidates("complex", "high")
        by_choice = {(c["model"], c["effort"]): c for c in accepted}
        under = by_choice[("mid", "high")]
        at_tier = by_choice[("big", "high")]
        self.assertGreater(under["retryProbability"], at_tier["retryProbability"])
        self.assertGreater(under["expectedCostUnits"], under["costUnits"])

    def test_escalation_ceiling_stops_at_the_band_limits(self):
        ceiling = FDE.escalation_ceiling(
            self.policy, tier="standard", effort="medium",
            limits=self.policy["limits"]["standard"])
        self.assertEqual((ceiling["tier"], ceiling["effort"]), ("standard", "high"))
        top = FDE.escalation_ceiling(
            self.policy, tier="premium", effort="high",
            limits=self.policy["limits"]["critical"])
        self.assertEqual((top["tier"], top["effort"]), ("premium", "xhigh"))
        self.assertEqual(top["maxRetries"], 2)


# -- 4. the route, end to end, through the controller ----------------------

class TestRoutingPreview(RoutingTest):
    def test_simple_request_gets_an_economical_route_and_no_specialist(self):
        """1. Nothing is created that the orchestrator can do itself."""
        preview = self.preview(SIMPLE_REQUEST, "--stages", "intake")["preview"]
        self.assertEqual(preview["assessment"]["band"], "simple")
        self.assertEqual(preview["orchestrator"]["model"], "tiny")
        self.assertEqual(preview["orchestrator"]["effort"], "auto")
        self.assertEqual(preview["specialistCount"], 0)
        self.assertEqual([task["specialist"] for task in preview["tasks"]], [None])

    def test_normal_implementation_gets_a_standard_route(self):
        """2. Clear acceptance criteria, ordinary work, middle of the catalogue."""
        preview = self.preview(STANDARD_REQUEST, "--shape", "build")["preview"]
        self.assertEqual(preview["assessment"]["band"], "standard")
        self.assertEqual(preview["orchestrator"]["model"], "mid")
        self.assertEqual(preview["orchestrator"]["tier"], "standard")

    def test_security_and_production_work_cannot_route_below_its_floor(self):
        """3. Risk decides the floor, and the floor is not negotiable."""
        preview = self.preview(CRITICAL_REQUEST, "--shape", "research-to-adr")["preview"]
        self.assertEqual(preview["assessment"]["qualityFloor"], "critical")
        self.assertEqual(preview["orchestrator"]["tier"], "premium")
        self.assertIn(preview["orchestrator"]["effort"], ("high", "xhigh"))
        for task in preview["tasks"]:
            if task["routable"]:
                self.assertEqual(task["tier"], "premium")

    def test_cost_first_still_respects_the_floor(self):
        """5. The cheapest choice that clears the floor, never below it."""
        cheap = self.preview(CRITICAL_REQUEST, "--shape", "research-to-adr",
                             "--strategy", "cost_first")["preview"]
        quality = self.preview(CRITICAL_REQUEST, "--shape", "research-to-adr",
                               "--strategy", "quality_first")["preview"]
        self.assertEqual(cheap["orchestrator"]["tier"], "premium")
        self.assertEqual(cheap["orchestrator"]["effort"], "high")
        self.assertEqual(quality["orchestrator"]["effort"], "xhigh")
        self.assertLess(cheap["estimatedCostUnits"], quality["estimatedCostUnits"])

    def test_cost_first_is_cheaper_than_quality_first_on_ordinary_work(self):
        cheap = self.preview(STANDARD_REQUEST, "--shape", "build",
                             "--strategy", "cost_first")["preview"]
        quality = self.preview(STANDARD_REQUEST, "--shape", "build",
                               "--strategy", "quality_first")["preview"]
        self.assertLessEqual(cheap["estimatedCostUnits"], quality["estimatedCostUnits"])

    def test_automatic_mode_never_selects_default_or_an_unsupported_effort(self):
        """6. Every generated choice is a concrete model at a supported effort."""
        for requirement, shape in ((SIMPLE_REQUEST, "research"),
                                   (STANDARD_REQUEST, "build"),
                                   (CRITICAL_REQUEST, "full")):
            preview = self.preview(requirement, "--shape", shape)["preview"]
            choices = [preview["orchestrator"]] + list(preview["tasks"])
            for choice in choices:
                if not choice["routable"]:
                    continue
                self.assertNotEqual(choice["model"], "default", choice)
                offered = {model["id"]: model["efforts"] for model in
                           FAKE_POLICY["providers"][choice["provider"]]["models"]}
                self.assertIn(choice["model"], offered, choice)
                self.assertIn(choice["effort"], offered[choice["model"]], choice)

    def test_low_confidence_route_carries_the_question_that_would_fix_it(self):
        """4. Raised a tier, and told what to ask."""
        preview = self.preview("improve it somehow", "--stages", "intake")["preview"]
        self.assertEqual(preview["assessment"]["confidence"], "low")
        self.assertTrue(preview["assessment"]["clarification"])
        self.assertTrue(any("confidence is low" in warning
                            for warning in preview["warnings"]))

    def test_preview_is_deterministic_and_writes_nothing(self):
        """7. Same input, same answer, and not a single new file."""
        runs = self.sb.shared / "runs"
        before = sorted(p.name for p in runs.iterdir())
        first = self.preview(STANDARD_REQUEST, "--shape", "build")["preview"]
        second = self.preview(STANDARD_REQUEST, "--shape", "build")["preview"]
        first.pop("provisionalReason", None)
        second.pop("provisionalReason", None)
        self.assertEqual(first, second)
        self.assertEqual(first["decisionHash"], second["decisionHash"])
        self.assertEqual(sorted(p.name for p in runs.iterdir()), before)

    def test_preview_refuses_an_unavailable_account_without_substituting_one(self):
        """13. Fails actionably; never quietly picks a different identity."""
        import shutil as _shutil
        _shutil.rmtree(self.sb.profiles / "msc")
        result = self.sb.fde("routing", "preview", "-o", "msc", "--requirement-stdin",
                             "--json", stdin=STANDARD_REQUEST)
        self.assertEqual(result.returncode, 3)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "routing-account-unavailable")
        self.assertIn("not available", payload["error"]["message"])
        self.assertIn("will not substitute", payload["error"]["hint"])

    def test_identity_with_no_model_choice_is_reported_not_invented(self):
        preview = self.preview(STANDARD_REQUEST, "--stages", "intake,research")["preview"]
        # Gemini holds no role here, so the run has nothing unroutable; the
        # policy's reason for it is still the one that would be used.
        self.assertEqual(preview["unroutable"], [])
        decision = FDE.select_model(
            FDE.validate_routing_policy(json.loads(json.dumps(FAKE_POLICY))),
            json.loads((self.sb.shared / "config" / "agents.json").read_text()),
            agent_id="gemini", band="standard", floor="standard", strategy="balanced",
            limits=FAKE_POLICY["limits"]["standard"], purpose="research")
        self.assertFalse(decision["routable"])
        self.assertIsNone(decision["model"])
        self.assertIn("no model selection", decision["reason"])


# -- 5. durable, approval-bound decisions -----------------------------------

class TestDurableRouting(RoutingTest):
    def test_creation_recomputes_and_persists_the_authoritative_decision(self):
        """8. The controller decides; nothing upstream is trusted to have decided."""
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        doc = self.routing_doc(run_id)
        self.assertEqual(doc["mode"], "auto")
        self.assertEqual(doc["strategy"], "balanced")
        self.assertTrue(doc["decisionHash"].startswith("sha256:"))
        self.assertIsNone(doc["approvedAt"])
        self.assertEqual(doc["policyRevision"], "test-fixture-1")
        manifest = json.loads((self.sb.shared / "runs" / run_id / "manifest.json")
                              .read_text())
        self.assertEqual(manifest["routing"], {"mode": "auto", "strategy": "balanced"})
        # An unapproved proposal authorises nothing, including the orchestrator's
        # own session. `fde-start` reads sessionConfig on every resume, so
        # writing a proposal there would have moved the scoping conversation onto
        # a model nobody had agreed to.
        self.assertEqual(manifest["sessionConfig"]["model"], "default")
        self.assertEqual(manifest["sessionConfig"]["effort"], "auto")
        self.assertNotIn("source", manifest["sessionConfig"])

    def test_only_an_approved_route_reaches_the_orchestrator_session(self):
        """fde-start must never resume onto a model that was only proposed."""
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        path = self.sb.shared / "runs" / run_id / "manifest.json"
        self.assertEqual(json.loads(path.read_text())["sessionConfig"]["model"],
                         "default")
        self.approve(run_id)
        doc = self.routing_doc(run_id)
        manifest = json.loads(path.read_text())
        self.assertEqual(manifest["sessionConfig"]["model"],
                         doc["orchestrator"]["model"])
        self.assertEqual(manifest["sessionConfig"]["effort"],
                         doc["orchestrator"]["effort"])
        self.assertEqual(manifest["sessionConfig"]["source"], "routing")

    def test_start_auto_requires_an_orchestrator_and_refuses_manual_model(self):
        missing = self.sb.fde("start", STANDARD_REQUEST, "--routing", "auto")
        self.assertEqual(missing.returncode, 2)
        self.assertIn("--orchestrator", missing.stderr)
        both = self.sb.fde("start", STANDARD_REQUEST, "--orchestrator", "work",
                           "--routing", "auto", "--model", "mid")
        self.assertEqual(both.returncode, 2)
        self.assertIn("selects the model and effort", both.stderr)

    def test_the_proposal_follows_the_plan_and_the_roles(self):
        """A preview that describes last week's plan is worse than none."""
        run_id = self.routed_run(stages=("intake",), roles={})
        narrow = self.routing_doc(run_id)["decisionHash"]
        widened = self.sb.fde("plan", run_id, "--add", "solutioning")
        self.assertEqual(widened.returncode, 0, widened.stderr)
        doc = self.routing_doc(run_id)
        self.assertNotEqual(doc["decisionHash"], narrow)
        # Widening the plan added a role nobody holds yet, so the new stage is
        # reported as unscheduled rather than quietly assigned to whoever was
        # nearest. Assign it and the task appears.
        self.assertIn("solutioning", [entry["stage"] for entry in doc["notScheduled"]])
        assigned = self.sb.fde("roles", run_id, "--reassign",
                               "--set", "solutioning=claude_msc")
        self.assertEqual(assigned.returncode, 0, assigned.stderr)
        after = self.routing_doc(run_id)
        self.assertIn("solutioning", [task["stage"] for task in after["tasks"]])
        self.assertNotEqual(after["decisionHash"], doc["decisionHash"])

    def test_approval_freezes_the_displayed_decision(self):
        """9. The hash the operator saw is the hash the run is bound to."""
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        shown = self.routing_doc(run_id)["decisionHash"]
        result = self.approve(run_id)
        self.assertIn(shown, result.stdout)
        doc = self.routing_doc(run_id)
        self.assertEqual(doc["decisionHash"], shown)
        self.assertTrue(doc["approvedAt"])
        self.assertTrue(doc["approvedWithPlanHash"].startswith("sha256:"))
        self.assertEqual(doc["approvedBy"], os.environ.get("USER") or "unknown")

    def test_a_changed_decision_cannot_be_approved_under_a_stale_hash(self):
        """10. Change the inputs behind the approval and it refuses, with the revision."""
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        doc = self.routing_doc(run_id)
        doc["decisionHash"] = "sha256:" + "0" * 64
        (self.sb.shared / "runs" / run_id / "routing.json").write_text(
            json.dumps(doc, indent=2))
        result = self.sb.fde("approve-plan", run_id, stdin=f"APPROVE PLAN {run_id}\n")
        self.assertEqual(result.returncode, 5, result.stdout)
        self.assertIn("route changed since it was last shown", result.stdout)
        self.assertIn("not the one that was displayed", result.stderr)
        self.assertIsNone(self.routing_doc(run_id)["approvedAt"])
        plan = json.loads((self.sb.shared / "runs" / run_id / "plan.json").read_text())
        self.assertIsNone(plan.get("executionApprovedAt"))

    def test_the_policy_revision_is_recorded_with_the_decision(self):
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        self.approve(run_id)
        explain = self.sb.fde("routing", "explain", run_id, "--json")
        self.assertEqual(explain.returncode, 0, explain.stderr)
        payload = json.loads(explain.stdout)
        self.assertEqual(payload["policyRevision"], "test-fixture-1")
        self.assertIsNone(payload["policyDrift"])
        moved = json.loads(json.dumps(FAKE_POLICY))
        moved["policyRevision"] = "test-fixture-2"
        self.install_policy(moved)
        drifted = json.loads(self.sb.fde("routing", "explain", run_id, "--json").stdout)
        self.assertIn("policy revision", drifted["policyDrift"])

    def test_routing_events_are_append_only_and_use_the_documented_vocabulary(self):
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        self.approve(run_id)
        path = self.sb.shared / "runs" / run_id / "routing-events.jsonl"
        records = [json.loads(line) for line in path.read_text().splitlines() if line]
        kinds = [record["event"] for record in records]
        self.assertEqual(kinds[0], "routing.assessed")
        self.assertIn("routing.proposed", kinds)
        self.assertEqual(kinds[-1], "routing.approved")
        for kind in kinds:
            self.assertIn(kind, FDE.ROUTING_EVENT_KINDS)
        # The run's own timeline carries a bounded line for each, so "what did
        # this run decide" does not need a second log to answer.
        events = [json.loads(line) for line in
                  (self.sb.shared / "runs" / run_id / "events.jsonl")
                  .read_text().splitlines() if line]
        timeline = [event["event"] for event in events]
        self.assertIn("routing.approved", timeline)
        approved = next(e for e in events if e["event"] == "routing.approved")
        self.assertNotIn("dimensions", approved)

    def test_explain_returns_the_evidence_alternatives_and_refusals(self):
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        self.approve(run_id)
        payload = json.loads(self.sb.fde(
            "routing", "explain", run_id, "--task-id", "solutioning-1", "--json").stdout)
        self.assertEqual(payload["target"]["taskId"], "solutioning-1")
        self.assertTrue(payload["assessment"]["dimensions"])
        self.assertTrue(all(d["evidence"] for d in payload["assessment"]["dimensions"]))
        self.assertTrue(payload["rejected"])
        self.assertTrue(all("reason" in entry for entry in payload["rejected"]))
        self.assertTrue(payload["costUnitsAreEstimates"])

    def test_status_exposes_a_bounded_routing_summary(self):
        """Shape of the decision, not a dump of prompts or telemetry."""
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        self.approve(run_id)
        status = json.loads(self.sb.fde("status", run_id, "--json").stdout)
        routing = status["routing"]
        self.assertTrue(routing["present"])
        self.assertTrue(routing["approved"])
        self.assertTrue(routing["planHashMatches"])
        self.assertEqual(routing["policyRevision"], "test-fixture-1")
        self.assertTrue(routing["tasks"])
        for task in routing["tasks"]:
            self.assertNotIn("alternatives", task)
            self.assertNotIn("rejected", task)
        blob = json.dumps(routing)
        self.assertNotIn("requirement.md", blob)
        self.assertLess(len(blob), 20000, "the status summary is meant to be bounded")

    def test_missing_provider_usage_is_unavailable_never_zero(self):
        """18. No provider has reported anything, and the record says exactly that."""
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        self.approve(run_id)
        usage = json.loads(self.sb.fde("status", run_id, "--json").stdout)["routing"]["usage"]
        for field in ("inputTokens", "outputTokens", "cacheReadTokens",
                      "cacheWriteTokens", "totalTokens", "monetaryCost", "durationMs"):
            self.assertEqual(usage[field]["state"], "unavailable", field)
            self.assertIsNone(usage[field]["value"], field)
            self.assertTrue(usage[field]["reason"], field)
        # The one figure this engine can honestly produce is labelled as its own.
        self.assertEqual(usage["estimatedCostUnits"]["state"], "estimated")
        self.assertIn("not money", usage["estimatedCostUnits"]["source"])
        self.assertEqual(usage["attempts"]["value"], 0)


# -- 6. overrides ----------------------------------------------------------

class TestOverrides(RoutingTest):
    def approved_run(self):
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        self.approve(run_id)
        return run_id

    def test_an_override_below_the_floor_is_refused(self):
        run_id = self.approved_run()
        result = self.sb.fde("routing", "override", run_id, "--task-id", "solutioning-1",
                             "--model", "tiny", "--effort", "auto",
                             "--reason", "cheaper", "--json")
        self.assertEqual(result.returncode, 5)
        self.assertEqual(json.loads(result.stdout)["error"]["code"],
                         "routing-below-floor")

    def test_a_model_the_policy_does_not_offer_is_refused(self):
        run_id = self.approved_run()
        result = self.sb.fde("routing", "override", run_id, "--task-id", "solutioning-1",
                             "--model", "invented-model", "--effort", "high",
                             "--reason", "trying it", "--json")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["error"]["code"],
                         "routing-not-in-catalog")

    def test_raising_a_tier_needs_the_typed_approval(self):
        run_id = self.approved_run()
        refused = self.sb.fde("routing", "override", run_id, "--task-id", "solutioning-1",
                              "--model", "big", "--effort", "high",
                              "--reason", "needs the stronger model", stdin="yes\n")
        self.assertEqual(refused.returncode, 8)
        self.assertIn("confirmation did not match", refused.stderr)
        self.assertEqual(self.routing_doc(run_id)["overrides"], [])

    def test_an_override_records_who_when_what_and_why_without_losing_history(self):
        run_id = self.approved_run()
        before = self.routing_doc(run_id)["decisionHash"]
        first = self.sb.fde("routing", "override", run_id, "--task-id", "solutioning-1",
                            "--model", "big", "--effort", "high",
                            "--reason", "an auth design needs the stronger model",
                            "--approve", "--json")
        self.assertEqual(first.returncode, 0, first.stderr)
        second = self.sb.fde("routing", "override", run_id, "--task-id", "review-1",
                             "--model", "big", "--effort", "high",
                             "--reason", "the reviewer should match the producer",
                             "--approve", "--json")
        self.assertEqual(second.returncode, 0, second.stderr)
        doc = self.routing_doc(run_id)
        self.assertEqual(len(doc["overrides"]), 2)
        earliest = doc["overrides"][0]
        self.assertEqual(earliest["target"], "task:solutioning-1")
        self.assertEqual(earliest["field"], "model")
        self.assertEqual(earliest["from"], "mid")
        self.assertEqual(earliest["to"], "big")
        self.assertTrue(earliest["reason"])
        self.assertTrue(earliest["at"])
        self.assertTrue(earliest["operator"])
        self.assertEqual(earliest["previousDecisionHash"], before)
        self.assertTrue(earliest["escalation"])
        # The approval survives an override; the hash moves, the history does not.
        self.assertTrue(doc["approvedAt"])
        self.assertNotEqual(doc["decisionHash"], before)

    def test_an_approved_override_reaches_the_invocation(self):
        run_id = self.approved_run()
        self.sb.fde("routing", "override", run_id, "--task-id", "review-1",
                    "--model", "big", "--effort", "high", "--reason", "independent read",
                    "--approve", "--json")
        (self.sb.shared / "runs" / run_id / "tasks").mkdir(exist_ok=True)
        (self.sb.shared / "runs" / run_id / "tasks" / "review.md").write_text("review it")
        dry = self.sb.fde("invoke", run_id, "claude_alt", "tasks/review.md",
                          "--stage", "review", "--task-id", "review-1", "--dry-run")
        self.assertEqual(dry.returncode, 0, dry.stderr)
        payload = json.loads(dry.stdout)
        self.assertEqual(payload["argv"][:6],
                         ["claude", "--model", "big", "--effort", "high", "-p"])

    def test_the_orchestrator_route_can_be_overridden_too(self):
        run_id = self.approved_run()
        result = self.sb.fde("routing", "override", run_id, "--orchestrator",
                             "--model", "big", "--effort", "high",
                             "--reason", "the operator wants the stronger orchestrator",
                             "--approve", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        doc = self.routing_doc(run_id)
        self.assertEqual(doc["orchestrator"]["model"], "big")
        self.assertEqual(doc["overrides"][0]["target"], "orchestrator")
        # The orchestrator's session has to actually get the overridden model,
        # or the override is a record of an intention rather than a change.
        manifest = json.loads((self.sb.shared / "runs" / run_id / "manifest.json")
                              .read_text())
        self.assertEqual(manifest["sessionConfig"]["model"], "big")
        self.assertEqual(manifest["sessionConfig"]["effort"], "high")


# -- 7. critical work, and honest independence ------------------------------

class TestIndependentReview(RoutingTest):
    def test_critical_work_gets_an_independent_reviewer_when_one_exists(self):
        """15. A different account with its own authentication and its own context."""
        run_id = self.routed_run(
            requirement=CRITICAL_REQUEST,
            stages=("intake", "solutioning", "review", "reconciliation"),
            roles={"solutioning": "claude_msc", "review": "claude_alt",
                   "securityReview": "claude_bedrock"})
        doc = self.routing_doc(run_id)
        self.assertEqual(doc["assessment"]["band"], "critical")
        reviewers = [task for task in doc["tasks"] if task["independence"]]
        self.assertEqual(len(reviewers), 1)
        reviewer = reviewers[0]
        self.assertTrue(reviewer["independence"]["independent"])
        self.assertFalse(reviewer["independence"]["requiresDegradedApproval"])
        self.assertNotIn(reviewer["accountId"], reviewer["independence"]["of"])
        # The risk is authentication, so the security reviewer is the check —
        # not whichever review task happened to be listed first.
        self.assertEqual(reviewer["specialist"], "security-reviewer")
        self.assertEqual(reviewer["accountId"], "claude_bedrock")
        self.assertIn(reviewer["stage"], ("review", "verification"))
        # Its role really covers its stage, or it could never be invoked.
        self.assertIn(reviewer["stage"],
                      FDE.ROLE_STAGES[reviewer["requiredRole"]])

    def test_an_already_scheduled_distinct_account_is_the_independent_check(self):
        """No second agent is added to do a job something scheduled already does."""
        run_id = self.routed_run(
            requirement=CRITICAL_REQUEST,
            stages=("intake", "solutioning", "review", "reconciliation"),
            roles={"solutioning": "claude_msc", "review": "claude_alt",
                   "securityReview": "claude_bedrock"})
        doc = self.routing_doc(run_id)
        review_tasks = [task for task in doc["tasks"] if task["stage"] == "review"]
        self.assertEqual(len(review_tasks), 2, [t["taskId"] for t in review_tasks])
        marked = [task for task in review_tasks if task["independence"]]
        self.assertEqual(len(marked), 1)
        self.assertIn("independent check", marked[0]["specialistReason"])

    def test_degraded_independence_is_stated_not_papered_over(self):
        """15. One account cannot check itself, and the record says so."""
        run_id = self.routed_run(
            requirement=CRITICAL_REQUEST,
            stages=("intake", "solutioning", "review", "reconciliation"),
            roles={"solutioning": "claude_work", "review": "claude_work"})
        doc = self.routing_doc(run_id)
        reviewer = next(task for task in doc["tasks"] if task["independence"])
        self.assertFalse(reviewer["independence"]["independent"])
        self.assertTrue(reviewer["independence"]["requiresDegradedApproval"])
        self.assertIn("shares the producer's account",
                      reviewer["independence"]["reason"])
        self.assertTrue(any("degraded, not independent" in warning
                            for warning in doc["warnings"]))
        self.assertTrue(any("no independent check could be scheduled" in warning
                            for warning in doc["warnings"]))
        # A degraded check IS scheduled; what is missing is its independence, so
        # it is a caveat on a task and not an absent one.
        self.assertNotIn(("review", "review"),
                         [(entry.get("stage"), entry.get("role"))
                          for entry in doc["notScheduled"]])

    def test_no_duplicate_reviewer_is_manufactured_when_none_is_independent(self):
        """A twin of a task that already exists costs an agent and buys nothing."""
        run_id = self.routed_run(
            requirement=CRITICAL_REQUEST,
            stages=("intake", "solutioning", "review", "reconciliation"),
            roles={"solutioning": "claude_work", "review": "claude_work"})
        review_tasks = [task for task in self.routing_doc(run_id)["tasks"]
                        if task["stage"] == "review"]
        self.assertEqual(len(review_tasks), 1)

    def test_critical_work_with_nothing_that_checks_says_so(self):
        run_id = self.routed_run(
            requirement=CRITICAL_REQUEST, stages=("intake", "solutioning"),
            roles={"solutioning": "claude_msc"})
        doc = self.routing_doc(run_id)
        self.assertEqual(doc["assessment"]["band"], "critical")
        self.assertFalse([task for task in doc["tasks"] if task["independence"]])
        self.assertTrue(any("cannot carry an independent check" in warning
                            for warning in doc["warnings"]))

    def test_one_capable_producer_plus_a_reviewer_not_duplicate_attempts(self):
        """No two tasks share a stage, role and prompt without a stated reason."""
        run_id = self.routed_run(
            requirement=CRITICAL_REQUEST,
            stages=("intake", "solutioning", "review", "reconciliation"),
            roles={"solutioning": "claude_msc", "review": "claude_alt",
                   "securityReview": "claude_bedrock"})
        seen = {}
        for task in self.routing_doc(run_id)["tasks"]:
            key = (task["stage"], task["requiredRole"], task["accountId"])
            if key in seen:
                self.fail(f"duplicate agent for {key} with no independence reason")
            seen[key] = task
        for task in self.routing_doc(run_id)["tasks"]:
            self.assertTrue(task["specialistReason"], task["taskId"])
        # Exactly one task is the independent check, and it is not a twin of
        # anything else on its stage.
        marked = [task for task in self.routing_doc(run_id)["tasks"]
                  if task["independence"]]
        self.assertEqual(len(marked), 1)

    def test_three_accounts_existing_is_not_a_reason_to_use_three(self):
        run_id = self.routed_run(
            requirement=SIMPLE_REQUEST, stages=("intake",),
            roles={})
        doc = self.routing_doc(run_id)
        self.assertEqual(len(doc["tasks"]), 1)
        self.assertEqual(doc["specialistCount"], 0)
        self.assertEqual(doc["discretionaryCount"], 0)

    def test_a_specialist_beyond_the_band_cap_is_reported_not_dropped_silently(self):
        run_id = self.routed_run(
            requirement=CRITICAL_REQUEST,
            stages=("intake", "solutioning", "review"),
            roles={"solutioning": "claude_msc", "review": "claude_alt",
                   "securityReview": "claude_msc", "standardsReview": "claude_alt",
                   "prReview": "claude_work"})
        doc = self.routing_doc(run_id)
        review_tasks = [t for t in doc["tasks"] if t["stage"] == "review"]
        cap = FAKE_POLICY["limits"]["critical"]["maxSpecialistsPerStage"]
        self.assertLessEqual(len(review_tasks), cap + 1)
        self.assertTrue(doc["notScheduled"])
        for entry in doc["notScheduled"]:
            self.assertTrue(entry["reason"])


# -- 8. manual and legacy runs are untouched --------------------------------

class TestBackwardsCompatibility(RoutingTest):
    def test_manual_mode_remains_the_default_and_writes_no_routing_record(self):
        """16. What worked before routing existed still works, unchanged."""
        result = self.sb.fde("start", STANDARD_REQUEST, "--orchestrator", "work",
                             "--model", "sonnet", "--effort", "high")
        self.assertEqual(result.returncode, 0, result.stderr)
        run_id = next(line.split()[1] for line in result.stdout.splitlines()
                      if line.startswith("run "))
        self.assertFalse((self.sb.shared / "runs" / run_id / "routing.json").exists())
        manifest = json.loads((self.sb.shared / "runs" / run_id / "manifest.json")
                              .read_text())
        self.assertEqual(manifest["routing"]["mode"], "manual")
        self.assertEqual(manifest["sessionConfig"],
                         {"model": "sonnet", "effort": "high"})
        status = json.loads(self.sb.fde("status", run_id, "--json").stdout)
        self.assertIsNone(status["routing"])

    def test_a_legacy_run_without_routing_data_still_runs(self):
        """17. No routing.json is a complete answer, not a missing file."""
        run_id = self.sb.start(STANDARD_REQUEST, shape="research")
        # A run written before routing existed has no 'routing' key at all.
        manifest_path = self.sb.shared / "runs" / run_id / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest.pop("routing", None)
        manifest_path.write_text(json.dumps(manifest, indent=2))
        assigned = self.sb.fde("roles", run_id, "--set", "research=claude_work",
                               "--set", "productManagement=none",
                               "--set", "microsoftContext=none")
        self.assertEqual(assigned.returncode, 0, assigned.stderr)
        (self.sb.shared / "runs" / run_id / "tasks" / "research.md").write_text("go")
        dry = self.sb.fde("invoke", run_id, "claude_work", "tasks/research.md",
                          "--stage", "research", "--dry-run")
        self.assertEqual(dry.returncode, 0, dry.stderr)
        payload = json.loads(dry.stdout)
        self.assertEqual(payload["argv"][:2], ["claude", "-p"])
        self.assertEqual(payload["route"]["source"], "manual")
        status = json.loads(self.sb.fde("status", run_id, "--json").stdout)
        self.assertIsNone(status["routing"])
        show = self.sb.fde("routing", "show", run_id, "--json")
        self.assertEqual(show.returncode, 4)
        self.assertEqual(json.loads(show.stdout)["error"]["code"], "routing-absent")

    def test_task_id_on_a_manual_run_is_refused_rather_than_ignored(self):
        run_id = self.sb.start(STANDARD_REQUEST, shape="research")
        self.sb.fde("roles", run_id, "--set", "research=claude_work",
                    "--set", "productManagement=none", "--set", "microsoftContext=none")
        (self.sb.shared / "runs" / run_id / "tasks" / "research.md").write_text("go")
        result = self.sb.fde("invoke", run_id, "claude_work", "tasks/research.md",
                             "--stage", "research", "--task-id", "research-1",
                             "--dry-run")
        self.assertEqual(result.returncode, 2)
        self.assertIn("selects its model and effort manually", result.stderr)


# -- 9. the invocation carries exactly what was approved --------------------

class TestInvocation(RoutingTest):
    def approved_run(self, **kw):
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"}, **kw)
        self.approve(run_id)
        (self.sb.shared / "runs" / run_id / "tasks").mkdir(exist_ok=True)
        return run_id

    def test_the_exact_approved_model_and_effort_go_through_the_argument_array(self):
        """11. Separate argv elements, taken from the frozen decision."""
        run_id = self.approved_run()
        task = self.sb.shared / "runs" / run_id / "tasks" / "solutioning.md"
        task.write_text("propose the options")
        expected = next(t for t in self.routing_doc(run_id)["tasks"]
                        if t["taskId"] == "solutioning-1")
        dry = self.sb.fde("invoke", run_id, "claude_msc", "tasks/solutioning.md",
                          "--stage", "solutioning", "--task-id", "solutioning-1",
                          "--dry-run")
        self.assertEqual(dry.returncode, 0, dry.stderr)
        payload = json.loads(dry.stdout)
        self.assertEqual(payload["argv"], [
            "claude", "--model", expected["model"], "--effort", expected["effort"],
            "-p", "propose the options"])
        self.assertEqual(payload["route"]["taskId"], "solutioning-1")
        self.assertEqual(payload["route"]["source"], "approved-routing")
        self.assertEqual(payload["env"]["CLAUDE_PROFILE"], "msc")

    def test_bedrock_keeps_its_environment_handling_alongside_the_routed_model(self):
        run_id = self.routed_run(roles={"solutioning": "claude_bedrock",
                                        "review": "claude_alt"})
        self.approve(run_id)
        (self.sb.shared / "runs" / run_id / "tasks").mkdir(exist_ok=True)
        (self.sb.shared / "runs" / run_id / "tasks" / "s.md").write_text("go")
        dry = self.sb.fde("invoke", run_id, "claude_bedrock", "tasks/s.md",
                          "--stage", "solutioning", "--task-id", "solutioning-1",
                          "--dry-run")
        self.assertEqual(dry.returncode, 0, dry.stderr)
        payload = json.loads(dry.stdout)
        self.assertEqual(payload["env"]["CLAUDE_CODE_USE_BEDROCK"], "1")
        self.assertEqual(payload["env"]["CLAUDE_PROFILE"], "bedrock")
        self.assertIn("--model", payload["argv"])

    def test_task_text_beginning_with_a_dash_cannot_become_an_option(self):
        """12. The body is always the value of a preceding option."""
        run_id = self.approved_run()
        task = self.sb.shared / "runs" / run_id / "tasks" / "solutioning.md"
        task.write_text("--dangerously-bypass-approvals-and-sandbox\n--model evil\n")
        dry = self.sb.fde("invoke", run_id, "claude_msc", "tasks/solutioning.md",
                          "--stage", "solutioning", "--task-id", "solutioning-1",
                          "--dry-run")
        # The controller's own sandbox-bypass guard fires on the text; what
        # matters is that it never reached argv as an option.
        if dry.returncode == 0:
            argv = json.loads(dry.stdout)["argv"]
            self.assertEqual(argv[-2], "-p")
            self.assertTrue(argv[-1].startswith("--dangerously"))
            self.assertEqual(argv.count("--model"), 1)
            self.assertNotIn("evil", argv[:-1])
        else:
            self.assertEqual(dry.returncode, 8)
            self.assertIn("sandbox-bypass", dry.stderr)

    def test_an_unapproved_route_cannot_be_invoked(self):
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        (self.sb.shared / "runs" / run_id / "tasks" / "s.md").write_text("go")
        result = self.sb.fde("invoke", run_id, "claude_msc", "tasks/s.md",
                             "--stage", "solutioning", "--task-id", "solutioning-1",
                             "--dry-run")
        self.assertIn(result.returncode, (6, 7))
        self.assertTrue(result.stderr.strip())

    def test_a_task_id_for_another_stage_or_identity_is_refused(self):
        run_id = self.approved_run()
        (self.sb.shared / "runs" / run_id / "tasks" / "s.md").write_text("go")
        wrong_stage = self.sb.fde("invoke", run_id, "claude_work", "tasks/s.md",
                                  "--stage", "intake", "--task-id", "solutioning-1",
                                  "--dry-run")
        self.assertEqual(wrong_stage.returncode, 6)
        self.assertIn("belongs to the 'solutioning' stage", wrong_stage.stderr)

    def test_a_role_change_after_approval_refuses_the_frozen_route(self):
        """The freeze is bound to the plan and the assignment it was shown with."""
        run_id = self.approved_run()
        reassigned = self.sb.fde("roles", run_id, "--reassign",
                                 "--set", "solutioning=claude_alt")
        self.assertEqual(reassigned.returncode, 0, reassigned.stderr)
        (self.sb.shared / "runs" / run_id / "tasks" / "s.md").write_text("go")
        result = self.sb.fde("invoke", run_id, "claude_alt", "tasks/s.md",
                             "--stage", "solutioning", "--task-id", "solutioning-1",
                             "--dry-run")
        self.assertEqual(result.returncode, 7)
        self.assertIn("changed since its route was approved", result.stderr)
        status = json.loads(self.sb.fde("status", run_id, "--json").stdout)
        self.assertFalse(status["routing"]["planHashMatches"])
        self.assertTrue(any("re-approve" in warning for warning in status["warnings"]))

    def test_a_ceiling_is_recorded_for_every_routed_task(self):
        """14. Nothing runs without a bounded place for a retry to go."""
        run_id = self.approved_run()
        for task in self.routing_doc(run_id)["tasks"]:
            if not task["routable"]:
                continue
            ceiling = task["escalationCeiling"]
            self.assertIn(ceiling["tier"], FAKE_POLICY["tiers"])
            self.assertIn(ceiling["effort"], FAKE_POLICY["efforts"])
            self.assertLessEqual(
                FAKE_POLICY["tiers"][ceiling["tier"]],
                FAKE_POLICY["tiers"][
                    FAKE_POLICY["limits"][task["band"]]["maxAutomaticTier"]])
            self.assertGreaterEqual(ceiling["maxRetries"], 0)
            self.assertEqual(
                ceiling["requiresRecordedFailureAbove"],
                FAKE_POLICY["escalation"]["requireRecordedFailureAbove"])


# -- 10. things that were wrong once ---------------------------------------

class TestRoutingIntegrity(RoutingTest):
    """Each of these failed at some point during development. They stay."""

    def test_an_auto_run_is_always_approval_bound_even_without_the_flag(self):
        """The combined gate is what freezes the route, so it is not optional."""
        result = self.sb.fde("start", STANDARD_REQUEST, "--orchestrator", "work",
                             "--routing", "auto")
        self.assertEqual(result.returncode, 0, result.stderr)
        run_id = next(line.split()[1] for line in result.stdout.splitlines()
                      if line.startswith("run "))
        planned = self.sb.fde("plan", run_id, "--stages", "intake,solutioning")
        self.assertEqual(planned.returncode, 0, planned.stderr)
        plan = json.loads((self.sb.shared / "runs" / run_id / "plan.json").read_text())
        self.assertTrue(plan["approvalRequired"])
        self.assertIn("automatic routing requires the combined approval",
                      " ".join(plan["warnings"]))
        assigned = self.sb.fde("roles", run_id, "--set", "solutioning=claude_msc",
                               "--set", "uiUxDesign=none", "--set", "designSystem=none",
                               "--set", "productManagement=none",
                               "--set", "microsoftContext=none")
        self.assertEqual(assigned.returncode, 0, assigned.stderr)
        self.approve(run_id)
        self.assertTrue(self.routing_doc(run_id)["approvedAt"])
        (self.sb.shared / "runs" / run_id / "tasks" / "s.md").write_text("go")
        dry = self.sb.fde("invoke", run_id, "claude_msc", "tasks/s.md",
                          "--stage", "solutioning", "--task-id", "solutioning-1",
                          "--dry-run")
        self.assertEqual(dry.returncode, 0, dry.stderr)

    def test_a_broken_policy_refuses_run_creation_without_a_traceback(self):
        """Every command can reach the engine now, so every command refuses cleanly."""
        self.policy_path.write_text("{ not json", encoding="utf-8")
        result = self.sb.fde("start", STANDARD_REQUEST, "--orchestrator", "work",
                             "--routing", "auto")
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertNotIn("Traceback", result.stderr)
        self.assertIn("routing policy is not usable", result.stderr)
        as_json = self.sb.fde("start", STANDARD_REQUEST, "--orchestrator", "work",
                              "--routing", "auto", "--json")
        self.assertEqual(as_json.returncode, 2)
        self.assertEqual(json.loads(as_json.stdout)["error"]["code"],
                         "routing-policy-invalid")

    def test_the_per_stage_cap_counts_specialist_methods_not_tasks(self):
        """A required-role task with no separate method is not a specialist."""
        run_id = self.routed_run(
            requirement=STANDARD_REQUEST, stages=("intake", "research"),
            roles={"research": "claude_msc", "productManagement": "claude_alt",
                   "microsoftContext": "none"})
        doc = self.routing_doc(run_id)
        intake = [task for task in doc["tasks"] if task["stage"] == "intake"]
        self.assertEqual([task["specialist"] for task in intake if task["specialist"]],
                         ["product-analyst"],
                         "the standard band allows one specialist method per stage, and "
                         "the orchestrator's own methodless task is not one")

    def test_a_codex_orchestrator_does_not_have_its_model_written_for_the_claude_launcher(self):
        """sessionConfig is read by fde-start, which launches the Claude CLI."""
        result = self.sb.fde("start", STANDARD_REQUEST, "--orchestrator", "codex",
                             "--routing", "auto")
        self.assertEqual(result.returncode, 0, result.stderr)
        run_id = next(line.split()[1] for line in result.stdout.splitlines()
                      if line.startswith("run "))
        doc = self.routing_doc(run_id)
        self.assertEqual(doc["orchestrator"]["provider"], "codex")
        self.assertIn(doc["orchestrator"]["model"], ("cx-small", "cx-large"))
        manifest = json.loads((self.sb.shared / "runs" / run_id / "manifest.json")
                              .read_text())
        self.assertEqual(manifest["sessionConfig"]["model"], "default")
        self.assertEqual(manifest["sessionConfig"]["effort"], "auto")

    def test_trimming_for_budget_leaves_no_dangling_dependency(self):
        """Dependency ids are inside the hash an approval binds."""
        tight = json.loads(json.dumps(FAKE_POLICY))
        for band in tight["limits"].values():
            band["maxCostUnits"] = 60
        self.install_policy(tight)
        run_id = self.routed_run(
            requirement=CRITICAL_REQUEST,
            stages=("intake", "solutioning", "review", "verification"),
            roles={"solutioning": "claude_msc", "review": "claude_alt",
                   "securityReview": "claude_bedrock",
                   "standardsReview": "claude_alt", "testEngineering": "claude_msc",
                   "ciInvestigation": "claude_work"})
        doc = self.routing_doc(run_id)
        known = {task["taskId"] for task in doc["tasks"]}
        for task in doc["tasks"]:
            for dependency in task["dependsOn"]:
                self.assertIn(dependency, known,
                              f"{task['taskId']} depends on a task that was dropped")
        self.assertEqual(doc["discretionaryCount"],
                         sum(1 for task in doc["tasks"] if task["discretionary"]))

    def test_a_scheduled_reviewer_holds_a_role_that_covers_its_stage(self):
        """A task whose role does not cover its stage could never be invoked."""
        run_id = self.routed_run(
            requirement=CRITICAL_REQUEST,
            stages=("intake", "solutioning", "review", "verification"),
            roles={"solutioning": "claude_msc", "review": "claude_alt",
                   "testEngineering": "claude_bedrock"})
        for task in self.routing_doc(run_id)["tasks"]:
            self.assertIn(task["stage"], FDE.ROLE_STAGES[task["requiredRole"]],
                          f"{task['taskId']}: role '{task['requiredRole']}' does not "
                          f"cover stage '{task['stage']}'")

    def test_the_documented_task_file_option_parses(self):
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        self.approve(run_id)
        (self.sb.shared / "runs" / run_id / "tasks" / "s.md").write_text("go")
        dry = self.sb.fde("invoke", run_id, "claude_msc", "--task-file", "tasks/s.md",
                          "--stage", "solutioning", "--task-id", "solutioning-1",
                          "--dry-run")
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertEqual(json.loads(dry.stdout)["route"]["taskId"], "solutioning-1")
        both = self.sb.fde("invoke", run_id, "claude_msc", "tasks/s.md",
                           "--task-file", "tasks/s.md", "--stage", "solutioning",
                           "--task-id", "solutioning-1", "--dry-run")
        self.assertEqual(both.returncode, 2)
        self.assertIn("once, not both", both.stderr)

    def test_a_requirement_beginning_with_a_dash_is_text(self):
        result = self.sb.fde("routing", "preview", "-o", "work",
                             "--requirement=-rf everything in export.csv", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)["preview"]["assessment"]["dimensions"])

    def test_a_malformed_task_id_is_refused_as_malformed(self):
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        self.approve(run_id)
        (self.sb.shared / "runs" / run_id / "tasks" / "s.md").write_text("go")
        result = self.sb.fde("invoke", run_id, "claude_msc", "tasks/s.md",
                             "--stage", "solutioning", "--task-id", "../../etc/passwd",
                             "--dry-run")
        self.assertEqual(result.returncode, 2)
        self.assertIn("not a usable task id", result.stderr)

    def test_the_estimate_the_operator_approved_is_part_of_what_is_bound(self):
        """Re-weighting costs changes the number that was shown, so it re-approves."""
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        self.approve(run_id)
        dearer = json.loads(json.dumps(FAKE_POLICY))
        for model in dearer["providers"]["anthropic"]["models"]:
            model["costWeight"] = float(model["costWeight"]) * 3
        self.install_policy(dearer)
        recomputed = FDE.routing_decision_hash(
            dict(self.routing_doc(run_id), estimatedCostUnits=999.0))
        self.assertNotEqual(recomputed, self.routing_doc(run_id)["decisionHash"])


class TestIndependentReviewConsistency(RoutingTest):
    DESTRUCTIVE_REQUEST = (
        "ACME-702 Purge the archived order rows from the production warehouse and drop "
        "the legacy audit table. This cannot be undone once it runs.")

    def test_a_scheduled_check_is_not_also_reported_as_not_scheduled(self):
        """The approval screen must not contradict itself."""
        run_id = self.routed_run(
            requirement=self.DESTRUCTIVE_REQUEST,
            stages=("intake", "implementation", "verification"),
            roles={"implementation": "claude_msc", "testEngineering": "claude_work",
                   "securityReview": "claude_alt"})
        doc = self.routing_doc(run_id)
        self.assertEqual(doc["assessment"]["band"], "critical")
        scheduled = {(task["stage"], task["requiredRole"]) for task in doc["tasks"]}
        for entry in doc["notScheduled"]:
            self.assertNotIn((entry.get("stage"), entry.get("role")), scheduled,
                             f"{entry} is reported as unscheduled and also scheduled")

    def test_the_mandated_check_agrees_with_itself(self):
        """Its role, its method and its flags describe the same thing."""
        run_id = self.routed_run(
            requirement=self.DESTRUCTIVE_REQUEST,
            stages=("intake", "implementation", "verification"),
            roles={"implementation": "claude_msc", "testEngineering": "claude_work",
                   "securityReview": "claude_alt"})
        doc = self.routing_doc(run_id)
        reviewer = next(task for task in doc["tasks"] if task["independence"])
        self.assertTrue(reviewer["independence"]["independent"])
        self.assertEqual(reviewer["requiredRole"], "securityReview")
        self.assertEqual(reviewer["specialist"],
                         FAKE_POLICY["specialists"]["securityReview"])
        self.assertIn(reviewer["stage"], FDE.ROLE_STAGES[reviewer["requiredRole"]])
        self.assertFalse(reviewer["discretionary"],
                         "the check a critical band mandates is not discretionary")
        self.assertEqual(doc["discretionaryCount"],
                         sum(1 for task in doc["tasks"] if task["discretionary"]))

    def test_only_roles_that_can_hold_a_check_are_considered(self):
        for role in FDE.ROUTING_REVIEW_ROLE_PREFERENCE:
            self.assertTrue(
                set(FDE.ROUTING_REVIEW_STAGE_PREFERENCE) & FDE.ROLE_STAGES.get(role, set()),
                f"'{role}' covers no stage that checks anything")


class TestReapproval(RoutingTest):
    """A plan or assignment that moves after approval must have a way back.

    Without one the frozen route refuses every invocation for the rest of the
    run's life, which is a worse failure than the one it protects against. The
    two cases differ: amending the plan un-approves it, so it reaches the normal
    combined gate; reassigning a role does not, so it needs an explicit
    re-approval.
    """

    def approved_run(self):
        run_id = self.routed_run(roles={"solutioning": "claude_msc",
                                        "review": "claude_alt"})
        self.approve(run_id)
        (self.sb.shared / "runs" / run_id / "tasks").mkdir(exist_ok=True)
        return run_id

    def reassign(self, run_id, **roles):
        args = []
        for role, identity in roles.items():
            args += ["--set", f"{role}={identity}"]
        result = self.sb.fde("roles", run_id, "--reassign", *args)
        self.assertEqual(result.returncode, 0, result.stderr)

    # -- a role reassignment leaves the plan approved and the route stale ----

    def test_a_stale_route_refuses_invocation_and_names_the_way_out(self):
        run_id = self.approved_run()
        self.reassign(run_id, review="claude_bedrock")
        (self.sb.shared / "runs" / run_id / "tasks" / "s.md").write_text("go")
        result = self.sb.fde("invoke", run_id, "claude_msc", "tasks/s.md",
                             "--stage", "solutioning", "--task-id", "solutioning-1",
                             "--dry-run")
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertIn("--reapprove", result.stderr)
        status = json.loads(self.sb.fde("status", run_id, "--json").stdout)
        self.assertFalse(status["routing"]["planHashMatches"])
        self.assertIn("--reapprove", status["nextAction"])
        self.assertTrue(any("--reapprove" in warning for warning in status["warnings"]))

    def test_a_stale_route_is_not_reapproved_implicitly(self):
        run_id = self.approved_run()
        self.reassign(run_id, review="claude_bedrock")
        plain = self.sb.fde("approve-plan", run_id, stdin=f"APPROVE PLAN {run_id}\n")
        self.assertEqual(plain.returncode, 5, plain.stdout)
        self.assertIn("--reapprove", plain.stderr)
        self.assertEqual(
            next(task["accountId"] for task in self.routing_doc(run_id)["tasks"]
                 if task["taskId"] == "review-1"), "claude_alt",
            "nothing was re-frozen without the explicit flag")

    def test_reapproval_supersedes_the_old_route_without_losing_it(self):
        run_id = self.approved_run()
        first = self.routing_doc(run_id)
        self.reassign(run_id, review="claude_bedrock")
        result = self.sb.fde("approve-plan", run_id, "--reapprove",
                             stdin=f"APPROVE PLAN {run_id}\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("superseded", result.stdout)
        doc = self.routing_doc(run_id)
        self.assertTrue(doc["approvedAt"])
        self.assertNotEqual(doc["approvedWithPlanHash"], first["approvedWithPlanHash"])
        self.assertEqual(
            next(task["accountId"] for task in doc["tasks"]
                 if task["taskId"] == "review-1"), "claude_bedrock")
        # The superseded approval is still on the record, and so is why.
        self.assertEqual(len(doc["supersededApprovals"]), 1)
        superseded = doc["supersededApprovals"][0]
        self.assertEqual(superseded["decisionHash"], first["decisionHash"])
        self.assertEqual(superseded["approvedWithPlanHash"],
                         first["approvedWithPlanHash"])
        self.assertEqual(superseded["approvedAt"], first["approvedAt"])
        self.assertTrue(superseded["supersededAt"])
        self.assertIn("changed after its route was approved", superseded["reason"])

    def test_the_reapproved_route_is_the_one_that_gets_invoked(self):
        run_id = self.approved_run()
        self.reassign(run_id, review="claude_bedrock")
        self.sb.fde("approve-plan", run_id, "--reapprove",
                    stdin=f"APPROVE PLAN {run_id}\n")
        (self.sb.shared / "runs" / run_id / "tasks" / "r.md").write_text("review it")
        stale_identity = self.sb.fde("invoke", run_id, "claude_alt", "tasks/r.md",
                                     "--stage", "review", "--task-id", "review-1",
                                     "--dry-run")
        self.assertEqual(stale_identity.returncode, 6)
        current = self.sb.fde("invoke", run_id, "claude_bedrock", "tasks/r.md",
                              "--stage", "review", "--task-id", "review-1",
                              "--dry-run")
        self.assertEqual(current.returncode, 0, current.stderr)

    def test_reapproving_an_unchanged_route_is_refused(self):
        run_id = self.approved_run()
        result = self.sb.fde("approve-plan", run_id, "--reapprove",
                             stdin=f"APPROVE PLAN {run_id}\n")
        self.assertEqual(result.returncode, 5)
        self.assertIn("nothing to re-approve", result.stderr)

    # -- amending the plan un-approves it, so the normal gate covers it ------

    def test_amending_the_plan_returns_the_run_to_the_normal_gate(self):
        run_id = self.approved_run()
        first = self.routing_doc(run_id)
        widened = self.sb.fde("plan", run_id, "--add", "presentation")
        self.assertEqual(widened.returncode, 0, widened.stderr)
        plan = json.loads((self.sb.shared / "runs" / run_id / "plan.json").read_text())
        self.assertIsNone(plan.get("executionApprovedAt"))
        assigned = self.sb.fde("roles", run_id, "--set", "presentation=claude_alt")
        self.assertEqual(assigned.returncode, 0, assigned.stderr)
        result = self.sb.fde("approve-plan", run_id, stdin=f"APPROVE PLAN {run_id}\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        doc = self.routing_doc(run_id)
        self.assertTrue(doc["approvedAt"])
        self.assertIn("presentation", [task["stage"] for task in doc["tasks"]])
        self.assertEqual(len(doc["supersededApprovals"]), 1)
        self.assertEqual(doc["supersededApprovals"][0]["decisionHash"],
                         first["decisionHash"])
        (self.sb.shared / "runs" / run_id / "tasks" / "p.md").write_text("build it")
        added = self.sb.fde("invoke", run_id, "claude_alt", "tasks/p.md",
                            "--stage", "presentation", "--task-id", "presentation-1",
                            "--dry-run")
        self.assertEqual(added.returncode, 0, added.stderr)

    def test_amending_the_plan_says_the_route_needs_reapproving(self):
        run_id = self.approved_run()
        widened = self.sb.fde("plan", run_id, "--add", "presentation")
        self.assertIn("--reapprove", widened.stdout)


class TestDecisionHashBinding(unittest.TestCase):
    def test_degraded_independence_does_not_hash_like_an_unevaluated_task(self):
        """A route whose only check is degraded is a different decision."""
        base = {
            "policyRevision": "test-fixture-1", "mode": "auto", "strategy": "balanced",
            "assessment": {"score": 9, "band": "critical", "confidence": "high",
                           "qualityFloor": "critical", "riskFlags": []},
            "orchestrator": {"accountId": "claude_work", "model": "big",
                             "effort": "high", "tier": "premium",
                             "qualityFloor": "critical"},
            "limits": FAKE_POLICY["limits"]["critical"],
            "estimatedCostUnits": 100.0,
            "tasks": [{"taskId": "review-1", "stage": "review", "requiredRole": "review",
                       "specialist": "reviewer", "accountId": "claude_work",
                       "model": "big", "effort": "high", "tier": "premium",
                       "qualityFloor": "critical", "parallelizable": False,
                       "dependsOn": [], "escalationCeiling": {
                           "tier": "premium", "effort": "xhigh", "maxRetries": 2},
                       "independence": None}],
        }
        unevaluated = FDE.routing_decision_hash(base)
        degraded = json.loads(json.dumps(base))
        degraded["tasks"][0]["independence"] = {
            "independent": False, "requiresDegradedApproval": True}
        independent = json.loads(json.dumps(base))
        independent["tasks"][0]["independence"] = {
            "independent": True, "requiresDegradedApproval": False}
        hashes = {unevaluated, FDE.routing_decision_hash(degraded),
                  FDE.routing_decision_hash(independent)}
        self.assertEqual(len(hashes), 3)

    def test_the_estimate_is_bound(self):
        base = {"policyRevision": "r", "mode": "auto", "strategy": "balanced",
                "assessment": {}, "orchestrator": {}, "limits": {}, "tasks": [],
                "estimatedCostUnits": 10.0}
        dearer = dict(base, estimatedCostUnits=30.0)
        self.assertNotEqual(FDE.routing_decision_hash(base),
                            FDE.routing_decision_hash(dearer))


class TestEscalationCeilingCounting(unittest.TestCase):
    def test_rungs_above_counts_rungs_strictly_above_this_decision(self):
        policy = FDE.validate_routing_policy(json.loads(json.dumps(FAKE_POLICY)))
        off_ladder = FDE.escalation_ceiling(
            policy, tier="standard", effort="auto",
            limits=policy["limits"]["standard"])
        # standard/medium and standard/high are both strictly above, and the
        # starting point is not itself a rung.
        self.assertEqual(off_ladder["rungsAbove"], 2)
        on_ladder = FDE.escalation_ceiling(
            policy, tier="standard", effort="medium",
            limits=policy["limits"]["standard"])
        self.assertEqual(on_ladder["rungsAbove"], 1)
        at_the_top = FDE.escalation_ceiling(
            policy, tier="standard", effort="high",
            limits=policy["limits"]["standard"])
        self.assertEqual(at_the_top["rungsAbove"], 0)


# -- 11. attempts, retries and escalation ----------------------------------

class AttemptTest(RoutingTest):
    """Shared setup for the attempt ledger. No tests of its own."""

    # A `claude` that fails on demand, so the ladder is exercised without a
    # provider and without a network.
    STUB_CLAUDE = (
        "#!/usr/bin/env bash\n"
        "echo 'stub claude' >&2\n"
        "exit ${CLAUDE_STUB_EXIT:-1}\n")

    def setUp(self):
        super().setUp()
        stub = self.sb.bindir / "claude"
        stub.write_text(self.STUB_CLAUDE)
        stub.chmod(0o755)

    def approved(self, requirement=CRITICAL_REQUEST,
                 stages=("intake", "solutioning", "review"),
                 roles=None, **envkw):
        roles = roles if roles is not None else {"solutioning": "claude_msc",
                                                 "review": "claude_alt"}
        run_id = self.routed_run(requirement=requirement, stages=stages, roles=roles)
        self.approve(run_id)
        (self.sb.shared / "runs" / run_id / "tasks").mkdir(exist_ok=True)
        (self.sb.shared / "runs" / run_id / "tasks" / "s.md").write_text("do the thing")
        return run_id

    def attempt(self, run_id, task_id="solutioning-1", account="claude_msc",
                stage="solutioning", **envkw):
        return self.sb.fde("invoke", run_id, account, "tasks/s.md", "--stage", stage,
                           "--task-id", task_id, **envkw)

    def outcome(self, run_id, task_id="solutioning-1", status="fail",
                classification=None, extra=()):
        args = ["routing", "outcome", run_id, "--task-id", task_id,
                "--status", status, "--json", *extra]
        if classification:
            args += ["--classification", classification]
        return self.sb.fde(*args)

    def ledger(self, run_id):
        path = self.sb.shared / "runs" / run_id / "routing-attempts.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines() if line]

    # -- what counts as a reason to spend the budget again ------------------


class TestAttempts(AttemptTest):
    """Retries are bounded and evidence-driven, or they do not happen."""

    def test_a_disliked_answer_is_not_a_reason_to_retry(self):
        """14. The classification list has no entry for 'not what I wanted'."""
        run_id = self.approved()
        self.assertEqual(self.attempt(run_id).returncode, 1)
        blocked = self.attempt(run_id)
        self.assertEqual(blocked.returncode, 5)
        self.assertIn("a disliked answer is not a reason", blocked.stderr)
        self.assertIn("change the task or the plan", blocked.stderr)
        for permitted in ("transient-provider", "invalid-contract",
                          "failed-validation", "failed-checkpoint"):
            self.assertIn(permitted, blocked.stderr)

    def test_an_unrecognised_classification_is_refused(self):
        run_id = self.approved()
        self.attempt(run_id)
        result = self.sb.fde("routing", "outcome", run_id, "--task-id", "solutioning-1",
                             "--status", "fail", "--classification", "i-disliked-it",
                             "--json")
        self.assertEqual(result.returncode, 2)

    def test_a_passing_attempt_is_not_run_again(self):
        run_id = self.approved()
        self.attempt(run_id)
        self.assertEqual(self.outcome(run_id, status="pass").returncode, 0)
        again = self.attempt(run_id)
        self.assertEqual(again.returncode, 5)
        self.assertIn("already has a passing attempt", again.stderr)

    def test_an_unjudged_attempt_cannot_be_retried(self):
        run_id = self.approved()
        self.attempt(run_id, task_id="review-1", account="claude_alt", stage="review",
                     CLAUDE_STUB_EXIT="0")
        blocked = self.attempt(run_id, task_id="review-1", account="claude_alt",
                               stage="review", CLAUDE_STUB_EXIT="0")
        self.assertEqual(blocked.returncode, 5)
        self.assertIn("no recorded outcome", blocked.stderr)

    # -- the ladder ---------------------------------------------------------

    def test_one_same_tier_retry_for_a_transient_provider_failure(self):
        run_id = self.approved()
        self.attempt(run_id)
        first = json.loads(self.outcome(
            run_id, classification="transient-provider").stdout)
        self.assertTrue(first["retryPermitted"])
        self.assertEqual(first["nextAttempt"]["mode"], "retry")
        self.assertEqual(first["nextAttempt"]["model"],
                         first["nextAttempt"]["previous"]["model"])
        self.assertEqual(self.attempt(run_id).returncode, 1)
        attempts = [a for a in self.ledger(run_id) if a["taskId"] == "solutioning-1"]
        self.assertEqual([a["attempt"] for a in attempts if "supersedes" not in a],
                         [1, 2])
        self.assertEqual({a["model"] for a in attempts}, {"big"})

    def test_a_contract_failure_escalates_one_rung_of_the_frozen_ladder(self):
        run_id = self.approved()
        self.attempt(run_id)
        answer = json.loads(self.outcome(
            run_id, classification="invalid-contract").stdout)
        self.assertTrue(answer["retryPermitted"])
        nxt = answer["nextAttempt"]
        self.assertEqual(nxt["mode"], "escalation")
        self.assertGreater(
            FAKE_POLICY["efforts"].index(nxt["effort"]),
            FAKE_POLICY["efforts"].index(nxt["previous"]["effort"]))
        self.assertIn("recorded as failed", nxt["reason"])
        self.attempt(run_id)
        escalated = [a for a in self.ledger(run_id)
                     if a["taskId"] == "solutioning-1" and a["attempt"] == 2]
        self.assertEqual(escalated[0]["mode"], "escalation")
        events = [json.loads(line) for line in
                  (self.sb.shared / "runs" / run_id / "routing-events.jsonl")
                  .read_text().splitlines() if line]
        climbed = [e for e in events if e["event"] == "routing.escalated"]
        self.assertEqual(len(climbed), 1)
        self.assertEqual(climbed[0]["to"], f"{nxt['tier']}/{nxt['effort']}")

    def test_escalation_stops_at_the_approved_ceiling(self):
        """14. The ceiling is a bound, not a suggestion."""
        run_id = self.approved()
        ceiling = next(task["escalationCeiling"] for task in
                       self.routing_doc(run_id)["tasks"]
                       if task["taskId"] == "solutioning-1")
        for _ in range(6):
            if self.attempt(run_id).returncode not in (0, 1):
                break
            answer = json.loads(self.outcome(
                run_id, classification="invalid-contract").stdout)
            if not answer.get("retryPermitted"):
                break
        refusal = self.attempt(run_id)
        self.assertIn(refusal.returncode, (5, 9))
        self.assertTrue(refusal.stderr.strip())
        used = [a for a in self.ledger(run_id)
                if a["taskId"] == "solutioning-1" and "supersedes" not in a]
        for record in used:
            self.assertLessEqual(
                FAKE_POLICY["tiers"][record["tier"]],
                FAKE_POLICY["tiers"][ceiling["tier"]])
            self.assertLessEqual(
                FAKE_POLICY["efforts"].index(record["effort"]),
                FAKE_POLICY["efforts"].index(ceiling["effort"]))
        self.assertLessEqual(len(used), 1 + ceiling["maxRetries"])

    def test_the_retry_count_ceiling_holds(self):
        run_id = self.approved(requirement=STANDARD_REQUEST,
                               stages=("intake", "solutioning"),
                               roles={"solutioning": "claude_msc"})
        allowed = self.routing_doc(run_id)["limits"]["maxRetries"]
        attempts = 0
        while True:
            result = self.attempt(run_id)
            if result.returncode not in (0, 1):
                self.assertEqual(result.returncode, 9, result.stderr)
                self.assertIn("approved retry attempt", result.stderr)
                break
            attempts += 1
            self.assertLessEqual(attempts, allowed + 1)
            self.outcome(run_id, classification="transient-provider")
        self.assertEqual(attempts, allowed + 1)
        events = [json.loads(line) for line in
                  (self.sb.shared / "runs" / run_id / "routing-events.jsonl")
                  .read_text().splitlines() if line]
        exhausted = [e for e in events if e["event"] == "routing.budget_exhausted"]
        self.assertTrue(exhausted)
        self.assertEqual(exhausted[-1]["limit"], "maxRetries")

    def test_the_cost_ceiling_pauses_instead_of_continuing(self):
        tight = json.loads(json.dumps(FAKE_POLICY))
        for band in tight["limits"].values():
            band["maxCostUnits"] = 25
            band["maxRetries"] = 5
        self.install_policy(tight)
        run_id = self.approved(requirement=STANDARD_REQUEST,
                               stages=("intake", "solutioning"),
                               roles={"solutioning": "claude_msc"})
        cap = self.routing_doc(run_id)["limits"]["maxCostUnits"]
        while True:
            result = self.attempt(run_id)
            if result.returncode not in (0, 1):
                break
            self.outcome(run_id, classification="transient-provider")
        self.assertEqual(result.returncode, 9, result.stderr)
        self.assertIn("approved", result.stderr)
        spent = json.loads(self.sb.fde("routing", "attempts", run_id, "--json").stdout)
        self.assertLessEqual(spent["spentCostUnits"], cap)
        events = [json.loads(line) for line in
                  (self.sb.shared / "runs" / run_id / "routing-events.jsonl")
                  .read_text().splitlines() if line]
        self.assertTrue(any(e["event"] == "routing.budget_exhausted"
                            and e.get("limit") == "maxCostUnits" for e in events))

    def test_a_dry_run_reserves_nothing(self):
        run_id = self.approved()
        path = self.sb.shared / "runs" / run_id / "routing-attempts.jsonl"
        self.assertFalse(path.exists())
        dry = self.sb.fde("invoke", run_id, "claude_msc", "tasks/s.md",
                          "--stage", "solutioning", "--task-id", "solutioning-1",
                          "--dry-run")
        self.assertEqual(dry.returncode, 0, dry.stderr)
        self.assertEqual(json.loads(dry.stdout)["route"]["attempt"], 1)
        self.assertFalse(path.exists(),
                         "answering 'what would this do' must not spend an attempt")

    # -- every failed attempt survives -------------------------------------

    def test_every_attempt_keeps_its_own_artifact_and_ledger_line(self):
        run_id = self.approved()
        self.attempt(run_id)
        self.outcome(run_id, classification="invalid-contract")
        self.attempt(run_id)
        artifacts = sorted(
            path.name for path in
            (self.sb.shared / "runs" / run_id / "artifacts" / "architecture").iterdir()
            if path.is_file())
        self.assertEqual(len(artifacts), 2, artifacts)
        self.assertTrue(any("-a1-" in name for name in artifacts))
        self.assertTrue(any("-a2-" in name for name in artifacts))
        lines = self.ledger(run_id)
        self.assertGreaterEqual(len(lines), 3)
        # Recording an outcome appends; it never edits the line it describes.
        first_written = [line for line in lines
                         if line["attempt"] == 1 and "supersedes" not in line]
        self.assertEqual(len(first_written), 1)
        self.assertIsNone(first_written[0]["classification"])
        judged = [line for line in lines if line.get("supersedes")]
        self.assertEqual(judged[0]["supersedes"]["attempt"], 1)
        self.assertEqual(judged[0]["classification"], "invalid-contract")

    def test_recording_an_outcome_does_not_consume_a_retry(self):
        run_id = self.approved()
        self.attempt(run_id)
        for _ in range(3):
            self.outcome(run_id, classification="transient-provider")
        progress = json.loads(self.sb.fde(
            "routing", "attempts", run_id, "--task-id", "solutioning-1",
            "--json").stdout)["progress"][0]
        self.assertEqual(progress["attempts"], 1)
        self.assertEqual(progress["retries"], 0)


# -- 12. usage telemetry ---------------------------------------------------

class TestUsageTelemetry(AttemptTest):
    def test_duration_is_reported_and_tokens_are_unavailable(self):
        run_id = self.approved()
        self.attempt(run_id)
        record = [line for line in self.ledger(run_id)
                  if line["attempt"] == 1 and "supersedes" not in line][0]
        usage = record["usage"]
        self.assertEqual(usage["durationMs"]["state"], "reported")
        self.assertIsInstance(usage["durationMs"]["value"], int)
        for field in ("inputTokens", "outputTokens", "totalTokens", "monetaryCost"):
            self.assertEqual(usage[field]["state"], "unavailable", field)
            self.assertIsNone(usage[field]["value"], field)
            self.assertTrue(usage[field]["reason"], field)

    def test_reported_usage_is_taken_from_a_provider_and_only_the_allowed_fields(self):
        run_id = self.approved()
        self.attempt(run_id)
        report = self.sb.tmp / "usage.json"
        report.write_text(json.dumps({
            "inputTokens": 1200, "outputTokens": 340, "totalTokens": 1540,
            "monetaryCost": 0.0412, "currency": "usd",
            # None of the following may ever be stored.
            "prompt": "the entire task text",
            "apiKey": "sk-should-never-be-stored",
            "completion": "the model's answer",
        }))
        answer = json.loads(self.outcome(
            run_id, status="pass", extra=("--usage-file", str(report))).stdout)
        usage = answer["usage"]
        self.assertEqual(usage["inputTokens"], {"state": "reported", "value": 1200,
                                                "source": "provider report"})
        self.assertEqual(usage["monetaryCost"]["state"], "reported")
        self.assertEqual(usage["currency"]["value"], "USD")
        blob = json.dumps(self.ledger(run_id))
        # The values never land anywhere. The rejected field NAMES are named in a
        # diagnostic note on purpose, so an integration sending them can be
        # fixed rather than silently ignored.
        for secret in ("the entire task text", "sk-should-never-be-stored",
                       "the model's answer"):
            self.assertNotIn(secret, blob)
        self.assertTrue(any("outside the usage allowlist" in note
                            for note in answer["notes"]))

    def test_a_fabricated_or_unusable_measurement_is_ignored_not_stored(self):
        run_id = self.approved()
        self.attempt(run_id)
        report = self.sb.tmp / "usage.json"
        report.write_text(json.dumps({"inputTokens": -5, "outputTokens": "many",
                                      "totalTokens": True, "currency": "dollars"}))
        answer = json.loads(self.outcome(
            run_id, status="pass", extra=("--usage-file", str(report))).stdout)
        for field in ("inputTokens", "outputTokens", "totalTokens", "currency"):
            self.assertEqual(answer["usage"][field]["state"], "unavailable", field)
        self.assertGreaterEqual(len(answer["notes"]), 3)

    def test_a_total_is_only_reported_when_every_attempt_reported_it(self):
        """One missing measurement makes the total unknown, and it says so."""
        run_id = self.approved()
        self.attempt(run_id)
        report = self.sb.tmp / "usage.json"
        report.write_text(json.dumps({"inputTokens": 100}))
        self.outcome(run_id, classification="invalid-contract",
                     extra=("--usage-file", str(report)))
        self.attempt(run_id)          # second attempt reports nothing
        rollup = json.loads(self.sb.fde(
            "routing", "attempts", run_id, "--json").stdout)["usage"]
        self.assertEqual(rollup["inputTokens"]["state"], "unavailable")
        self.assertIn("would be a guess", rollup["inputTokens"]["reason"])
        self.assertEqual(rollup["attempts"]["value"], 2)
        self.assertEqual(rollup["escalations"]["value"], 1)
        self.assertEqual(rollup["estimatedCostUnits"]["state"], "estimated")

    def test_a_total_is_reported_when_all_of_them_did(self):
        run_id = self.approved()
        report = self.sb.tmp / "usage.json"
        for classification in ("invalid-contract", None):
            self.attempt(run_id)
            report.write_text(json.dumps({"inputTokens": 100, "durationMs": 2000}))
            if classification:
                self.outcome(run_id, classification=classification,
                             extra=("--usage-file", str(report)))
            else:
                self.outcome(run_id, status="pass",
                             extra=("--usage-file", str(report)))
        rollup = json.loads(self.sb.fde(
            "routing", "attempts", run_id, "--json").stdout)["usage"]
        self.assertEqual(rollup["inputTokens"]["state"], "reported")
        self.assertEqual(rollup["inputTokens"]["value"], 200)

    def test_status_carries_spend_and_per_field_provenance(self):
        run_id = self.approved()
        self.attempt(run_id)
        self.outcome(run_id, classification="transient-provider")
        status = json.loads(self.sb.fde("status", run_id, "--json").stdout)["routing"]
        self.assertGreater(status["spentCostUnits"], 0)
        self.assertLessEqual(status["spentCostUnits"],
                             status["limits"]["maxCostUnits"])
        self.assertEqual(status["usage"]["attempts"]["value"], 1)
        self.assertEqual(status["usage"]["inputTokens"]["state"], "unavailable")
        task = next(entry for entry in status["tasks"]
                    if entry["taskId"] == "solutioning-1")
        self.assertEqual(task["progress"]["attempts"], 1)
        self.assertEqual(task["progress"]["lastClassification"], "transient-provider")
        blob = json.dumps(status)
        self.assertNotIn("do the thing", blob, "no prompt text in a status summary")


# -- 13. design panels keep their guarantees ------------------------------

class TestDesignPanelRouting(RoutingTest):
    """20. Auto routing may set a model and an effort. Nothing else."""

    BRIEF = ("Redesign the returns self-service flow so a customer can start, track and "
             "cancel a return without calling support. It must work at 360px and meet "
             "WCAG AA.")

    def panel_run(self):
        run_id = self.routed_run(
            requirement=self.BRIEF,
            stages=("intake", "solutioning", "review", "reconciliation",
                    "presentation"),
            roles={"uiUxDesign": "claude_work,claude_msc,claude_alt",
                   "solutioning": "claude_msc", "review": "claude_alt",
                   "presentation": "claude_work"})
        self.approve(run_id)
        return run_id

    def create(self, run_id, *extra, expect=0):
        result = self.sb.fde(
            "design-panel", "create", run_id, "--replace", "--brief", self.BRIEF,
            "--participant", "claude_work:flow", "--participant", "claude_msc:visual",
            "--participant", "claude_alt:system", *extra, "--json")
        self.assertEqual(result.returncode, expect,
                         f"stdout={result.stdout}\\nstderr={result.stderr}")
        return result

    def panel(self, run_id):
        status = json.loads(self.sb.fde("status", run_id, "--json").stdout)
        return status["designPanel"]

    def test_manual_panels_are_unchanged(self):
        run_id = self.panel_run()
        self.create(run_id)
        panel = self.panel(run_id)
        self.assertIsNone(panel["routing"])
        for participant in panel["participants"]:
            self.assertEqual(participant["model"], "default")
            self.assertEqual(participant["effort"], "auto")
            self.assertEqual(participant["routingSource"], "operator")

    def test_auto_fills_in_a_concrete_model_and_effort_for_each_lens(self):
        run_id = self.panel_run()
        self.create(run_id, "--routing", "auto")
        panel = self.panel(run_id)
        self.assertEqual(panel["routing"]["mode"], "auto")
        self.assertEqual(panel["routing"]["policyRevision"], "test-fixture-1")
        # A panel works the solutioning stage, so it inherits that floor.
        self.assertEqual(panel["routing"]["qualityFloor"], "high")
        self.assertIn(panel["routing"]["band"], ("complex", "critical"))
        self.assertTrue(panel["routing"]["costUnitsAreEstimates"])
        offered = {model["id"]: model["efforts"] for model in
                   FAKE_POLICY["providers"]["anthropic"]["models"]}
        for participant in panel["participants"]:
            self.assertEqual(participant["routingSource"], "auto")
            self.assertNotEqual(participant["model"], "default")
            self.assertIn(participant["model"], offered)
            self.assertIn(participant["effort"], offered[participant["model"]])
            self.assertIn(participant["effort"], FDE.PANEL_EFFORTS)
            self.assertGreater(participant["estimatedCostUnits"], 0)

    def test_an_explicit_choice_is_never_overwritten(self):
        run_id = self.panel_run()
        result = self.sb.fde(
            "design-panel", "create", run_id, "--replace", "--routing", "auto",
            "--brief", self.BRIEF,
            "--participant", "claude_work:flow",
            "--participant", "claude_msc:visual",
            "--participant", "claude_alt:system:max:big", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        panel = self.panel(run_id)
        chosen = next(p for p in panel["participants"]
                      if p["participantId"] == "claude_alt")
        self.assertEqual((chosen["model"], chosen["effort"]), ("big", "max"))
        self.assertEqual(chosen["routingSource"], "operator")
        self.assertTrue(any("chosen by the operator" in note
                            for note in self.panel(run_id)["routing"]["notes"]))
        routed = [p for p in panel["participants"] if p["routingSource"] == "auto"]
        self.assertEqual(len(routed), 2)

    def test_auto_routing_does_not_touch_who_is_in_the_panel(self):
        """The panel's independence is its accounts, and those are not routed."""
        run_id = self.panel_run()
        self.create(run_id)
        before = [(p["participantId"], p["lensId"], p["order"])
                  for p in self.panel(run_id)["participants"]]
        self.create(run_id, "--routing", "auto")
        after = [(p["participantId"], p["lensId"], p["order"])
                 for p in self.panel(run_id)["participants"]]
        self.assertEqual(before, after)
        self.assertEqual(len({p[0] for p in after}), 3)

    def test_the_same_account_twice_is_still_refused_under_auto(self):
        run_id = self.panel_run()
        result = self.sb.fde(
            "design-panel", "create", run_id, "--replace", "--routing", "auto",
            "--brief", self.BRIEF,
            "--participant", "claude_work:flow",
            "--participant", "claude_work:visual", "--json")
        self.assertEqual(result.returncode, 2)
        self.assertIn("one opinion", result.stderr)

    def test_distinct_lenses_are_still_required_under_auto(self):
        run_id = self.panel_run()
        result = self.sb.fde(
            "design-panel", "create", run_id, "--replace", "--routing", "auto",
            "--brief", self.BRIEF,
            "--participant", "claude_work:flow",
            "--participant", "claude_msc:flow", "--json")
        self.assertEqual(result.returncode, 2)
        self.assertIn("distinct design lens", result.stderr)

    def context_text(self, run_id):
        panel = self.panel(run_id)
        path = (self.sb.shared / "runs" / run_id / "artifacts" / "design-panel"
                / "common-context.md")
        # The panel id is fresh on every create and is embedded in the context,
        # so it is normalised out; everything else must be byte-identical.
        return path.read_text(encoding="utf-8").replace(panel["panelId"], "<panel-id>")

    def test_the_sealed_context_does_not_depend_on_which_models_were_chosen(self):
        """20. Routing sets a model. The sealed context is not about models."""
        run_id = self.panel_run()
        self.create(run_id)
        manual = self.context_text(run_id)
        self.create(run_id, "--routing", "auto")
        routed = self.context_text(run_id)
        self.assertEqual(manual, routed,
                         "the bytes every participant receives changed because the "
                         "models did")
        panel = self.panel(run_id)
        for participant in panel["participants"]:
            self.assertNotIn(participant["model"], routed)
            self.assertNotIn(f"effort {participant['effort']}", routed)
        self.assertTrue(panel["contextSha256"])
        self.assertEqual(panel["contextSha256"],
                         self.panel(run_id)["contextSha256"])

    def test_a_panel_follows_its_run_strategy_unless_told_otherwise(self):
        run_id = self.routed_run(
            requirement=self.BRIEF, strategy="quality_first",
            stages=("intake", "solutioning", "review", "reconciliation"),
            roles={"uiUxDesign": "claude_work,claude_msc", "solutioning": "claude_msc",
                   "review": "claude_alt"})
        self.approve(run_id)
        result = self.sb.fde(
            "design-panel", "create", run_id, "--routing", "auto", "--brief", self.BRIEF,
            "--participant", "claude_work:flow", "--participant", "claude_msc:visual",
            "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.panel(run_id)["routing"]["strategy"], "quality_first")
        override = self.sb.fde(
            "design-panel", "create", run_id, "--replace", "--routing", "auto",
            "--strategy", "cost_first", "--brief", self.BRIEF,
            "--participant", "claude_work:flow", "--participant", "claude_msc:visual",
            "--json")
        self.assertEqual(override.returncode, 0, override.stderr)
        self.assertEqual(self.panel(run_id)["routing"]["strategy"], "cost_first")

    def test_strategy_without_auto_is_refused(self):
        run_id = self.panel_run()
        result = self.sb.fde(
            "design-panel", "create", run_id, "--replace", "--strategy", "cost_first",
            "--brief", self.BRIEF, "--participant", "claude_work:flow",
            "--participant", "claude_msc:visual", "--json")
        self.assertEqual(result.returncode, 2)
        self.assertIn("--strategy applies to --routing auto", result.stderr)

    def reconciler_route(self, run_id):
        """Ask the controller itself, in the sandbox, which route the reconciler gets."""
        script = (
            "import importlib.machinery, importlib.util, json, sys\n"
            "loader = importlib.machinery.SourceFileLoader('fde_mod', sys.argv[1])\n"
            "spec = importlib.util.spec_from_loader(loader.name, loader)\n"
            "mod = importlib.util.module_from_spec(spec)\n"
            "loader.exec_module(mod)\n"
            "print(json.dumps(mod.panel_reconciler_route(mod.Run(sys.argv[2]))))\n")
        result = subprocess.run(
            [sys.executable, "-c", script, str(self.sb.shared / "bin" / "fde"), run_id],
            capture_output=True, text=True, env=self.sb.env(), cwd=str(self.sb.tmp))
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_the_reconciler_takes_the_approved_route_when_there_is_one(self):
        run_id = self.panel_run()
        doc = self.routing_doc(run_id)
        reconciliation = next(task for task in doc["tasks"]
                              if task["stage"] == "reconciliation")
        self.assertEqual(reconciliation["accountId"], doc["orchestrator"]["accountId"])
        route = self.reconciler_route(run_id)
        self.assertIsNotNone(route)
        self.assertEqual(route["model"], reconciliation["model"])
        self.assertEqual(route["effort"], reconciliation["effort"])
        self.assertIn(reconciliation["taskId"], route["source"])

    def test_the_reconciler_falls_back_to_the_session_config_on_a_manual_run(self):
        run_id = self.sb.start(self.BRIEF, shape="design-panel")
        assigned = self.sb.fde(
            "roles", run_id, "--set", "uiUxDesign=claude_work,claude_msc",
            "--set", "solutioning=claude_msc", "--set", "review=claude_alt",
            "--set", "presentation=claude_work", "--set", "designSystem=none",
            "--set", "prReview=none", "--set", "standardsReview=none",
            "--set", "securityReview=none", "--set", "productManagement=none",
            "--set", "microsoftContext=none")
        self.assertEqual(assigned.returncode, 0, assigned.stderr)
        self.assertIsNone(self.reconciler_route(run_id))


# -- 14. calibration reporting is read-only ------------------------------

class TestCalibrationReport(AttemptTest):
    def test_an_empty_store_reports_nothing_rather_than_guessing(self):
        report = json.loads(self.sb.fde("routing", "report", "--json").stdout)
        self.assertEqual(report["runs"]["total"], 0)
        self.assertEqual(report["calibration"]["recommendations"], [])
        self.assertFalse(report["calibration"]["policyChanged"])

    def test_the_report_writes_nothing(self):
        run_id = self.approved()
        self.attempt(run_id)
        self.outcome(run_id, classification="transient-provider")
        root = self.sb.shared
        before = {path: path.stat().st_mtime_ns for path in root.rglob("*")
                  if path.is_file()}
        result = self.sb.fde("routing", "report", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        after = {path: path.stat().st_mtime_ns for path in root.rglob("*")
                 if path.is_file()}
        self.assertEqual(before, after, "a report must not change the record it reads")

    def test_it_counts_what_the_ledgers_say(self):
        run_id = self.approved()
        self.attempt(run_id)
        self.outcome(run_id, classification="invalid-contract")
        self.attempt(run_id)
        report = json.loads(self.sb.fde("routing", "report", "--json").stdout)
        self.assertEqual(report["runs"]["total"], 1)
        self.assertEqual(report["runs"]["approved"], 1)
        self.assertEqual(report["runs"]["byMode"], {"auto": 1})
        self.assertEqual(report["attempts"]["total"], 2)
        self.assertEqual(report["attempts"]["escalations"], 1)
        self.assertGreater(report["cost"]["estimatedConsumed"]["value"], 0)
        self.assertEqual(report["cost"]["estimatedConsumed"]["state"], "estimated")
        self.assertTrue(report["cost"]["costUnitsAreEstimates"])

    def test_money_is_unavailable_until_a_provider_reports_it(self):
        run_id = self.approved()
        self.attempt(run_id)
        report = json.loads(self.sb.fde("routing", "report", "--json").stdout)
        self.assertEqual(report["cost"]["reportedMonetary"]["state"], "unavailable")
        self.assertIsNone(report["cost"]["reportedMonetary"]["value"])

    def test_a_handful_of_runs_never_produces_a_recommendation(self):
        """The system must not re-weight itself from three runs."""
        run_id = self.approved()
        self.attempt(run_id)
        self.outcome(run_id, classification="transient-provider")
        report = json.loads(self.sb.fde("routing", "report", "--json").stdout)
        self.assertEqual(report["calibration"]["minSample"], 5)
        self.assertEqual(report["calibration"]["recommendations"], [])
        self.assertTrue(report["calibration"]["insufficientEvidence"])
        reasons = " ".join(entry["reason"] for entry
                           in report["calibration"]["insufficientEvidence"])
        self.assertIn("are needed before", reasons)

    def test_a_recommendation_is_a_recommendation_and_says_so(self):
        run_id = self.approved()
        for _ in range(2):
            self.attempt(run_id)
            self.outcome(run_id, classification="invalid-contract")
        report = json.loads(self.sb.fde(
            "routing", "report", "--min-sample", "1", "--json").stdout)
        calibration = report["calibration"]
        self.assertTrue(calibration["recommendations"])
        self.assertFalse(calibration["policyChanged"])
        self.assertIn("does not update its own routing policy", calibration["note"])
        for entry in calibration["recommendations"]:
            self.assertFalse(entry["applied"])
            self.assertIn("human review only", entry["note"])
            self.assertTrue(entry["appliesTo"])
            self.assertTrue(entry["evidence"])
            self.assertGreaterEqual(entry["sampleSize"], 1)
        self.assertTrue(any("output contract" in entry["recommendation"]
                            for entry in calibration["recommendations"]))

    def test_a_ceiling_recommendation_names_a_field_that_exists(self):
        run_id = self.approved(requirement=STANDARD_REQUEST,
                               stages=("intake", "solutioning"),
                               roles={"solutioning": "claude_msc"})
        while True:
            result = self.attempt(run_id)
            if result.returncode not in (0, 1):
                break
            self.outcome(run_id, classification="transient-provider")
        report = json.loads(self.sb.fde(
            "routing", "report", "--min-sample", "1", "--json").stdout)
        ceilings = [entry for entry in report["calibration"]["recommendations"]
                    if entry["id"].startswith("ceiling-reached-")]
        self.assertTrue(ceilings)
        for entry in ceilings:
            for path in entry["appliesTo"].replace(" and ", ", ").split(","):
                leaf = path.strip().split(".")[-1].strip()
                if not leaf or leaf in ("ladder",):
                    continue
                self.assertTrue(
                    any(leaf in spec for spec in FAKE_POLICY["limits"].values())
                    or leaf in FAKE_POLICY.get("escalation", {}),
                    f"'{leaf}' is not a field of this policy")

    def test_the_report_can_be_scoped_and_says_what_it_read(self):
        run_id = self.approved()
        self.attempt(run_id)
        scoped = json.loads(self.sb.fde(
            "routing", "report", "--project", "no-such-project", "--json").stdout)
        self.assertEqual(scoped["scope"]["projectId"], "no-such-project")
        self.assertEqual(scoped["runs"]["total"], 0)
        future = json.loads(self.sb.fde(
            "routing", "report", "--since", "2099-01-01T00:00:00+00:00",
            "--json").stdout)
        self.assertEqual(future["runs"]["total"], 0)
        everything = json.loads(self.sb.fde("routing", "report", "--json").stdout)
        self.assertEqual(everything["runs"]["total"], 1)
        self.assertEqual(everything["policyRevision"], "test-fixture-1")


# -- 15. ceilings, probes and provenance, after the second review ----------

class TestCeilingsAndProbes(AttemptTest):
    """Each of these was wrong once. They stay."""

    def test_the_run_budget_stops_a_later_task_opening_attempt(self):
        """A first attempt spends from the same approved budget as a retry."""
        # Wide enough to approve the plan, narrow enough that its retries eat
        # the budget before the last task has run at all.
        tight = json.loads(json.dumps(FAKE_POLICY))
        for band in tight["limits"].values():
            band["maxCostUnits"] = 180
            band["maxRetries"] = 3
        self.install_policy(tight)
        run_id = self.approved(
            requirement=CRITICAL_REQUEST,
            stages=("intake", "solutioning", "review"),
            roles={"solutioning": "claude_msc", "review": "claude_alt"})
        # Spend the budget on one task's retries…
        while True:
            result = self.attempt(run_id)
            if result.returncode not in (0, 1):
                break
            self.outcome(run_id, classification="transient-provider")
        self.assertEqual(result.returncode, 9, result.stderr)
        spent = json.loads(self.sb.fde(
            "routing", "attempts", run_id, "--json").stdout)["spentCostUnits"]
        # …then a task that has never run must also be refused.
        (self.sb.shared / "runs" / run_id / "tasks" / "r.md").write_text("review it")
        later = self.sb.fde("invoke", run_id, "claude_alt", "tasks/r.md",
                            "--stage", "review", "--task-id", "review-1")
        self.assertEqual(later.returncode, 9, later.stderr)
        self.assertIn("was approved", later.stderr)
        after = json.loads(self.sb.fde(
            "routing", "attempts", run_id, "--json").stdout)
        self.assertEqual(after["spentCostUnits"], spent,
                         "a refused attempt must not be recorded as spend")
        self.assertLessEqual(after["spentCostUnits"], 180)

    def test_reading_the_next_step_does_not_record_a_ceiling_event(self):
        """4. A question is not an action, and must not become evidence."""
        run_id = self.approved(requirement=STANDARD_REQUEST,
                               stages=("intake", "solutioning"),
                               roles={"solutioning": "claude_msc"})
        while True:
            result = self.attempt(run_id)
            if result.returncode not in (0, 1):
                break
            self.outcome(run_id, classification="transient-provider")
        events_path = self.sb.shared / "runs" / run_id / "routing-events.jsonl"
        before = len([line for line in events_path.read_text().splitlines() if line])
        # Re-record the same judgement, and ask what would happen next, twice.
        for _ in range(3):
            self.outcome(run_id, classification="transient-provider")
        self.sb.fde("invoke", run_id, "claude_msc", "tasks/s.md",
                    "--stage", "solutioning", "--task-id", "solutioning-1", "--dry-run")
        after = len([line for line in events_path.read_text().splitlines() if line])
        self.assertEqual(before, after,
                         "a read appended events, which the calibration report counts")

    def test_an_outcome_for_a_task_the_decision_no_longer_has_is_refused(self):
        """3. And refused as a typed error, not a traceback."""
        run_id = self.approved()
        self.attempt(run_id)
        doc = self.routing_doc(run_id)
        doc["tasks"] = [task for task in doc["tasks"]
                        if task["taskId"] != "solutioning-1"]
        (self.sb.shared / "runs" / run_id / "routing.json").write_text(
            json.dumps(doc, indent=2))
        result = self.sb.fde("routing", "outcome", run_id, "--task-id", "solutioning-1",
                             "--status", "fail", "--classification", "invalid-contract",
                             "--json")
        self.assertEqual(result.returncode, 4, result.stdout)
        self.assertNotIn("Traceback", result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["error"]["code"], "routing-task-unknown")
        self.assertIn("routing-attempts.jsonl", payload["error"]["hint"])

    def test_a_malformed_task_id_on_an_outcome_is_refused(self):
        run_id = self.approved()
        self.attempt(run_id)
        result = self.sb.fde("routing", "outcome", run_id,
                             "--task-id", "../../etc/passwd", "--status", "pass",
                             "--json")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["error"]["code"],
                         "routing-task-id-invalid")

    def test_attempts_reads_a_record_with_no_cost_ceiling(self):
        """7. A missing ceiling is a gap in the record, not a crash."""
        run_id = self.approved()
        doc = self.routing_doc(run_id)
        doc["limits"].pop("maxCostUnits")
        (self.sb.shared / "runs" / run_id / "routing.json").write_text(
            json.dumps(doc, indent=2))
        text = self.sb.fde("routing", "attempts", run_id)
        self.assertEqual(text.returncode, 0, text.stderr)
        self.assertIn("unrecorded ceiling", text.stdout)
        self.assertNotIn("Traceback", text.stderr)

    def test_reported_money_is_a_total_only_when_every_attempt_reported_one(self):
        """13. A partial sum looks like a total and is not one."""
        run_id = self.approved()
        report = self.sb.tmp / "usage.json"
        self.attempt(run_id)
        report.write_text(json.dumps({"monetaryCost": 0.04, "currency": "usd"}))
        self.outcome(run_id, classification="invalid-contract",
                     extra=("--usage-file", str(report)))
        self.attempt(run_id)          # this one reports nothing
        partial = json.loads(self.sb.fde("routing", "report", "--json").stdout)
        self.assertEqual(partial["cost"]["reportedMonetary"]["state"], "unavailable")
        self.assertIsNone(partial["cost"]["reportedMonetary"]["value"])
        self.assertIn("would be a guess", partial["cost"]["reportedMonetary"]["reason"])
        self.outcome(run_id, status="pass", extra=("--usage-file", str(report)))
        whole = json.loads(self.sb.fde("routing", "report", "--json").stdout)
        money = whole["cost"]["reportedMonetary"]
        self.assertEqual(money["state"], "reported")
        self.assertAlmostEqual(money["value"], 0.08, places=6)
        self.assertIn("USD", money["source"])

    def test_the_report_reads_the_newest_runs_first(self):
        """6. The cap must not discard exactly the runs a report is about."""
        first = self.approved(requirement=STANDARD_REQUEST,
                              stages=("intake", "solutioning"),
                              roles={"solutioning": "claude_msc"})
        second = self.approved(requirement=STANDARD_REQUEST,
                               stages=("intake", "solutioning"),
                               roles={"solutioning": "claude_msc"})
        script = (
            "import importlib.machinery, importlib.util, json, sys\n"
            "loader = importlib.machinery.SourceFileLoader('fde_mod', sys.argv[1])\n"
            "spec = importlib.util.spec_from_loader(loader.name, loader)\n"
            "mod = importlib.util.module_from_spec(spec)\n"
            "loader.exec_module(mod)\n"
            "rows, _skipped = mod._report_run_records()\n"
            "print(json.dumps([row['runId'] for row in rows]))\n")
        result = subprocess.run(
            [sys.executable, "-c", script, str(self.sb.shared / "bin" / "fde")],
            capture_output=True, text=True, env=self.sb.env(), cwd=str(self.sb.tmp))
        self.assertEqual(result.returncode, 0, result.stderr)
        order = json.loads(result.stdout)
        self.assertEqual(order, sorted(order, reverse=True))
        self.assertEqual({first, second}, set(order))

    def test_an_escalation_recommendation_carries_escalation_evidence(self):
        """9. Not the evidence for the opposite claim."""
        run_id = self.approved()
        for _ in range(2):
            self.attempt(run_id)
            self.outcome(run_id, classification="invalid-contract")
        report = json.loads(self.sb.fde(
            "routing", "report", "--min-sample", "1", "--json").stdout)
        raises = [entry for entry in report["calibration"]["recommendations"]
                  if entry["id"].startswith("raise-recommended-tier-")]
        self.assertTrue(raises, [e["id"] for e
                                 in report["calibration"]["recommendations"]])
        for entry in raises:
            self.assertTrue(entry["evidence"])
            for item in entry["evidence"]:
                self.assertIn("escalated to", item)
        # The counts the recommendation was derived from are published too.
        bands = report["calibration"]["bands"]
        self.assertTrue(bands)
        for stats in bands.values():
            self.assertIn("escalations", stats)
            self.assertNotIn("raiseEvidence", stats)


class TestPanelPinnedChoices(RoutingTest):
    """5. A pinned model is priced as itself, or not priced at all."""

    BRIEF = TestDesignPanelRouting.BRIEF

    def panel_run(self):
        run_id = self.routed_run(
            requirement=self.BRIEF,
            stages=("intake", "solutioning", "review", "reconciliation"),
            roles={"uiUxDesign": "claude_work,claude_msc", "solutioning": "claude_msc",
                   "review": "claude_alt"})
        self.approve(run_id)
        return run_id

    def panel(self, run_id):
        return json.loads(self.sb.fde("status", run_id, "--json").stdout)["designPanel"]

    def create(self, run_id, *participants, expect=0):
        args = ["design-panel", "create", run_id, "--replace", "--routing", "auto",
                "--brief", self.BRIEF]
        for spec in participants:
            args += ["--participant", spec]
        result = self.sb.fde(*args, "--json")
        self.assertEqual(result.returncode, expect,
                         f"stdout={result.stdout}\nstderr={result.stderr}")
        return result

    def test_a_pinned_model_keeps_its_own_tier_and_price(self):
        run_id = self.panel_run()
        self.create(run_id, "claude_work:flow", "claude_msc:visual::big")
        panel = self.panel(run_id)
        pinned = next(p for p in panel["participants"]
                      if p["participantId"] == "claude_msc")
        self.assertEqual(pinned["model"], "big")
        self.assertEqual(pinned["tier"], "premium",
                         "the tier must be the pinned model's, not another model's")
        big = next(m for m in FAKE_POLICY["providers"]["anthropic"]["models"]
                   if m["id"] == "big")
        self.assertIn(pinned["effort"], big["efforts"])
        self.assertGreater(pinned["estimatedCostUnits"],
                           next(p["estimatedCostUnits"] for p in panel["participants"]
                                if p["participantId"] == "claude_work"))
        self.assertIn("Big", pinned["routingReason"])

    def test_a_pinned_model_the_policy_does_not_offer_is_left_alone_and_unpriced(self):
        run_id = self.panel_run()
        self.create(run_id, "claude_work:flow", "claude_msc:visual::invented-model")
        panel = self.panel(run_id)
        pinned = next(p for p in panel["participants"]
                      if p["participantId"] == "claude_msc")
        self.assertEqual(pinned["model"], "invented-model")
        self.assertEqual(pinned["routingSource"], "operator")
        self.assertIsNone(pinned["tier"])
        self.assertIsNone(pinned["estimatedCostUnits"],
                          "a model this policy never priced gets no price")
        self.assertTrue(any("invented-model" in note
                            for note in panel["routing"]["notes"]))

    def test_a_pinned_effort_narrows_the_model_rather_than_being_ignored(self):
        run_id = self.panel_run()
        self.create(run_id, "claude_work:flow", "claude_msc:visual:high")
        panel = self.panel(run_id)
        pinned = next(p for p in panel["participants"]
                      if p["participantId"] == "claude_msc")
        self.assertEqual(pinned["effort"], "high")
        self.assertEqual(pinned["routingSource"], "auto")
        offered = {m["id"]: m["efforts"] for m
                   in FAKE_POLICY["providers"]["anthropic"]["models"]}
        self.assertIn("high", offered[pinned["model"]])


if __name__ == "__main__":
    unittest.main()
