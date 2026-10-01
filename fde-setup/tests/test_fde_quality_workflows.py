import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "claude-shared/lib"))
import fde_quality_workflows as quality
import fde_provenance


class QualityWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "task.md").write_text("Verify REQ-001 from the supplied evidence.")
        self.artifact = {"path": "task.md", "sha256": hashlib.sha256((self.root / "task.md").read_bytes()).hexdigest()}
        self.suite = {"schemaVersion": 1, "revision": "test.1", "cases": [
            {"id": "one", "checks": ["correct", "safe"], "safetyChecks": ["safe"]},
            {"id": "two", "checks": ["correct"], "safetyChecks": []}]}
        self.results = {"schemaVersion": 1, "suiteRevision": "test.1", "model": "fixture",
                        "toolVersion": "test", "policyRevision": "test", "evaluator": "test-reviewer",
                        "attempts": [self.attempt("one"), self.attempt("two")]}

    def tearDown(self):
        self.tmp.cleanup()

    def attempt(self, case_id, n=1):
        return {"caseId": case_id, "attempt": n, "checks": {"correct": "pass", **({"safe": "pass"} if case_id == "one" else {})},
                "evidence": [self.artifact], "cost": {"units": None, "provenance": "unavailable"}}

    def evaluate(self):
        return quality.evaluate(self.suite, self.results, self.root)

    def test_unknown_metrics_are_not_zero_and_missing_cases_fail(self):
        report = self.evaluate()
        self.assertTrue(report["pass"])
        self.assertIsNone(report["totalCostUnits"])
        self.assertIsNone(report["metrics"]["escapedDefects"]["total"])
        self.results["attempts"].pop()
        report = self.evaluate()
        self.assertFalse(report["pass"])
        self.assertEqual(report["missingCases"], ["two"])
        self.assertEqual(report["firstAttemptAcceptanceRate"], .5)

    def test_retries_do_not_erase_safety_failures(self):
        self.results["attempts"][0]["checks"]["safe"] = "fail"
        self.results["attempts"].append(self.attempt("one", 2))
        report = self.evaluate()
        self.assertFalse(report["pass"])
        self.assertEqual(report["eventualAcceptanceRate"], 1)
        self.assertEqual(report["firstAttemptAcceptanceRate"], .5)
        self.assertEqual(len(report["safetyFailures"]), 1)

    def test_earlier_success_does_not_hide_latest_failure(self):
        row = self.attempt("one", 2)
        row["checks"]["correct"] = "fail"
        self.results["attempts"].append(row)
        self.assertFalse(self.evaluate()["pass"])

    def test_duplicate_and_gapped_attempts_rejected(self):
        for n in (1, 3):
            with self.subTest(n=n):
                self.results["attempts"] = [self.attempt("one"), self.attempt("one", n)]
                with self.assertRaises(ValueError):
                    self.evaluate()

    def test_hash_and_path_escape_rejected(self):
        original = copy.deepcopy(self.results)
        for relative in ("../outside", str(self.root / "task.md")):
            self.results = copy.deepcopy(original)
            self.results["attempts"][0]["evidence"][0]["path"] = relative
            with self.assertRaises(ValueError):
                self.evaluate()
        self.results = original
        (self.root / "task.md").write_text("changed")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.evaluate()

    def test_cost_numbers_require_provenance_and_finite_values(self):
        for value in (-1, float("nan"), float("inf"), True):
            self.results["attempts"][0]["cost"] = {"units": value, "provenance": "reported"}
            with self.assertRaises(ValueError):
                self.evaluate()
        for row in self.results["attempts"]:
            row["cost"] = {"units": 2, "provenance": "estimated"}
        self.assertEqual(self.evaluate()["costPerAcceptedCase"], 2)

    def handoff(self):
        return {"schemaVersion": 1, "runId": "run", "taskId": "review", "objective": "Review pagination",
                "specialist": "reviewer", "assignedIdentity": "assigned", "stage": "review",
                "stopCondition": "return findings", "escalationCondition": "missing evidence",
                "requirementIds": ["REQ-001"], "task": self.artifact, "inputEvidence": [],
                "acceptanceChecks": [{"requirementId": "REQ-001", "check": "Verify maximum page size"}],
                "permissions": {"tools": ["Read"], "writePaths": []}, "ownedPaths": [], "reviewOnly": True,
                "output": {"path": "artifacts/review.md", "format": "markdown findings"},
                "budget": {"maxAttempts": 1, "maxSeconds": 60, "maxCostUnits": 2}}

    def validate(self, doc):
        (self.root / "handoff.json").write_text(json.dumps(doc))
        return quality.validate_handoff(self.root, "handoff.json", "run")

    def test_handoff_requires_traceability_and_no_review_writes(self):
        doc = self.handoff()
        self.assertTrue(self.validate(doc)["valid"])
        doc["requirementIds"].append("REQ-002")
        with self.assertRaisesRegex(ValueError, "every requirement"):
            self.validate(doc)
        doc = self.handoff()
        doc["permissions"]["tools"].append("Bash")
        with self.assertRaisesRegex(ValueError, "review-only"):
            self.validate(doc)
        doc = self.handoff()
        doc["runId"] = "different"
        with self.assertRaisesRegex(ValueError, "runId"):
            self.validate(doc)

    def test_cli_reports_regressions_and_exits_nonzero(self):
        (self.root / "suite.json").write_text(json.dumps(self.suite))
        (self.root / "baseline.json").write_text(json.dumps(self.results))
        self.results["attempts"][0]["checks"]["correct"] = "fail"
        self.results["attempts"].append(self.attempt("one", 2))
        (self.root / "results.json").write_text(json.dumps(self.results))
        result = subprocess.run([str(ROOT / "claude-shared/bin/fde"), "evaluate",
                                 "--suite", str(self.root / "suite.json"), "--results", str(self.root / "results.json"),
                                 "--baseline", str(self.root / "baseline.json"), "--json"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["comparison"]["regressions"], ["one"])


class ProvenanceTests(unittest.TestCase):
    def test_diff_reports_paths_not_secret_values_and_does_not_mutate(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, installed = Path(tmp) / "source", Path(tmp) / "installed"
            for root in (source, installed):
                (root / "config").mkdir(parents=True)
                (root / "config/routing-policy.json").write_text('{"token":"sensitive-source"}')
            path = installed / "config/routing-policy.json"
            path.write_text('{"token":"sensitive-installed"}')
            before = path.read_bytes()
            report = fde_provenance.report(source, installed)
            serialized = json.dumps(report)
            self.assertNotIn("sensitive", serialized)
            row = next(r for r in report["files"] if r["path"] == "config/routing-policy.json")
            self.assertEqual(row["changedPaths"], ["/token"])
            self.assertEqual(row["status"], "different")
            self.assertEqual(path.read_bytes(), before)
            path.write_text('{ "token": "sensitive-source" }')
            self.assertEqual(fde_provenance.report(source, installed)["files"][0]["status"], "formatting-only")

    def test_invalid_and_external_symlinks_are_reported_without_reading(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, installed = Path(tmp) / "source", Path(tmp) / "installed"
            for root in (source, installed):
                (root / "config").mkdir(parents=True)
                (root / "config/routing-policy.json").write_text('{}')
            outside = Path(tmp) / "outside"
            outside.write_text('credential')
            (installed / "config/agents.json").symlink_to(outside)
            (installed / "config/security-policy.json").write_text('{bad')
            rows = {r["path"]: r for r in fde_provenance.report(source, installed)["files"]}
            self.assertEqual(rows["config/agents.json"]["installed"]["state"], "outside-root")
            self.assertEqual(rows["config/security-policy.json"]["status"], "invalid")
