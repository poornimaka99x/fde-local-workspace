"""The optional feature-specs artifact profile.

Library rules run in-process against fixture text; controller behaviour runs
against the throwaway HOME built by test_fde.Sandbox, so nothing here touches a
real install, run store or repository.

  claude-shared/bin/quiet python3 -m unittest discover -s tests -p 'test_fde_feature_specs.py'
"""
import hashlib
import json
import pathlib
import shutil
import sys
import unittest

from test_fde import FDETest

REPO = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "claude-shared" / "lib"))
import fde_feature_specs as specs  # noqa: E402

EXAMPLE = REPO / "docs" / "examples" / "feature-specs" / "FEAT-012"
TEMPLATES = REPO / "fde-toolkit" / "plugins" / "fde-core" / "skills" / "feature-specs" / "templates"


def example_docs():
    return {name: (EXAMPLE / name).read_bytes() for name in specs.DOCUMENTS}


def codes(payload, severity=None):
    return {f["code"] for f in payload["findings"]
            if severity is None or f["severity"] == severity}


def edit(docs, name, old, new):
    text = docs[name].decode()
    assert old in text, old
    docs[name] = text.replace(old, new, 1).encode()
    return docs


class TestRules(unittest.TestCase):
    def test_worked_example_is_clean_at_every_stage(self):
        for stage in (None, "research", "solutioning", "planning", "implementation", "verification"):
            payload = specs.validate(example_docs(), feature_id="FEAT-012", stage=stage)
            self.assertTrue(payload["valid"], (stage, payload["findings"]))
        self.assertEqual(payload["ids"]["requirements"],
                         ["REQ-012-001", "REQ-012-002", "REQ-012-003"])

    def test_rendered_templates_are_traceable_but_unfilled(self):
        docs = {name: specs.render((TEMPLATES / name).read_text(), feature_id="FEAT-007",
                                   title="T", run_id="r", date="2026-01-01").encode()
                for name in specs.DOCUMENTS}
        payload = specs.validate(docs, feature_id="FEAT-007")
        self.assertEqual(codes(payload, "error"), {"unfilled-placeholder"})
        self.assertEqual(payload["ids"]["tasks"], ["TASK-007-001"])

    def test_missing_documents_depend_on_stage(self):
        docs = example_docs()
        del docs["tasks.md"], docs["verification.md"]
        self.assertTrue(specs.validate(docs, feature_id="FEAT-012", stage="solutioning")["valid"])
        payload = specs.validate(docs, feature_id="FEAT-012", stage="planning")
        self.assertIn("missing-document", codes(payload, "error"))

    def test_drafts_not_yet_required_are_not_held_to_completeness(self):
        docs = edit(example_docs(), "verification.md", "- Result: pass", "- Result: {{later}}")
        self.assertTrue(specs.validate(docs, feature_id="FEAT-012", stage="planning")["valid"])
        self.assertFalse(specs.validate(docs, feature_id="FEAT-012", stage="verification")["valid"])

    def test_identifier_rules(self):
        cases = [
            ("spec.md", "### REQ-012-003:", "### REQ-012-002:", "duplicate-id"),
            ("spec.md", "### REQ-012-003:", "### REQ-013-003:", "foreign-id"),
            ("tasks.md", "- Depends on: none", "- Depends on: TASK-012-099", "unknown-reference"),
            ("plan.md", "## Approach", "## Approach\n\nSee REQ-044-001.", "foreign-reference"),
            ("tasks.md", "### TASK-012-005:", "### REQ-012-009:", "misplaced-id"),
            ("spec.md", "feature: FEAT-012", "feature: FEAT-013", "wrong-feature"),
        ]
        for doc, old, new, code in cases:
            with self.subTest(code=code):
                payload = specs.validate(edit(example_docs(), doc, old, new), feature_id="FEAT-012")
                self.assertIn(code, codes(payload, "error"))

    def test_traceability_rules(self):
        cases = [
            ("spec.md", "- Requirement: REQ-012-003\n", "", "requirement-without-check"),
            ("spec.md", "- Verification: review", "- Verification: none", "check-without-method"),
            ("spec.md", "- Status: answered", "- Status: maybe", "question-without-status"),
            ("spec.md", "- Answer: Yes, using", "- Answer: none\n- Note: Yes, using", "answer-missing"),
            ("tasks.md", "- Requirements: none\n- Justification: risk mitigation from plan.md; supports operations, not a requirement\n",
             "- Requirements: none\n", "task-without-requirement"),
            ("tasks.md", "- Done when: triple-delivery test queues one email\n", "", "task-without-completion"),
            ("tasks.md", "- Status: in-progress", "- Status: started", "task-without-status"),
            ("tasks.md", "- Requirements: REQ-012-001\n- Depends on: none\n- Done when: contract",
             "- Requirements: REQ-012-001\n- Depends on: TASK-012-002\n- Done when: contract",
             "task-dependency-cycle"),
            ("verification.md", "- Evidence: `StatusNotifierTest.deduplicatesReplays` (CI build 4812)\n", "",
             "pass-without-evidence"),
            ("verification.md", "- Result: not-run", "- Result: probably", "result-missing"),
            ("verification.md", "### CHECK-012-004: Copy approved by the client", "### Notes", "check-unrecorded"),
        ]
        for doc, old, new, code in cases:
            with self.subTest(code=code):
                payload = specs.validate(edit(example_docs(), doc, old, new), feature_id="FEAT-012")
                self.assertIn(code, codes(payload, "error"))

    def test_completion_and_acceptance_are_separate_facts(self):
        docs = edit(example_docs(), "verification.md", "- Result: pass\n- Method: triple",
                    "- Result: fail\n- Method: triple")
        payload = specs.validate(docs, feature_id="FEAT-012")
        self.assertTrue(payload["valid"])
        self.assertIn("done-not-accepted", codes(payload, "warning"))

    def test_credentials_are_refused(self):
        for secret in ("AKIA" + "ABCDEFGHIJKLMNOP", "password = hunter2hunter2",
                       "-----BEGIN RSA PRIVATE KEY-----"):
            with self.subTest(secret=secret[:8]):
                docs = edit(example_docs(), "plan.md", "## Risks", f"{secret}\n\n## Risks")
                self.assertIn("credential", codes(specs.validate(docs, feature_id="FEAT-012"), "error"))

    def test_hash_baseline_separates_scope_change_from_outcomes(self):
        baseline = specs.validate(example_docs(), feature_id="FEAT-012")["hashes"]
        docs = edit(example_docs(), "verification.md", "- Result: not-run", "- Result: unavailable")
        payload = specs.validate(docs, feature_id="FEAT-012", baseline=baseline)
        self.assertTrue(payload["valid"])
        self.assertEqual(payload["changedSinceHandoff"], ["verification.md"])
        docs = edit(example_docs(), "spec.md", "- Priority: should", "- Priority: must")
        payload = specs.validate(docs, feature_id="FEAT-012", baseline=baseline)
        self.assertIn("changed-since-handoff", codes(payload, "error"))

    def test_feature_ids_are_checked(self):
        for bad in ("FEAT-1", "feat-012", "FEAT-012/../x", ""):
            with self.assertRaises(specs.FeatureSpecError):
                specs.feature_number(bad)


