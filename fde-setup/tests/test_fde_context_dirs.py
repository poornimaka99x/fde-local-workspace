"""Folders attached to a run as context: granted to the session in place.

Runs against the throwaway HOME built by the Sandbox in test_fde.py.

  python3 -m unittest discover -s tests -p 'test_fde_context_dirs.py'
"""
import json
import unittest

from test_fde_projects import ProjectTest


class TestContextFolders(ProjectTest):
    def start_json(self, *args, **kwargs):
        result = self.sb.fde("start", "--json", *args, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def manifest(self, run_id):
        return json.loads((self.sb.run_dir(run_id) / "manifest.json").read_text())

    def test_start_records_resolved_deduplicated_folders(self):
        link = self.sb.tmp / "repo-link"
        link.symlink_to(self.sb.repo)
        run = self.start_json("--orchestrator", "work",
                              "--context-dir", str(link),
                              "--context-dir", str(self.sb.repo),
                              "--context-dir", str(self.sb.outside),
                              "--", "review the attached designs")["run"]
        expected = [str(self.sb.repo.resolve()), str(self.sb.outside.resolve())]
        self.assertEqual(run["contextDirs"], expected)
        self.assertEqual(self.manifest(run["runId"])["contextDirs"], expected)
        status = self.json_of("status", run["runId"])
        self.assertEqual(status["contextDirs"], expected)
        events = [e for e in status["events"]["items"] if e["event"] == "contextdir.added"]
        self.assertEqual(len(events), 2)

    def test_a_run_without_any_is_recorded_exactly_as_before(self):
        run = self.start_json("--orchestrator", "work", "--", "plain run")["run"]
        self.assertEqual(run["contextDirs"], [])
        self.assertNotIn("contextDirs", self.manifest(run["runId"]))

    def test_unusable_or_private_folders_create_no_run(self):
        afile = self.sb.tmp / "a-file.txt"
        afile.write_text("x")
        ssh = self.sb.home / ".ssh"
        ssh.mkdir(exist_ok=True)
        cases = {
            str(self.sb.tmp / "nope"): "does not exist",
            str(afile): "not a directory",
            "relative/path": "absolute",
            "/": "too broad",
            str(self.sb.home): "too broad",
            str(ssh): "credential",
            str(self.sb.shared): "credential",
        }
        before = sorted(p.name for p in (self.sb.shared / "runs").iterdir())
        for folder, message in cases.items():
            result = self.sb.fde("start", "--orchestrator", "work",
                                 "--context-dir", folder, "--", "x")
            self.assertNotEqual(result.returncode, 0, folder)
            self.assertIn(message, result.stderr, folder)
        after = sorted(p.name for p in (self.sb.shared / "runs").iterdir())
        self.assertEqual(before, after)

    def test_context_dirs_shows_adds_removes_and_clears(self):
        run_id = self.start_json("--orchestrator", "work", "--", "x")["run"]["runId"]
        self.assertEqual(self.json_of("context-dirs", run_id)["contextDirs"], [])

        added = self.json_of("context-dirs", run_id, "--add", str(self.sb.repo),
                             "--add", str(self.sb.outside))
        self.assertTrue(added["changed"])
        self.assertEqual(len(added["contextDirs"]), 2)

        again = self.json_of("context-dirs", run_id, "--add", str(self.sb.repo))
        self.assertFalse(again["changed"])

        removed = self.json_of("context-dirs", run_id, "--remove", str(self.sb.repo))
        self.assertEqual(removed["removed"], [str(self.sb.repo.resolve())])
        self.assertEqual(self.manifest(run_id)["contextDirs"],
                         [str(self.sb.outside.resolve())])

        cleared = self.json_of("context-dirs", run_id, "--clear")
        self.assertEqual(cleared["contextDirs"], [])
        self.assertNotIn("contextDirs", self.manifest(run_id))

    def test_an_orchestrator_session_cannot_widen_its_own_access(self):
        run_id = self.start_json("--orchestrator", "work", "--", "x")["run"]["runId"]
        result = self.sb.fde("context-dirs", run_id, "--add", str(self.sb.repo),
                             FDE_RUN_ID=run_id)
        self.assertEqual(result.returncode, 6, result.stderr)
        self.assertNotIn("contextDirs", self.manifest(run_id))

    def test_a_malformed_recorded_value_is_ignored_not_used(self):
        run_id = self.start_json("--orchestrator", "work", "--", "x")["run"]["runId"]
        manifest = self.manifest(run_id)
        manifest["contextDirs"] = ["relative/x", 7, str(self.sb.repo)]
        (self.sb.run_dir(run_id) / "manifest.json").write_text(json.dumps(manifest))
        self.assertEqual(self.json_of("context-dirs", run_id)["contextDirs"],
                         [str(self.sb.repo)])


if __name__ == "__main__":
    unittest.main()
