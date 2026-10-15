"""A run's working folder: the directory its orchestrator session starts in.

Runs against the throwaway HOME built by the Sandbox in test_fde.py.

  python3 -m unittest discover -s tests -p 'test_fde_workdir.py'
"""
import json
import unittest

from test_fde_projects import ProjectTest


class TestWorkingFolder(ProjectTest):
    def start_json(self, *args, **kwargs):
        result = self.sb.fde("start", "--json", *args, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def manifest(self, run_id):
        return json.loads((self.sb.run_dir(run_id) / "manifest.json").read_text())

    def test_start_records_a_resolved_working_folder(self):
        link = self.sb.tmp / "repo-link"
        link.symlink_to(self.sb.repo)
        run = self.start_json("--orchestrator", "work", "--workdir", str(link),
                              "--", "tidy the assignment")["run"]
        resolved = str(self.sb.repo.resolve())
        self.assertEqual(run["workingDir"], resolved)
        self.assertEqual(self.manifest(run["runId"])["workingDir"], resolved)
        status = self.json_of("status", run["runId"])
        self.assertEqual(status["workingDir"], resolved)
        events = [e["event"] for e in status["events"]["items"]]
        self.assertIn("workdir.set", events)

    def test_a_run_without_one_is_recorded_exactly_as_before(self):
        run = self.start_json("--orchestrator", "work", "--", "plain run")["run"]
        self.assertIsNone(run["workingDir"])
        self.assertNotIn("workingDir", self.manifest(run["runId"]))

    def test_unusable_folders_create_no_run(self):
        afile = self.sb.tmp / "a-file.txt"
        afile.write_text("x")
        cases = {
            str(self.sb.tmp / "nope"): "does not exist",
            str(afile): "not a directory",
            "relative/path": "absolute",
            "/": "too broad",
            str(self.sb.home): "too broad",
        }
        before = sorted(p.name for p in (self.sb.shared / "runs").iterdir())
        for folder, message in cases.items():
            result = self.sb.fde("start", "--orchestrator", "work", "--workdir", folder,
                                 "--", "x")
            self.assertNotEqual(result.returncode, 0, folder)
            self.assertIn(message, result.stderr, folder)
        after = sorted(p.name for p in (self.sb.shared / "runs").iterdir())
        self.assertEqual(before, after)

    def test_workdir_shows_sets_changes_and_clears(self):
        run_id = self.start_json("--orchestrator", "work", "--", "x")["run"]["runId"]
        self.assertIsNone(self.json_of("workdir", run_id)["workingDir"])

        first = self.json_of("workdir", run_id, str(self.sb.repo))
        self.assertTrue(first["changed"])
        self.assertEqual(first["workingDir"], str(self.sb.repo.resolve()))

        same = self.json_of("workdir", run_id, str(self.sb.repo))
        self.assertFalse(same["changed"])

        moved = self.json_of("workdir", run_id, str(self.sb.outside))
        self.assertEqual(moved["previous"], str(self.sb.repo.resolve()))
        self.assertEqual(self.manifest(run_id)["workingDir"], str(self.sb.outside.resolve()))

        cleared = self.json_of("workdir", run_id, "--clear")
        self.assertIsNone(cleared["workingDir"])
        self.assertNotIn("workingDir", self.manifest(run_id))

    def test_an_orchestrator_session_cannot_move_its_own_folder(self):
        run_id = self.start_json("--orchestrator", "work", "--", "x")["run"]["runId"]
        result = self.sb.fde("workdir", run_id, str(self.sb.repo), FDE_RUN_ID=run_id)
        self.assertEqual(result.returncode, 6, result.stderr)
        self.assertIn("operator's choice", result.stderr)
        self.assertNotIn("workingDir", self.manifest(run_id))
        # Reading it is fine.
        self.assertEqual(self.sb.fde("workdir", run_id, FDE_RUN_ID=run_id).returncode, 0)

    def test_a_malformed_recorded_value_is_ignored_not_used(self):
        run_id = self.start_json("--orchestrator", "work", "--", "x")["run"]["runId"]
        path = self.sb.run_dir(run_id) / "manifest.json"
        doc = json.loads(path.read_text())
        doc["workingDir"] = "relative/../../etc"
        path.write_text(json.dumps(doc))
        self.assertIsNone(self.json_of("status", run_id)["workingDir"])


if __name__ == "__main__":
    unittest.main()