class FeatureRunTest(FDETest):
    def start(self, *extra):
        r = self.sb.fde("start", "ACME-142 returns", "--orchestrator", "claude_alt",
                        "--shape", "full", *extra)
        self.assertEqual(r.returncode, 0, r.stderr)
        return next(l.split()[1] for l in r.stdout.splitlines() if l.startswith("run "))

    def confirmed(self, *extra):
        run_id = self.start(*extra)
        self.assertEqual(self.sb.full_roles(run_id).returncode, 0)
        return run_id

    def status(self, run_id):
        return json.loads(self.sb.fde("status", run_id, "--json").stdout)

    def fill_from_example(self, run_id):
        target = self.sb.run_dir(run_id) / "artifacts" / "features" / "FEAT-012"
        target.mkdir(parents=True, exist_ok=True)
        for name in specs.DOCUMENTS:
            shutil.copy2(EXAMPLE / name, target / name)
        return target

    def project(self, *extra):
        r = self.sb.fde("project", "create", "--name", "Returns", "--repo", str(self.sb.repo),
                        *extra, "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)["project"]


class TestProfileSelection(FeatureRunTest):
    def test_a_run_without_the_profile_is_unchanged(self):
        run_id = self.start()
        manifest = json.loads((self.sb.run_dir(run_id) / "manifest.json").read_text())
        self.assertNotIn("artifactProfile", manifest)
        status = self.status(run_id)
        self.assertIsNone(status["artifactProfile"])
        self.assertIsNone(status["features"])
        self.assertFalse((self.sb.run_dir(run_id) / "artifacts" / "features").exists())
        self.assertFalse((self.sb.run_dir(run_id) / "features.jsonl").exists())
        overrides = self.sb.run_dir(run_id) / "capabilities"
        self.assertNotIn("feature-specs", "".join(p.read_text() for p in overrides.rglob("*.json"))
                         if overrides.is_dir() else "")
        refused = self.sb.fde("features", "scaffold", run_id, "--feature", "FEAT-012", "--title", "T")
        self.assertEqual(refused.returncode, 5)
        self.assertIn("does not use the feature-specs artifact profile", refused.stderr)

    def test_explicit_profile_is_recorded_and_enables_only_its_skill(self):
        run_id = self.start("--artifact-profile", "feature-specs")
        manifest = json.loads((self.sb.run_dir(run_id) / "manifest.json").read_text())
        self.assertEqual(manifest["artifactProfile"], "feature-specs")
        events = (self.sb.run_dir(run_id) / "events.jsonl").read_text()
        self.assertIn("artifact_profile.selected", events)
        overrides = "".join(p.read_text() for p in (self.sb.run_dir(run_id) / "capabilities").rglob("*.json"))
        self.assertIn("skill:fde:feature-specs", overrides)
        self.assertEqual(self.status(run_id)["features"]["features"], [])

    def test_runs_inherit_the_project_profile_and_can_opt_out(self):
        project = self.project("--artifact-profile", "feature-specs")
        self.assertEqual(project["artifactProfile"], "feature-specs")
        inherited = self.start("--project", project["projectId"])
        opted_out = self.start("--project", project["projectId"], "--artifact-profile", "none")
        self.assertEqual(self.status(inherited)["artifactProfile"], "feature-specs")
        self.assertIsNone(self.status(opted_out)["artifactProfile"])

        # Clearing the project's profile affects future runs only.
        r = self.sb.fde("project", "update", project["projectId"], "--artifact-profile", "none", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("artifactProfile", json.loads(r.stdout)["project"])
        self.assertEqual(self.status(inherited)["artifactProfile"], "feature-specs")
        self.assertIsNone(self.status(self.start("--project", project["projectId"]))["artifactProfile"])

    def test_a_project_without_a_profile_keeps_its_old_shape(self):
        project = self.project()
        self.assertNotIn("artifactProfile", project)


class TestDocuments(FeatureRunTest):
    def test_scaffold_is_create_only(self):
        run_id = self.start("--artifact-profile", "feature-specs")
        r = self.sb.fde("features", "scaffold", run_id, "--feature", "FEAT-012",
                        "--title", "Return status", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["created"], list(specs.DOCUMENTS))
        spec = self.sb.run_dir(run_id) / "artifacts" / "features" / "FEAT-012" / "spec.md"
        self.assertIn("REQ-012-001", spec.read_text())
        spec.write_text("edited by a person\n")
        again = json.loads(self.sb.fde("features", "scaffold", run_id, "--feature", "FEAT-012",
                                       "--title", "Return status", "--json").stdout)
        self.assertEqual(again["created"], [])
        self.assertEqual(spec.read_text(), "edited by a person\n")
        bad = self.sb.fde("features", "scaffold", run_id, "--feature", "../x", "--title", "T")
        self.assertEqual(bad.returncode, 2)

    def test_principles_are_drafted_only_without_an_equivalent(self):
        run_id = self.confirmed("--artifact-profile", "feature-specs")
        args = ("features", "scaffold", run_id, "--feature", "FEAT-012", "--title", "T",
                "--principles", "--repo", str(self.sb.repo), "--json")
        (self.sb.repo / "AGENTS.md").write_text("# rules\n")
        first = json.loads(self.sb.fde(*args).stdout)
        self.assertEqual(first["principles"]["state"], "not-needed")
        self.assertEqual(first["principles"]["equivalents"], ["AGENTS.md"])
        (self.sb.repo / "AGENTS.md").unlink()
        second = json.loads(self.sb.fde(*args).stdout)
        self.assertEqual(second["principles"]["state"], "created")
        draft = self.sb.run_dir(run_id) / "artifacts" / "features" / "PRINCIPLES.md"
        self.assertIn("standards-sha256:", draft.read_text())
        draft.write_text("client edit\n")
        self.assertEqual(json.loads(self.sb.fde(*args).stdout)["principles"]["state"], "kept")
        self.assertEqual(draft.read_text(), "client edit\n")

    def test_repository_reads_need_confirmed_roles(self):
        run_id = self.start("--artifact-profile", "feature-specs")
        source = self.sb.repo / "docs" / "features" / "FEAT-012"
        shutil.copytree(EXAMPLE, source)
        r = self.sb.fde("features", "import", run_id, str(source))
        self.assertEqual(r.returncode, 6)
        self.assertIn("Roles are not confirmed", r.stderr)

    def test_import_snapshots_without_touching_the_repository(self):
        project = self.project("--artifact-profile", "feature-specs")
        run_id = self.confirmed("--project", project["projectId"])
        source = self.sb.repo / "docs" / "features" / "FEAT-012"
        shutil.copytree(EXAMPLE, source)
        before = {p.name: p.read_bytes() for p in source.iterdir()}
        r = self.sb.fde("features", "import", run_id, str(source), "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(sorted(json.loads(r.stdout)["imported"]), sorted(specs.DOCUMENTS))
        self.assertEqual({p.name: p.read_bytes() for p in source.iterdir()}, before)

        run_copy = self.sb.run_dir(run_id) / "artifacts" / "features" / "FEAT-012" / "plan.md"
        run_copy.write_text(run_copy.read_text() + "\nrun-side revision\n")
        kept = json.loads(self.sb.fde("features", "import", run_id, str(source), "--json").stdout)
        self.assertEqual(kept["kept"], ["plan.md"])
        compared = json.loads(self.sb.fde("features", "validate", run_id, "--feature", "FEAT-012",
                                          "--repo", str(self.sb.repo), "--json").stdout)
        self.assertFalse(compared["repository"]["inSync"])
        self.assertEqual(compared["repository"]["files"]["plan.md"], "differs")

        outside = self.sb.outside / "FEAT-012"
        shutil.copytree(EXAMPLE, outside)
        refused = self.sb.fde("features", "import", run_id, str(outside))
        self.assertEqual(refused.returncode, 6)
        self.assertIn("outside this run's project repositories", refused.stderr)

    def test_validate_a_bare_directory(self):
        ok = self.sb.fde("features", "validate", "--path", str(EXAMPLE), "--feature", "FEAT-012",
                         "--stage", "verification", "--json")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertTrue(json.loads(ok.stdout)["valid"])
        broken = self.sb.tmp / "broken"
        shutil.copytree(EXAMPLE, broken)
        (broken / "tasks.md").unlink()
        bad = self.sb.fde("features", "validate", "--path", str(broken), "--feature", "FEAT-012",
                          "--stage", "planning")
        self.assertEqual(bad.returncode, 1)
        self.assertIn("missing-document", bad.stdout)


class TestHandoffs(FeatureRunTest):
    def test_record_refuses_invalid_documents(self):
        run_id = self.start("--artifact-profile", "feature-specs")
        self.sb.fde("features", "scaffold", run_id, "--feature", "FEAT-012", "--title", "T")
        r = self.sb.fde("features", "record", run_id, "--feature", "FEAT-012", "--stage", "planning")
        self.assertEqual(r.returncode, 1)
        self.assertIn("nothing recorded", r.stdout)
        self.assertFalse((self.sb.run_dir(run_id) / "features.jsonl").exists())

    def test_recorded_evidence_satisfies_the_handoff_validator(self):
        run_id = self.start("--artifact-profile", "feature-specs")
        self.fill_from_example(run_id)
        r = self.sb.fde("features", "record", run_id, "--feature", "FEAT-012",
                        "--stage", "implementation", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        recorded = json.loads(r.stdout)
        ledger = (self.sb.run_dir(run_id) / "features.jsonl").read_text().splitlines()
        self.assertEqual(len(ledger), 1)

        run_dir = self.sb.run_dir(run_id)
        task = run_dir / "tasks" / "slice.md"
        task.write_text("Implement TASK-012-001 to TASK-012-004 and deliver docs/features/FEAT-012/.\n")
        sidecar = {
            "schemaVersion": 1, "runId": run_id, "taskId": "implement-slice",
            "objective": "Build the notification slice", "specialist": "implementation-engineer",
            "assignedIdentity": "claude_work", "stage": "implementation",
            "task": {"path": "tasks/slice.md", "sha256": hashlib.sha256(task.read_bytes()).hexdigest()},
            "requirementIds": recorded["requirementIds"],
            "inputEvidence": recorded["inputEvidence"],
            "acceptanceChecks": [{"requirementId": rid, "check": "see spec.md"}
                                 for rid in recorded["requirementIds"]],
            "permissions": {"tools": ["Read", "Edit"], "writePaths": ["docs/features/FEAT-012/"]},
            "ownedPaths": ["docs/features/FEAT-012/"], "reviewOnly": False,
            "output": {"path": "artifacts/implementation/implementation-task.md", "format": "markdown"},
            "budget": {"maxAttempts": 1, "maxSeconds": 600, "maxCostUnits": 1},
            "stopCondition": "all tasks done", "escalationCondition": "a requirement is unclear",
        }
        (run_dir / "tasks" / "slice.json").write_text(json.dumps(sidecar))
        v = self.sb.fde("handoff", "validate", run_id, "tasks/slice.json", "--json")
        self.assertEqual(v.returncode, 0, v.stdout + v.stderr)
        self.assertEqual(json.loads(v.stdout)["evidenceFiles"], 5)

    def test_scope_changes_after_a_handoff_need_reconciliation(self):
        run_id = self.start("--artifact-profile", "feature-specs")
        target = self.fill_from_example(run_id)
        args = ("features", "record", run_id, "--feature", "FEAT-012", "--stage", "planning")
        self.assertEqual(self.sb.fde(*args).returncode, 0)

        outcome = target / "verification.md"
        outcome.write_text(outcome.read_text().replace("- Result: not-run", "- Result: unavailable"))
        after_outcome = json.loads(self.sb.fde("features", "validate", run_id, "--feature",
                                               "FEAT-012", "--json").stdout)
        self.assertTrue(after_outcome["valid"])
        self.assertEqual(after_outcome["changedSinceHandoff"], ["verification.md"])

        spec = target / "spec.md"
        spec.write_text(spec.read_text().replace("- Priority: should", "- Priority: must"))
        moved = self.sb.fde("features", "validate", run_id, "--feature", "FEAT-012", "--json")
        self.assertEqual(moved.returncode, 1)
        self.assertIn("changed-since-handoff", codes(json.loads(moved.stdout), "error"))

        refused = self.sb.fde(*args)
        self.assertEqual(refused.returncode, 9)
        self.assertIn("--reconciled", refused.stderr)
        accepted = self.sb.fde(*args, "--reconciled", "PO agreed REQ-012-003 is a must", "--json")
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        record = json.loads(accepted.stdout)["record"]
        self.assertEqual(record["changedSinceLast"], ["spec.md", "verification.md"])
        self.assertIsNotNone(record["supersedes"])
        self.assertEqual(self.sb.fde("features", "validate", run_id, "--feature", "FEAT-012").returncode, 0)

        latest = self.status(run_id)["features"]["features"][0]["latestHandoff"]
        self.assertEqual(latest["recordId"], record["recordId"])

    def test_record_does_not_touch_controller_plan_or_approvals(self):
        run_id = self.start("--artifact-profile", "feature-specs")
        self.fill_from_example(run_id)
        run_dir = self.sb.run_dir(run_id)
        plan_before = (run_dir / "plan.json").read_bytes()
        self.assertEqual(self.sb.fde("features", "record", run_id, "--feature", "FEAT-012",
                                     "--stage", "planning").returncode, 0)
        self.assertEqual((run_dir / "plan.json").read_bytes(), plan_before)
        self.assertFalse((run_dir / "approvals.jsonl").exists()
                         and "feature" in (run_dir / "approvals.jsonl").read_text())

    def test_record_needs_a_planned_stage(self):
        r = self.sb.fde("start", "x", "--orchestrator", "claude_alt", "--shape", "research",
                        "--artifact-profile", "feature-specs")
        run_id = next(l.split()[1] for l in r.stdout.splitlines() if l.startswith("run "))
        self.fill_from_example(run_id)
        r = self.sb.fde("features", "record", run_id, "--feature", "FEAT-012", "--stage", "planning")
        self.assertEqual(r.returncode, 5)


if __name__ == "__main__":
    unittest.main()
