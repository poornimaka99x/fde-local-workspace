"""Acceptance tests for the controller contracts the local GUI depends on.

Projects, run grouping, input attachments and the machine-readable JSON views.
Every test runs against a throwaway HOME built by the Sandbox in test_fde.py:
nothing here reads or writes the operator's real ~/.claude-shared, profiles,
credentials or runs.

  python3 -m unittest discover -s tests -v
"""
import hashlib
import json
import os
import pathlib
import shutil
import unittest

from test_fde import FDETest


class ProjectTest(FDETest):
    """Helpers shared by everything below."""

    def create_project(self, name="Returns modernisation", description=None, repos=()):
        args = ["project", "create", "--name", name]
        if description:
            args += ["--description", description]
        for repo in repos:
            args += ["--repo", str(repo)]
        result = self.sb.fde(*args, "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)["project"]

    def json_of(self, *args, **envkw):
        """Run a JSON view and prove stdout carried nothing but JSON."""
        result = self.sb.fde(*args, "--json", **envkw)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)


# -- the project registry ----------------------------------------------------

class TestProjectRegistry(ProjectTest):
    def test_create_writes_a_versioned_controller_owned_record(self):
        project = self.create_project(description="Store and web returns",
                                      repos=[self.sb.repo])
        self.assertEqual(project["schemaVersion"], 1)
        self.assertTrue(project["projectId"].startswith("returns-modernisation-"))
        self.assertEqual(project["name"], "Returns modernisation")
        self.assertEqual(project["repoPaths"], [str(self.sb.repo.resolve())])
        self.assertEqual(project["createdAt"], project["updatedAt"])

        registry = self.sb.shared / "projects" / project["projectId"]
        self.assertTrue(registry.is_dir(), "the registry lives under the FDE root")
        on_disk = json.loads((registry / "project.json").read_text())
        self.assertEqual(on_disk, project)

        events = [json.loads(line) for line in
                  (registry / "events.jsonl").read_text().splitlines() if line.strip()]
        self.assertEqual([e["event"] for e in events], ["project.created"])

    def test_project_ids_are_unique_even_for_the_same_name(self):
        first = self.create_project()
        second = self.create_project()
        self.assertNotEqual(first["projectId"], second["projectId"])
        self.assertEqual(first["name"], second["name"])

    def test_a_project_needs_a_name(self):
        result = self.sb.fde("project", "create", "--name", "   ")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("needs a name", result.stderr)

    def test_repository_paths_must_exist_and_be_directories(self):
        missing = self.sb.fde("project", "create", "--name", "P",
                              "--repo", str(self.sb.tmp / "nope"))
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("does not exist", missing.stderr)

        afile = self.sb.tmp / "a-file.txt"
        afile.write_text("x")
        not_a_dir = self.sb.fde("project", "create", "--name", "P", "--repo", str(afile))
        self.assertNotEqual(not_a_dir.returncode, 0)
        self.assertIn("not a directory", not_a_dir.stderr)

    def test_repository_paths_are_resolved_and_absolute(self):
        link = self.sb.tmp / "repo-link"
        link.symlink_to(self.sb.repo)
        project = self.create_project(repos=[link])
        self.assertEqual(project["repoPaths"], [str(self.sb.repo.resolve())])

    def test_update_changes_the_record_and_appends_an_event(self):
        project = self.create_project(repos=[self.sb.repo])
        updated = json.loads(self.sb.fde(
            "project", "update", project["projectId"],
            "--name", "Returns", "--description", "narrowed",
            "--repo", str(self.sb.outside), "--json").stdout)["project"]
        self.assertEqual(updated["name"], "Returns")
        self.assertEqual(updated["description"], "narrowed")
        self.assertEqual(updated["repoPaths"], [str(self.sb.outside.resolve())])
        self.assertEqual(updated["createdAt"], project["createdAt"])
        self.assertNotEqual(updated["updatedAt"], "")

        events = [json.loads(line) for line in
                  (self.sb.shared / "projects" / project["projectId"] /
                   "events.jsonl").read_text().splitlines() if line.strip()]
        self.assertEqual([e["event"] for e in events],
                         ["project.created", "project.updated"])

    def test_update_needs_something_to_change(self):
        project = self.create_project()
        result = self.sb.fde("project", "update", project["projectId"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("nothing to update", result.stderr)

    def test_delete_moves_only_unused_project_metadata_to_recoverable_trash(self):
        project = self.create_project(repos=[self.sb.repo])
        project_id = project["projectId"]
        registry = self.sb.shared / "projects" / project_id

        result = self.sb.fde("project", "delete", project_id,
                             "--confirm", project_id, "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        deleted = json.loads(result.stdout)["deletedProject"]
        self.assertEqual(deleted["projectId"], project_id)
        self.assertTrue(deleted["recoverable"])
        self.assertFalse(registry.exists())
        self.assertTrue(self.sb.repo.is_dir(), "recorded repositories are never deleted")

        trashed = list((self.sb.shared / "projects" / ".trash").iterdir())
        self.assertEqual(len(trashed), 1)
        self.assertEqual(json.loads((trashed[0] / "project.json").read_text())["projectId"],
                         project_id)
        events = [json.loads(line) for line in
                  (trashed[0] / "events.jsonl").read_text().splitlines() if line.strip()]
        self.assertEqual(events[-1]["event"], "project.deleted")

    def test_delete_requires_the_exact_project_id_confirmation(self):
        project = self.create_project()
        result = self.sb.fde("project", "delete", project["projectId"],
                             "--confirm", "some-other-project")
        self.assertEqual(result.returncode, 2)
        self.assertIn("exact project id", result.stderr)
        self.assertTrue((self.sb.shared / "projects" / project["projectId"]).is_dir())

    def test_delete_refuses_projects_referenced_by_runs_or_chats(self):
        with_run = self.create_project(name="Project with run")
        started = self.sb.fde("start", "MAX-delete-guard", "--orchestrator", "work",
                              "--project", with_run["projectId"])
        self.assertEqual(started.returncode, 0, started.stderr)
        refused_run = self.sb.fde("project", "delete", with_run["projectId"],
                                  "--confirm", with_run["projectId"])
        self.assertEqual(refused_run.returncode, 5)
        self.assertIn("1 run(s)", refused_run.stderr)

        with_chat = self.create_project(name="Project with chat")
        chats = self.sb.shared / "chats"
        chats.mkdir(parents=True)
        (chats / "chat-20260907-abcdef12.json").write_text(json.dumps({
            "chatId": "chat-20260907-abcdef12", "projectId": with_chat["projectId"]
        }))
        refused_chat = self.sb.fde("project", "delete", with_chat["projectId"],
                                   "--confirm", with_chat["projectId"])
        self.assertEqual(refused_chat.returncode, 5)
        self.assertIn("1 chat(s)", refused_chat.stderr)

    def test_unknown_and_malformed_project_ids_are_refused(self):
        unknown = self.sb.fde("project", "show", "no-such-project-1234", "--json")
        self.assertEqual(unknown.returncode, 4)
        self.assertEqual(unknown.stdout, "")
        self.assertIn("no such project", unknown.stderr)

        traversal = self.sb.fde("project", "show", "../../etc")
        self.assertEqual(traversal.returncode, 2)
        self.assertIn("invalid project id", traversal.stderr)

    def test_a_malformed_project_json_is_reported_not_hidden(self):
        project = self.create_project()
        (self.sb.shared / "projects" / project["projectId"] /
         "project.json").write_text("{ not json")
        listing = self.json_of("projects")
        self.assertEqual(listing["projects"], [])
        self.assertTrue(any("malformed" in w for w in listing["warnings"]))

    def test_the_registry_stays_inside_the_temporary_home(self):
        self.create_project()
        self.assertTrue(str(self.sb.shared).startswith(str(self.sb.tmp)))
        real = pathlib.Path(os.path.expanduser("~/.claude-shared/projects"))
        if real.exists():
            self.assertFalse(any(p.name.startswith("returns-modernisation-")
                                 for p in real.iterdir()))


# -- runs grouped under a project -------------------------------------------

class TestRunProjectLinkage(ProjectTest):
    def test_start_project_records_the_project_on_the_run(self):
        project = self.create_project()
        result = self.sb.fde("start", "MAX-1 returns", "--orchestrator", "work",
                             "--project", project["projectId"])
        self.assertEqual(result.returncode, 0, result.stderr)
        run_id = next(l.split()[1] for l in result.stdout.splitlines()
                      if l.startswith("run "))
        manifest = json.loads((self.sb.run_dir(run_id) / "manifest.json").read_text())
        self.assertEqual(manifest["projectId"], project["projectId"])

        shown = self.json_of("project", "show", project["projectId"])
        self.assertEqual([r["runId"] for r in shown["runs"]], [run_id])
        self.assertEqual(shown["project"]["runCount"], 1)
        self.assertIn("run.created", [e["event"] for e in shown["events"]])

    def test_legacy_runs_without_a_project_are_unassigned(self):
        self.create_project()
        run_id = self.sb.start("MAX-2 legacy run")
        manifest = json.loads((self.sb.run_dir(run_id) / "manifest.json").read_text())
        self.assertIsNone(manifest["projectId"])

        listing = self.json_of("projects")
        self.assertEqual(listing["unassignedRunCount"], 1)
        self.assertEqual(listing["projects"][0]["runCount"], 0)
        self.assertIsNone(self.json_of("list")["runs"][0]["projectId"])

    def test_an_unknown_project_creates_no_run(self):
        before = list((self.sb.shared / "runs").iterdir())
        result = self.sb.fde("start", "MAX-3", "--project", "not-a-project-9999")
        self.assertEqual(result.returncode, 4)
        self.assertIn("no such project", result.stderr)
        self.assertEqual(list((self.sb.shared / "runs").iterdir()), before)

    def test_updating_a_project_does_not_rewrite_run_events(self):
        project = self.create_project()
        result = self.sb.fde("start", "MAX-4", "--orchestrator", "work",
                             "--project", project["projectId"])
        run_id = next(l.split()[1] for l in result.stdout.splitlines()
                      if l.startswith("run "))
        before = (self.sb.run_dir(run_id) / "events.jsonl").read_text()
        self.sb.fde("project", "update", project["projectId"], "--name", "Renamed")
        self.assertEqual((self.sb.run_dir(run_id) / "events.jsonl").read_text(), before)

    def test_delete_moves_the_complete_run_to_recoverable_trash(self):
        project = self.create_project()
        result = self.sb.fde("start", "MAX-5 old run", "--orchestrator", "work",
                             "--project", project["projectId"])
        self.assertEqual(result.returncode, 0, result.stderr)
        run_id = next(l.split()[1] for l in result.stdout.splitlines()
                      if l.startswith("run "))
        run_dir = self.sb.run_dir(run_id)
        evidence = run_dir / "artifacts" / "research" / "keep.md"
        evidence.write_text("recoverable evidence")

        deleted = self.sb.fde("delete", run_id, "--confirm", run_id, "--json")
        self.assertEqual(deleted.returncode, 0, deleted.stderr)
        payload = json.loads(deleted.stdout)["deletedRun"]
        self.assertEqual(payload["runId"], run_id)
        self.assertEqual(payload["projectId"], project["projectId"])
        self.assertTrue(payload["recoverable"])
        self.assertFalse(run_dir.exists())

        trashed = list((self.sb.shared / "runs" / ".trash").iterdir())
        self.assertEqual(len(trashed), 1)
        self.assertEqual((trashed[0] / "artifacts" / "research" / "keep.md").read_text(),
                         "recoverable evidence")
        events = [json.loads(line) for line in
                  (trashed[0] / "events.jsonl").read_text().splitlines() if line.strip()]
        self.assertEqual(events[-1]["event"], "run.deleted")
        self.assertEqual(self.json_of("project", "show", project["projectId"])
                         ["project"]["runCount"], 0)
        project_events = self.json_of("project", "show", project["projectId"])["events"]
        self.assertEqual(project_events[-1]["event"], "run.deleted")

    def test_delete_requires_exact_confirmation_and_preserves_the_run_on_refusal(self):
        run_id = self.sb.start("MAX-delete-confirm")
        refused = self.sb.fde("delete", run_id, "--confirm", "a-different-run")
        self.assertEqual(refused.returncode, 2)
        self.assertIn("exact run id", refused.stderr)
        self.assertTrue(self.sb.run_dir(run_id).is_dir())


# -- attachments -------------------------------------------------------------

class TestAttachments(ProjectTest):
    def attach_source(self, name="requirements.pdf", body=b"a requirement document"):
        source = self.sb.tmp / name
        source.write_bytes(body)
        return source, hashlib.sha256(body).hexdigest()

    def test_a_file_is_copied_hashed_and_recorded(self):
        run_id = self.sb.start("MAX-5 attach")
        source, digest = self.attach_source()
        record = self.json_of("attach", run_id, str(source))["attachment"]

        self.assertEqual(record["schemaVersion"], 1)
        self.assertEqual(record["runId"], run_id)
        self.assertEqual(record["originalName"], "requirements.pdf")
        self.assertEqual(record["mediaType"], "application/pdf")
        self.assertEqual(record["sha256"], digest)
        self.assertEqual(record["size"], source.stat().st_size)
        self.assertTrue(record["relativePath"].startswith("inputs/files/"))
        self.assertNotEqual(record["storedName"], record["originalName"],
                            "stored names are collision-resistant, not caller-chosen")

        stored = self.sb.run_dir(run_id) / record["relativePath"]
        self.assertEqual(stored.read_bytes(), source.read_bytes())
        self.assertTrue(source.is_file(), "the source is copied, never moved")

        ledger = [json.loads(line) for line in
                  (self.sb.run_dir(run_id) / "inputs" / "attachments.jsonl")
                  .read_text().splitlines() if line.strip()]
        self.assertEqual(ledger, [record])

        events = [json.loads(line) for line in
                  (self.sb.run_dir(run_id) / "events.jsonl").read_text().splitlines()
                  if line.strip()]
        added = [e for e in events if e["event"] == "attachment.added"]
        self.assertEqual(len(added), 1)
        self.assertEqual(added[0]["sha256"], digest)

    def test_stdin_upload_names_can_never_become_paths(self):
        run_id = self.sb.start("MAX-6 upload")
        result = self.sb.fde("attach", run_id, "--stdin", "--name",
                             "../../etc/pass wd.pdf", "--json", stdin="payload")
        self.assertEqual(result.returncode, 0, result.stderr)
        record = json.loads(result.stdout)["attachment"]
        self.assertEqual(record["originalName"], "pass-wd.pdf")
        self.assertEqual(record["source"], "stdin")

        stored = self.sb.run_dir(run_id) / record["relativePath"]
        self.assertEqual(stored.read_bytes(), b"payload")
        self.assertEqual(stored.resolve().parent,
                         (self.sb.run_dir(run_id) / "inputs" / "files").resolve())
        self.assertFalse((self.sb.shared / "runs" / "etc").exists())
        self.assertFalse((self.sb.tmp / "etc").exists())

    def test_stdin_needs_a_name(self):
        run_id = self.sb.start("MAX-7")
        result = self.sb.fde("attach", run_id, "--stdin", stdin="x")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--name", result.stderr)

    def test_symlinked_sources_are_refused(self):
        run_id = self.sb.start("MAX-8")
        secret = self.sb.tmp / "secret.txt"
        secret.write_text("do not copy me")
        link = self.sb.tmp / "innocent.txt"
        link.symlink_to(secret)
        result = self.sb.fde("attach", run_id, str(link))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlink", result.stderr)
        self.assertFalse((self.sb.run_dir(run_id) / "inputs" / "files").exists())

    def test_directories_and_devices_are_refused(self):
        run_id = self.sb.start("MAX-9")
        directory = self.sb.fde("attach", run_id, str(self.sb.repo))
        self.assertNotEqual(directory.returncode, 0)
        self.assertIn("directory", directory.stderr)
        if pathlib.Path("/dev/null").exists():
            device = self.sb.fde("attach", run_id, "/dev/null")
            self.assertNotEqual(device.returncode, 0)
            self.assertIn("non-regular", device.stderr)
        self.assertEqual(self.json_of("attachments", run_id)["attachments"], [])

    def test_oversize_attachments_are_refused_and_leave_nothing_behind(self):
        run_id = self.sb.start("MAX-10")
        source, _digest = self.attach_source(body=b"x" * 4096)
        result = self.sb.fde("attach", run_id, str(source), "--max-bytes", "16")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("limit", result.stderr)
        self.assertEqual(self.json_of("attachments", run_id)["attachments"], [])
        files_dir = self.sb.run_dir(run_id) / "inputs" / "files"
        self.assertFalse(files_dir.exists() and any(files_dir.iterdir()))

    def test_the_size_limit_is_configurable_downward_only(self):
        run_id = self.sb.start("MAX-11")
        source, _digest = self.attach_source(body=b"y" * 512)
        raised = self.sb.fde("attach", run_id, str(source),
                             "--max-bytes", "99999999999",
                             FDE_MAX_ATTACHMENT_BYTES="16")
        self.assertNotEqual(raised.returncode, 0,
                            "a caller must not raise a limit the environment lowered")
        self.assertIn("limit", raised.stderr)

    def test_stdin_uploads_are_truncated_at_the_limit_not_stored(self):
        run_id = self.sb.start("MAX-12")
        result = self.sb.fde("attach", run_id, "--stdin", "--name", "big.bin",
                             "--max-bytes", "8", stdin="x" * 4096)
        self.assertNotEqual(result.returncode, 0)
        files_dir = self.sb.run_dir(run_id) / "inputs" / "files"
        self.assertFalse(files_dir.exists() and any(files_dir.iterdir()))

    def test_records_are_append_only_and_malformed_lines_survive_reading(self):
        run_id = self.sb.start("MAX-13")
        source, _digest = self.attach_source()
        first = self.json_of("attach", run_id, str(source))["attachment"]
        ledger = self.sb.run_dir(run_id) / "inputs" / "attachments.jsonl"
        with ledger.open("a") as handle:
            handle.write('{"half a record"\n')
        second = self.json_of("attach", run_id, str(source))["attachment"]

        listing = self.json_of("attachments", run_id)
        self.assertEqual([a["attachmentId"] for a in listing["attachments"]],
                         [first["attachmentId"], second["attachmentId"]])
        self.assertEqual(len(listing["malformed"]), 1)
        self.assertEqual(listing["malformed"][0]["line"], 2)
        self.assertIn("half a record", listing["malformed"][0]["raw"])
        self.assertIn('{"half a record"', ledger.read_text())

    def test_attaching_to_an_unknown_run_fails(self):
        source, _digest = self.attach_source()
        result = self.sb.fde("attach", "no-such-run", str(source))
        self.assertEqual(result.returncode, 4)
        self.assertIn("no such run", result.stderr)


# -- the JSON views ----------------------------------------------------------

class TestJsonViews(ProjectTest):
    def test_json_mode_writes_only_json_to_stdout(self):
        run_id = self.sb.start("MAX-20 json")
        for args in (("list",), ("status", run_id), ("projects",),
                     ("attachments", run_id)):
            result = self.sb.fde(*args, "--json")
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["schemaVersion"], 1, args)

    def test_unknown_runs_exit_nonzero_with_empty_stdout(self):
        result = self.sb.fde("status", "no-such-run", "--json")
        self.assertEqual(result.returncode, 4)
        self.assertEqual(result.stdout, "")

    def test_status_json_carries_what_the_console_needs(self):
        project = self.create_project(repos=[self.sb.repo])
        start = self.sb.fde("start", "MAX-21 returns research", "--orchestrator", "work",
                            "--project", project["projectId"])
        run_id = next(l.split()[1] for l in start.stdout.splitlines()
                      if l.startswith("run "))
        self.sb.plan(run_id, "intake", "research")
        self.sb.fde("roles", run_id, "--set", "research=claude_work",
                    "--set", "productManagement=none", "--set", "microsoftContext=none")
        source = self.sb.tmp / "brief.md"
        source.write_text("# brief\n")
        self.sb.fde("attach", run_id, str(source))

        payload = self.json_of("status", run_id)
        self.assertEqual(payload["runId"], run_id)
        self.assertEqual(payload["projectId"], project["projectId"])
        self.assertEqual(payload["project"]["repoPaths"], [str(self.sb.repo.resolve())])
        self.assertEqual(payload["state"], "roles_confirmed")
        self.assertEqual(payload["requirement"]["jiraKey"], "MAX-21")
        self.assertTrue(payload["requirement"]["hasFile"])
        self.assertEqual(payload["plan"]["stages"], ["intake", "research"])
        self.assertEqual([s["stage"] for s in payload["stageTimeline"]],
                         ["intake", "research"])
        self.assertTrue(payload["roles"]["confirmed"])
        self.assertEqual(payload["roles"]["orchestrator"]["agentId"], "claude_work")
        research = next(r for r in payload["roles"]["assignments"]
                        if r["role"] == "research")
        self.assertEqual(research["label"], "Researcher(s)")
        self.assertEqual([a["label"] for a in research["assignees"]], ["Claude: work"])
        self.assertEqual(payload["approvals"], [])
        self.assertEqual(payload["checkpoints"], [])
        self.assertEqual(len(payload["attachments"]), 1)
        self.assertIsNone(payload["outputHygiene"])
        self.assertIn("research/research-brief.md",
                      [a["path"] for a in payload["artifacts"]["expected"]])
        self.assertTrue(payload["nextAction"])
        self.assertEqual(payload["warnings"], [])

    def test_events_are_paginated_and_bounded(self):
        run_id = self.sb.start("MAX-22 events")
        payload = self.json_of("status", run_id, "--events-limit", "2")
        page = payload["events"]
        self.assertEqual(page["limit"], 2)
        self.assertEqual(page["returned"], 2)
        self.assertGreater(page["total"], 2)
        self.assertEqual(page["offset"], page["total"] - 2)
        self.assertIsNone(page["nextCursor"], "the default page is the latest one")

        first = self.json_of("status", run_id, "--events-limit", "2",
                             "--events-cursor", "0")["events"]
        self.assertEqual(first["offset"], 0)
        self.assertEqual(first["nextCursor"], 2)
        self.assertEqual(first["items"][0]["event"], "run.created")

    def test_malformed_ledger_lines_warn_without_blanking_the_run(self):
        run_id = self.sb.start("MAX-23 malformed")
        events = self.sb.run_dir(run_id) / "events.jsonl"
        with events.open("a") as handle:
            handle.write('{"at": "2026-01-01", "event": "trunc\n')
        payload = self.json_of("status", run_id)
        self.assertTrue(any("events.jsonl line" in w for w in payload["warnings"]))
        self.assertTrue(payload["events"]["total"] >= 1)
        self.assertEqual(payload["state"], "awaiting_plan")

    def test_the_session_view_is_honest_about_each_orchestrator(self):
        claude_run = self.sb.start("MAX-24 claude", orchestrator="work")
        session = self.json_of("status", claude_run)["session"]
        self.assertEqual(session["provider"], "claude")
        self.assertEqual(session["profile"], "work")
        self.assertTrue(session["resumable"])
        self.assertIsNone(session["sessionId"])

        (self.sb.run_dir(claude_run) / "orchestrator-session-id").write_text(
            "0b9d6c2e-1f3a-4a5b-8c7d-9e0f1a2b3c4d\n")
        session = self.json_of("status", claude_run)["session"]
        self.assertEqual(session["sessionId"], "0b9d6c2e-1f3a-4a5b-8c7d-9e0f1a2b3c4d")

        (self.sb.run_dir(claude_run) / "orchestrator-session-id").write_text(
            "../../etc/passwd\n")
        session = self.json_of("status", claude_run)["session"]
        self.assertIsNone(session["sessionId"], "a session id is opaque, and checked")
        self.assertIn("malformed", session["resumeReason"])

        codex_run = self.sb.start("MAX-25 codex", orchestrator="codex")
        session = self.json_of("status", codex_run)["session"]
        self.assertEqual(session["provider"], "codex")
        self.assertFalse(session["resumable"])
        self.assertIsNone(session["sessionId"])
        self.assertEqual(session["resumeReason"],
                         "Resume this run in its original Codex task")

        fresh = self.sb.fde("start", "MAX-26 no orchestrator")
        no_orchestrator = next(l.split()[1] for l in fresh.stdout.splitlines()
                               if l.startswith("run "))
        session = self.json_of("status", no_orchestrator)["session"]
        self.assertFalse(session["resumable"])
        self.assertIsNone(session["provider"])

    def test_json_views_carry_no_secret_values(self):
        run_id = self.sb.start("MAX-27 secrets")
        secrets_env = {
            "CONFLUENCE_API_TOKEN": "confluence-token-must-not-appear",
            "COPILOT_DIRECTLINE_SECRET": "directline-secret-must-not-appear",
            "WATERMARKS_SERVER_API_KEY": "watermark-key-must-not-appear",
        }
        (self.sb.profiles / "work" / ".credentials.json").write_text(
            json.dumps({"accessToken": "credential-must-not-appear"}))
        for args in (("list",), ("status", run_id), ("projects",)):
            result = self.sb.fde(*args, "--json", **secrets_env)
            self.assertEqual(result.returncode, 0, result.stderr)
            for value in list(secrets_env.values()) + ["credential-must-not-appear"]:
                self.assertNotIn(value, result.stdout, args)

    def test_list_json_reports_state_project_and_resumability_per_run(self):
        project = self.create_project()
        start = self.sb.fde("start", "MAX-28 grouped", "--orchestrator", "work",
                            "--project", project["projectId"])
        run_id = next(l.split()[1] for l in start.stdout.splitlines()
                      if l.startswith("run "))
        row = next(r for r in self.json_of("list")["runs"] if r["runId"] == run_id)
        self.assertEqual(row["state"], "awaiting_plan")
        self.assertEqual(row["projectId"], project["projectId"])
        self.assertEqual(row["orchestrator"]["label"], "Claude: work")
        self.assertTrue(row["session"]["resumable"])
        self.assertEqual(row["requirement"], "MAX-28 grouped")

    def test_a_run_naming_an_unknown_project_warns_instead_of_failing(self):
        run_id = self.sb.start("MAX-29 orphan")
        manifest_path = self.sb.run_dir(run_id) / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["projectId"] = "deleted-project-0000"
        manifest_path.write_text(json.dumps(manifest, indent=2))
        payload = self.json_of("status", run_id)
        self.assertIsNone(payload["project"])
        self.assertTrue(any("deleted-project-0000" in w for w in payload["warnings"]))


# -- creating a run from a machine -------------------------------------------

class TestStartJson(ProjectTest):
    def start_json(self, *args, **kwargs):
        # --json goes first: everything after `--` is the ask, flags included.
        result = self.sb.fde("start", "--json", *args, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_start_json_returns_the_created_run_and_narrates_to_stderr(self):
        project = self.create_project()
        payload = self.start_json("MAX-60 returns research",
                                  "--orchestrator", "work",
                                  "--project", project["projectId"])
        self.assertEqual(payload["schemaVersion"], 1)
        run = payload["run"]
        self.assertEqual(run["projectId"], project["projectId"])
        self.assertEqual(run["requirement"], "MAX-60 returns research")
        self.assertEqual(run["jiraKey"], "MAX-60")
        self.assertEqual(run["state"], "awaiting_plan")
        self.assertEqual(run["orchestrator"]["agentId"], "claude_work")
        self.assertTrue(run["session"]["resumable"])
        self.assertTrue(payload["nextAction"])
        self.assertTrue((self.sb.run_dir(run["runId"]) / "manifest.json").is_file())

    def test_a_shape_is_recorded_without_confirming_roles(self):
        payload = self.start_json("MAX-61 research only",
                                  "--orchestrator", "work", "--shape", "research")
        run = payload["run"]
        self.assertEqual(run["stages"], ["intake", "research"])
        self.assertEqual(run["state"], "awaiting_roles")
        roles = json.loads((self.sb.run_dir(run["runId"]) / "roles.json").read_text())
        self.assertEqual(list(roles["assignments"]), ["orchestrator"])
        self.assertNotIn("confirmedAt", roles)

    def test_a_requirement_that_looks_like_a_flag_is_still_a_requirement(self):
        payload = self.start_json("--orchestrator", "work", "--",
                                  "--require-approval is part of my sentence")
        self.assertEqual(payload["run"]["requirement"],
                         "--require-approval is part of my sentence")

    def test_refusals_leave_stdout_empty(self):
        unknown = self.sb.fde("start", "MAX-62", "--project", "no-such-project", "--json")
        self.assertEqual(unknown.returncode, 4)
        self.assertEqual(unknown.stdout, "")

        cannot = self.sb.fde("start", "MAX-63", "--orchestrator", "gemini", "--json")
        self.assertNotEqual(cannot.returncode, 0)
        self.assertEqual(cannot.stdout, "")
        self.assertIn("cannot orchestrate", cannot.stderr)

    def test_the_human_output_of_start_is_unchanged(self):
        result = self.sb.fde("start", "MAX-64 human", "--orchestrator", "work")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Nothing has been read", result.stdout)
        self.assertNotIn("schemaVersion", result.stdout)


# -- a reader can ask what this controller speaks ----------------------------

class TestVersionContract(ProjectTest):
    def test_version_json_names_the_schema_and_the_contracts(self):
        payload = self.json_of("version")
        self.assertEqual(payload["schemaVersion"], 1)
        self.assertEqual(payload["toolkit"], "fde-core")
        for contract in ("list --json", "status --json", "projects --json",
                         "attach --stdin --name", "start --json"):
            self.assertIn(contract, payload["contracts"])

    def test_version_is_readable_by_a_person_too(self):
        result = self.sb.fde("version")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("schema 1", result.stdout)
        self.assertIn("contracts", result.stdout)
        self.assertNotIn("schemaVersion", result.stdout)


# -- containment: a run, a project and a ledger stay where they say they are --

class TestContainment(ProjectTest):
    def test_a_symlinked_run_directory_is_refused_everywhere(self):
        """A run that resolves elsewhere would make every later path check a lie."""
        elsewhere = self.sb.tmp / "elsewhere-run"
        (elsewhere / "artifacts").mkdir(parents=True)
        (elsewhere / "manifest.json").write_text(json.dumps({
            "runId": "20260101-planted-0000", "state": "research"}))
        (elsewhere / "secret.txt").write_text("not part of any run")
        link = self.sb.shared / "runs" / "20260101-planted-0000"
        link.symlink_to(elsewhere)

        for args in (("status", "20260101-planted-0000"),
                     ("status", "20260101-planted-0000", "--json"),
                     ("attachments", "20260101-planted-0000"),
                     ("brief", "20260101-planted-0000")):
            result = self.sb.fde(*args)
            self.assertEqual(result.returncode, 4, args)
            self.assertIn("symlink", result.stderr)
            self.assertEqual(result.stdout, "")

        self.assertNotIn("20260101-planted-0000", self.sb.fde("list").stdout)
        self.assertEqual(
            [r["runId"] for r in self.json_of("list")["runs"]
             if r["runId"] == "20260101-planted-0000"], [])

    def test_a_run_id_is_a_name_and_never_a_path(self):
        for run_id in ("../../etc", "..", "a/b", "."):
            result = self.sb.fde("status", run_id)
            self.assertIn(result.returncode, (2, 4), run_id)
            self.assertEqual(result.stdout, "", run_id)

    def test_a_run_resolving_outside_the_runs_root_is_refused(self):
        outside = self.sb.tmp / "outside-run"
        (outside).mkdir()
        (outside / "manifest.json").write_text('{"runId": "x", "state": "research"}')
        # A directory whose *parent* is not the runs root cannot be a run, even
        # when the id itself looks ordinary.
        nested = self.sb.shared / "runs" / "nested"
        nested.mkdir()
        deep = nested / "20260101-deep-0000"
        deep.mkdir()
        (deep / "manifest.json").write_text('{"runId": "y", "state": "research"}')
        result = self.sb.fde("status", "nested/20260101-deep-0000")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")

    def test_attachments_refuse_a_symlinked_destination(self):
        run_id = self.sb.start("MAX-40 symlinked inputs")
        source = self.sb.tmp / "payload.txt"
        source.write_text("payload")
        target = self.sb.tmp / "escape-target"
        target.mkdir()

        files_dir = self.sb.run_dir(run_id) / "inputs" / "files"
        files_dir.mkdir(parents=True, exist_ok=True)
        files_dir.rmdir()
        files_dir.symlink_to(target)

        result = self.sb.fde("attach", run_id, str(source))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("attachment refused", result.stderr)
        self.assertEqual(list(target.iterdir()), [],
                         "bytes were written through a symlinked destination")

    def test_attachments_refuse_a_symlinked_inputs_directory(self):
        run_id = self.sb.start("MAX-41 symlinked inputs parent")
        source = self.sb.tmp / "payload2.txt"
        source.write_text("payload")
        target = self.sb.tmp / "escape-parent"
        target.mkdir()

        inputs = self.sb.run_dir(run_id) / "inputs"
        shutil.rmtree(inputs)
        inputs.symlink_to(target)

        result = self.sb.fde("attach", run_id, str(source))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(target.iterdir()), [])

    def test_a_project_record_cannot_name_a_different_project(self):
        victim = self.create_project(name="Victim project")
        poisoned = self.create_project(name="Poisoned project")
        record = self.sb.shared / "projects" / poisoned["projectId"] / "project.json"
        data = json.loads(record.read_text())
        data["projectId"] = victim["projectId"]
        record.write_text(json.dumps(data))

        for args in (("project", "show", poisoned["projectId"]),
                     ("project", "update", poisoned["projectId"], "--name", "Renamed")):
            result = self.sb.fde(*args)
            self.assertEqual(result.returncode, 4, args)
            self.assertIn("refusing", result.stderr)

        untouched = json.loads(
            (self.sb.shared / "projects" / victim["projectId"] / "project.json").read_text())
        self.assertEqual(untouched["name"], "Victim project")

    def test_a_project_id_that_is_a_path_is_refused(self):
        project = self.create_project()
        record = self.sb.shared / "projects" / project["projectId"] / "project.json"
        data = json.loads(record.read_text())
        data["projectId"] = "../../../etc"
        record.write_text(json.dumps(data))
        result = self.sb.fde("project", "update", project["projectId"], "--name", "x")
        self.assertEqual(result.returncode, 4)

    def test_a_manifest_project_id_is_data_not_a_path(self):
        run_id = self.sb.start("MAX-42 poisoned manifest")
        manifest_path = self.sb.run_dir(run_id) / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["projectId"] = "../../../../etc"
        manifest_path.write_text(json.dumps(manifest))

        payload = self.json_of("status", run_id)
        self.assertIsNone(payload["project"])
        self.assertIsNone(payload["projectId"])
        self.assertTrue(any("not a usable project id" in w for w in payload["warnings"]))

    def test_valid_json_of_the_wrong_shape_is_malformed_not_fatal(self):
        """A bare string or list is JSON. It is not a record."""
        run_id = self.sb.start("MAX-43 wrong shape")
        for name in ("events.jsonl", "approvals.jsonl", "checkpoints.jsonl"):
            with (self.sb.run_dir(run_id) / name).open("a") as handle:
                handle.write('"just a string"\n')
                handle.write('null\n')
                handle.write('[1, 2, 3]\n')
        with (self.sb.run_dir(run_id) / "inputs" / "attachments.jsonl").open("a") as handle:
            handle.write('42\n')

        payload = self.json_of("status", run_id)
        self.assertEqual(payload["state"], "awaiting_plan")
        self.assertGreaterEqual(
            len([w for w in payload["warnings"] if "malformed" in w]), 4)
        self.assertEqual(payload["approvals"], [])
        self.assertEqual(payload["checkpoints"], [])

        human = self.sb.fde("status", run_id)
        self.assertEqual(human.returncode, 0, human.stderr)
        self.assertNotIn("Traceback", human.stderr)

        listing = self.sb.fde("attachments", run_id)
        self.assertEqual(listing.returncode, 0, listing.stderr)


# -- the human commands are unchanged ---------------------------------------

class TestBackwardCompatibility(ProjectTest):
    def test_human_list_and_status_are_unchanged(self):
        run_id = self.sb.start("MAX-30 human output")
        listing = self.sb.fde("list")
        self.assertEqual(listing.returncode, 0, listing.stderr)
        self.assertIn(run_id, listing.stdout)
        self.assertNotIn("schemaVersion", listing.stdout)

        status = self.sb.fde("status", run_id)
        self.assertEqual(status.returncode, 0, status.stderr)
        for line in ("run        ", "state      ", "plan", "roles", "artifacts",
                     "approvals", "checkpoints", "output hygiene", "next"):
            self.assertIn(line, status.stdout)
        self.assertNotIn("schemaVersion", status.stdout)

    def test_empty_projects_and_attachments_say_so_in_human_mode(self):
        run_id = self.sb.start("MAX-31 empty")
        self.assertIn("no projects yet", self.sb.fde("projects").stdout)
        self.assertIn("no attachments", self.sb.fde("attachments", run_id).stdout)

    def test_start_without_a_project_still_prints_the_orchestrator_question(self):
        result = self.sb.fde("start")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Who orchestrates this run?", result.stdout)
        self.assertIn("Nothing has been read", result.stdout)


if __name__ == "__main__":
    unittest.main()
