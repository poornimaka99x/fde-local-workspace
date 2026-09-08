"""Acceptance coverage for AI provider accounts.

Every test runs against a throwaway HOME with a synthetic install. Nothing here
touches the operator's real ~/.claude-profiles, ~/.codex-profiles, keychain or
Antigravity sign-in: every per-account directory is redirected by the same
override variables the provider templates declare.

  python3 -m unittest tests.test_fde_accounts -v
"""
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FDE = ROOT / "claude-shared" / "bin" / "fde"
AGENTS = ROOT / "claude-shared" / "config" / "agents.json"
TEMPLATES = ROOT / "claude-shared" / "config" / "provider-templates.json"


class AccountsBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.shared = self.home / ".claude-shared"
        (self.shared / "config").mkdir(parents=True)
        shutil.copy2(AGENTS, self.shared / "config" / "agents.json")
        shutil.copy2(TEMPLATES, self.shared / "config" / "provider-templates.json")
        self.profiles = self.home / ".claude-profiles"
        # claude_work is the orchestrator these tests start runs with, so its
        # profile directory has to exist — availability is about the local
        # surface, and the surface is what a test must set deliberately.
        (self.profiles / "work").mkdir(parents=True)
        (self.profiles / "work" / ".credentials.json").write_text("{}")
        self.codex = self.home / ".codex-profiles"
        self.copilot = self.home / ".fde-copilot"
        self.bin = self.home / "bin"
        self.bin.mkdir()
        # The shipped work identity is the orchestrator in lifecycle tests.
        # Give it a deterministic local surface without inheriting any real
        # provider CLIs from the developer machine.
        claude = self.bin / "claude"
        claude.write_text("#!/usr/bin/env bash\nexit 0\n")
        claude.chmod(0o755)
        self.env = dict(os.environ)
        self.env.update({
            "HOME": str(self.home),
            "CLAUDE_SHARED": str(self.shared),
            "CLAUDE_PROFILES_DIR": str(self.profiles),
            "FDE_CODEX_PROFILES_DIR": str(self.codex),
            "FDE_COPILOT_PROFILES_DIR": str(self.copilot),
            "FDE_RUNS_DIR": str(self.shared / "runs"),
            # Provider availability must be deterministic. Inheriting the
            # developer machine's PATH makes a locally installed codex/agy
            # defeat tests whose whole premise is that the CLI is absent.
            "PATH": f"{self.bin}:/usr/bin:/bin",
        })
        # No inherited Copilot credential may leak into a test's answer.
        for name in ("COPILOT_DIRECTLINE_SECRET", "COPILOT_TOKEN_ENDPOINT"):
            self.env.pop(name, None)

    def tearDown(self):
        self.tmp.cleanup()

    def fde(self, *args, input_text=None):
        return subprocess.run([str(FDE), *args], input=input_text, text=True,
                              capture_output=True, env=self.env)

    def json_fde(self, *args, expected=0, input_text=None):
        # --json goes before any `--`: after it, it is the ask, not a flag.
        args = list(args)
        cut = args.index("--") if "--" in args else len(args)
        r = self.fde(*args[:cut], "--json", *args[cut:], input_text=input_text)
        self.assertEqual(r.returncode, expected,
                         msg=f"args={args}\nstdout:\n{r.stdout}\nstderr:\n{r.stderr}")
        return json.loads(r.stdout)

    def stub(self, name, body="#!/usr/bin/env bash\nexit 0\n"):
        """A stand-in provider CLI on PATH. Availability is about the local
        surface, and a test must be able to set that surface deterministically."""
        path = self.bin / name
        path.write_text(body)
        path.chmod(0o755)
        return path

    def registry(self):
        return json.loads((self.shared / "config" / "agents.json").read_text())


class TestProviders(AccountsBase):
    def test_every_provider_declares_how_it_isolates_an_account(self):
        answer = self.json_fde("accounts", "providers")
        self.assertEqual(answer["schemaVersion"], 1)
        by_name = {p["provider"]: p for p in answer["providers"]}
        self.assertEqual(
            sorted(by_name),
            ["antigravity", "claude", "claude-bedrock", "codex", "copilot-studio"])
        for name, provider in by_name.items():
            with self.subTest(provider=name):
                self.assertTrue(provider["label"])
                self.assertTrue(provider["capabilities"])
                self.assertIn(provider["loginMode"], ("terminal", "secret", "none"))
                # Either it names the variable that keeps accounts apart, or it
                # says plainly that it cannot keep them apart at all.
                self.assertTrue(
                    provider["credentialEnv"] or provider["sharedCredential"]
                    or provider["loginMode"] == "secret",
                    f"{name} claims neither isolation nor its absence")

    def test_a_shared_credential_provider_admits_it_cannot_isolate(self):
        answer = self.json_fde("accounts", "providers")
        agy = next(p for p in answer["providers"] if p["provider"] == "antigravity")
        self.assertTrue(agy["sharedCredential"])
        self.assertEqual(agy["maxAccounts"], 1)
        self.assertFalse(agy["multipleAccounts"])
        self.assertIsNone(agy["credentialEnv"])
        self.assertIn("keyring", agy["maxAccountsReason"])

    def test_cli_presence_is_reported_not_assumed(self):
        before = {p["provider"]: p["cliInstalled"]
                  for p in self.json_fde("accounts", "providers")["providers"]}
        self.assertIs(before["codex"], False)
        self.stub("codex")
        after = {p["provider"]: p["cliInstalled"]
                 for p in self.json_fde("accounts", "providers")["providers"]}
        self.assertIs(after["codex"], True)


class TestAdd(AccountsBase):
    def test_add_registers_an_account_and_signs_in_to_nothing(self):
        answer = self.json_fde("accounts", "add", "--provider", "codex",
                               "--name", "Client sandbox")
        account = answer["account"]
        self.assertEqual(account["id"], "codex_client-sandbox")
        self.assertEqual(account["provider"], "codex")
        self.assertEqual(account["account"], "client-sandbox")
        self.assertEqual(account["credentialDir"], str(self.codex / "client-sandbox"))
        self.assertFalse(account["loggedIn"])
        self.assertEqual(account["nextAction"], "fde accounts login codex_client-sandbox")
        # The directory exists and is owner-only; nothing was signed in.
        directory = self.codex / "client-sandbox"
        self.assertTrue(directory.is_dir())
        self.assertEqual(stat.S_IMODE(directory.stat().st_mode) & 0o077, 0)
        self.assertFalse((directory / "auth.json").exists())

    def test_several_accounts_on_one_provider_get_separate_directories(self):
        first = self.json_fde("accounts", "add", "--provider", "codex", "--name", "work")
        second = self.json_fde("accounts", "add", "--provider", "codex", "--name", "personal")
        self.assertNotEqual(first["account"]["id"], second["account"]["id"])
        self.assertNotEqual(first["account"]["credentialDir"],
                            second["account"]["credentialDir"])

    def test_the_registry_is_the_only_thing_written_and_carries_no_secret(self):
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "work")
        entry = self.registry()["agents"]["codex_work"]
        self.assertEqual(entry["provider"], "codex")
        self.assertEqual(entry["account"], "work")
        self.assertTrue(entry["capabilities"])
        for banned in ("role", "defaultRole", "preferred", "default"):
            self.assertNotIn(banned, entry)
        # No key here may ever hold a credential: the registry records where a
        # credential lives, never what it is.
        for key in entry:
            self.assertNotRegex(
                key, r"(?i)secret|token|password|api[-_]?key|credential",
                f"registry entry carries a credential-shaped key: {key}")

    def test_a_duplicate_name_on_one_provider_is_refused(self):
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "work")
        answer = self.json_fde("accounts", "add", "--provider", "codex",
                               "--name", "Work", expected=2)
        self.assertEqual(answer["error"]["code"], "duplicate_account")

    def test_two_providers_may_not_claim_one_credential_directory(self):
        """Claude and Claude-on-Bedrock share a credential root, so the thing
        that must be unique is the directory, not the provider-and-name pair."""
        self.json_fde("accounts", "add", "--provider", "claude", "--name", "shared")
        answer = self.json_fde("accounts", "add", "--provider", "claude-bedrock",
                               "--name", "shared", expected=2)
        self.assertEqual(answer["error"]["code"], "credential_dir_taken")

    def test_a_provider_that_cannot_isolate_accounts_accepts_only_one(self):
        answer = self.json_fde("accounts", "add", "--provider", "antigravity",
                               "--name", "personal", expected=5)
        self.assertEqual(answer["error"]["code"], "provider_account_limit")
        self.assertIn("keyring", answer["error"]["message"])
        # The shipped identity is what already holds it, and is named.
        self.assertIn("gemini", answer["error"]["message"])

    def test_a_required_field_is_refused_when_it_does_not_match_its_pattern(self):
        answer = self.json_fde("accounts", "add", "--provider", "claude-bedrock",
                               "--name", "prod", "--aws-profile", "not a profile!",
                               expected=2)
        self.assertEqual(answer["error"]["code"], "field_invalid")
        self.assertNotIn("bedrock_prod", self.registry()["agents"])

    def test_field_defaults_are_recorded_when_not_supplied(self):
        answer = self.json_fde("accounts", "add", "--provider", "claude-bedrock",
                               "--name", "prod")
        self.assertEqual(answer["account"]["fields"],
                         {"awsProfile": "bedrock-dev", "awsRegion": "eu-west-1"})

    def test_a_name_that_reduces_to_nothing_usable_is_refused(self):
        for name in ("!!!", "---", " "):
            with self.subTest(name=name):
                r = self.fde("accounts", "add", "--provider", "codex",
                             "--name", name, "--json")
                self.assertNotEqual(r.returncode, 0, name)

    def test_an_unknown_provider_is_refused_with_the_known_ones(self):
        answer = self.json_fde("accounts", "add", "--provider", "openai",
                               "--name", "x", expected=2)
        self.assertEqual(answer["error"]["code"], "unknown_provider")
        self.assertIn("codex", answer["error"]["hint"])


class TestLoginState(AccountsBase):
    def test_a_registered_account_is_signed_out_until_its_credential_appears(self):
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "work")
        account = self.json_fde("accounts", "verify", "codex_work", expected=4)["account"]
        self.assertFalse(account["loggedIn"])
        self.assertEqual(account["credentialSource"], "none")
        (self.codex / "work" / "auth.json").write_text("{}")
        account = self.json_fde("accounts", "verify", "codex_work")["account"]
        self.assertTrue(account["loggedIn"])
        self.assertEqual(account["credentialSource"], "file")

    def test_the_credential_file_is_never_read_only_looked_for(self):
        """A Codex auth.json holds access tokens. Its existence is the answer;
        its contents must not appear in any output this command produces."""
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "work")
        (self.codex / "work" / "auth.json").write_text(
            json.dumps({"tokens": {"access_token": "SUPER-SECRET-VALUE"}}))
        r = self.fde("accounts", "verify", "codex_work", "--json")
        self.assertNotIn("SUPER-SECRET-VALUE", r.stdout + r.stderr)
        r = self.fde("accounts", "list", "--json")
        self.assertNotIn("SUPER-SECRET-VALUE", r.stdout + r.stderr)

    def test_a_missing_status_command_reports_neither_way(self):
        """Antigravity's sign-in can only be confirmed by running its own CLI.
        With that CLI absent, "not signed in" is a claim the controller cannot
        support, so it says the check could not run instead."""
        answer = self.json_fde("accounts", "verify", "gemini", expected=4)
        self.assertIs(answer["account"]["confirmed"], False)
        self.assertFalse(answer["account"]["check"]["ran"])
        self.assertIsNone(answer["account"]["check"]["ok"])
        self.assertIn("could not be confirmed", answer["account"]["check"]["detail"])

    def test_a_status_command_that_answers_is_believed(self):
        self.stub("agy")
        answer = self.json_fde("accounts", "verify", "gemini")
        self.assertIs(answer["account"]["confirmed"], True)
        self.assertTrue(answer["account"]["check"]["ran"])
        self.assertTrue(answer["account"]["loggedIn"])

    def test_a_status_command_that_refuses_is_also_believed(self):
        self.stub("agy", "#!/usr/bin/env bash\necho 'not signed in' >&2\nexit 1\n")
        answer = self.json_fde("accounts", "verify", "gemini", expected=4)
        self.assertIs(answer["account"]["confirmed"], True)
        self.assertFalse(answer["account"]["loggedIn"])

    def test_logged_in_filter_is_what_a_run_can_actually_use(self):
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "work")
        self.assertNotIn(
            "codex_work",
            [a["id"] for a in self.json_fde("accounts", "list", "--logged-in")["accounts"]])
        (self.codex / "work" / "auth.json").write_text("{}")
        self.assertIn(
            "codex_work",
            [a["id"] for a in self.json_fde("accounts", "list", "--logged-in")["accounts"]])


class TestSecret(AccountsBase):
    def add_copilot(self):
        return self.json_fde("accounts", "add", "--provider", "copilot-studio",
                             "--name", "Tenant")["account"]

    def test_a_secret_arrives_on_stdin_and_is_stored_owner_only(self):
        self.add_copilot()
        answer = self.json_fde("accounts", "set-secret", "copilot_tenant",
                               input_text="a-direct-line-secret-value-long-enough")
        self.assertTrue(answer["account"]["loggedIn"])
        self.assertEqual(answer["account"]["credentialSource"], "file")
        path = self.copilot / "tenant" / "directline-secret"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(path.read_text(), "a-direct-line-secret-value-long-enough")

    def test_the_stored_secret_is_never_returned_or_printed(self):
        self.add_copilot()
        secret = "unmistakable-direct-line-secret-value"
        r = self.fde("accounts", "set-secret", "copilot_tenant", "--json",
                     input_text=secret)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn(secret, r.stdout + r.stderr)
        for args in (("accounts", "list"), ("accounts", "verify", "copilot_tenant")):
            r = self.fde(*args, "--json")
            self.assertNotIn(secret, r.stdout + r.stderr)

    def test_an_empty_or_too_short_paste_is_refused(self):
        self.add_copilot()
        for value in ("", "short"):
            with self.subTest(value=value):
                answer = self.json_fde("accounts", "set-secret", "copilot_tenant",
                                       input_text=value, expected=2)
                self.assertIn(answer["error"]["code"],
                              ("secret_too_short", "secret_multiline"))
        self.assertFalse((self.copilot / "tenant" / "directline-secret").exists())

    def test_a_multiline_paste_is_refused_rather_than_trimmed(self):
        self.add_copilot()
        answer = self.json_fde(
            "accounts", "set-secret", "copilot_tenant",
            input_text="Secret: a-direct-line-secret-value\nand some other text\n",
            expected=2)
        self.assertEqual(answer["error"]["code"], "secret_multiline")

    def test_a_provider_with_a_cli_refuses_a_pasted_secret(self):
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "work")
        answer = self.json_fde("accounts", "set-secret", "codex_work",
                               input_text="something-long-enough-to-pass", expected=2)
        self.assertEqual(answer["error"]["code"], "not_secret_login")


class TestLoginPlan(AccountsBase):
    def test_the_login_plan_is_argv_and_environment_never_a_command_string(self):
        self.stub("codex")
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "work")
        login = self.json_fde("accounts", "login", "codex_work")["login"]
        self.assertEqual(login["argv"], ["codex", "login"])
        self.assertEqual(login["env"]["CODEX_HOME"], str(self.codex / "work"))
        self.assertEqual(login["verifyCommand"],
                         ["fde", "accounts", "verify", "codex_work", "--json"])

    def test_a_provider_with_no_interactive_sign_in_says_so(self):
        self.json_fde("accounts", "add", "--provider", "claude-bedrock", "--name", "prod")
        answer = self.json_fde("accounts", "login", "bedrock_prod", expected=2)
        self.assertEqual(answer["error"]["code"], "no_login")

    def test_a_pasted_secret_provider_points_at_set_secret(self):
        self.json_fde("accounts", "add", "--provider", "copilot-studio", "--name", "T")
        answer = self.json_fde("accounts", "login", "copilot_t", expected=2)
        self.assertEqual(answer["error"]["code"], "secret_login")
        self.assertIn("set-secret", answer["error"]["hint"])

    def test_a_missing_cli_is_refused_before_a_terminal_is_offered(self):
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "work")
        answer = self.json_fde("accounts", "login", "codex_work", expected=4)
        self.assertEqual(answer["error"]["code"], "cli_missing")


class TestLaunch(AccountsBase):
    def test_a_claude_account_can_hold_an_interactive_session(self):
        launch = self.json_fde("accounts", "launch", "claude_work")["launch"]
        self.assertTrue(launch["interactive"])
        self.assertEqual(launch["configDir"], str(self.profiles / "work"))
        self.assertEqual(launch["env"]["CLAUDE_PROFILE"], "work")

    def test_an_account_that_cannot_hold_one_says_why(self):
        for identity in ("gemini", "microsoft_copilot", "chatgpt_codex"):
            with self.subTest(identity=identity):
                answer = self.json_fde("accounts", "launch", identity, expected=3)
                launch = answer["launch"]
                self.assertFalse(launch["interactive"])
                self.assertTrue(launch["reason"])

    def test_env0_output_is_nul_delimited_pairs_and_nothing_else(self):
        r = subprocess.run([str(FDE), "accounts", "launch", "claude_work", "--env0"],
                           capture_output=True, env=self.env)
        self.assertEqual(r.returncode, 0, r.stderr)
        pairs = [p for p in r.stdout.decode().split("\0") if p]
        self.assertEqual(sorted(pairs), [
            f"CLAUDE_CONFIG_DIR={self.profiles / 'work'}",
            "CLAUDE_PROFILE=work",
        ])

    def test_a_bedrock_account_carries_its_bedrock_switch(self):
        self.json_fde("accounts", "add", "--provider", "claude-bedrock", "--name", "prod")
        launch = self.json_fde("accounts", "launch", "bedrock_prod")["launch"]
        self.assertEqual(launch["env"]["CLAUDE_CODE_USE_BEDROCK"], "1")


class TestBackwardsCompatibility(AccountsBase):
    """An entry that predates this command keeps exactly the environment it had.

    Handing an already-signed-in CLI a fresh empty directory would look, to the
    operator, like being silently signed out."""

    def test_a_shipped_claude_entry_resolves_to_the_directory_it_always_used(self):
        launch = self.json_fde("accounts", "launch", "claude_msc")["launch"]
        self.assertEqual(launch["env"]["CLAUDE_CONFIG_DIR"], str(self.profiles / "msc"))

    def test_a_shipped_codex_entry_is_given_no_credential_variable(self):
        launch = self.json_fde("accounts", "launch", "chatgpt_codex", expected=3)["launch"]
        self.assertNotIn("CODEX_HOME", launch["env"])

    def test_a_shipped_antigravity_entry_is_given_no_credential_variable(self):
        launch = self.json_fde("accounts", "launch", "gemini", expected=3)["launch"]
        self.assertEqual(launch["env"], {})

    def test_a_shipped_copilot_entry_keeps_the_single_fixed_keychain_service(self):
        launch = self.json_fde("accounts", "launch", "microsoft_copilot", expected=3)["launch"]
        self.assertNotIn("FDE_COPILOT_KEYCHAIN_SERVICE", launch["env"])
        self.assertNotIn("FDE_COPILOT_ACCOUNT_DIR", launch["env"])

    def test_a_shipped_codex_entry_looks_for_its_credential_where_the_cli_puts_it(self):
        account = next(a for a in self.json_fde("accounts", "list")["accounts"]
                       if a["id"] == "chatgpt_codex")
        self.assertEqual(account["credentialDir"], str(self.home / ".codex"))
        self.assertFalse(account["isolated"])
        self.assertFalse(account["declared"])

    def test_a_new_account_is_isolated_and_a_shipped_one_is_not(self):
        new = self.json_fde("accounts", "add", "--provider", "codex",
                            "--name", "work")["account"]
        self.assertTrue(new["isolated"])
        self.assertTrue(new["declared"])


class TestRemove(AccountsBase):
    def test_removing_deregisters_and_keeps_credentials_by_default(self):
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "work")
        (self.codex / "work" / "auth.json").write_text("{}")
        answer = self.json_fde("accounts", "remove", "codex_work")
        self.assertEqual(answer["removed"]["id"], "codex_work")
        self.assertFalse(answer["credentials"]["requested"])
        self.assertNotIn("codex_work", self.registry()["agents"])
        self.assertTrue((self.codex / "work" / "auth.json").exists())

    def test_purge_deletes_only_the_directory_the_template_names(self):
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "work")
        (self.codex / "work" / "auth.json").write_text("{}")
        answer = self.json_fde("accounts", "remove", "codex_work", "--purge-credentials")
        self.assertTrue(answer["credentials"]["removed"])
        self.assertFalse((self.codex / "work").exists())

    def test_purge_refuses_a_symlinked_account_directory(self):
        elsewhere = self.home / "elsewhere"
        elsewhere.mkdir()
        (elsewhere / "keep-me").write_text("x")
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "work")
        target = self.codex / "work"
        shutil.rmtree(target)
        target.symlink_to(elsewhere)
        answer = self.json_fde("accounts", "remove", "codex_work", "--purge-credentials")
        self.assertFalse(answer["credentials"]["removed"])
        self.assertIn("symlink", answer["credentials"]["reason"])
        self.assertTrue((elsewhere / "keep-me").exists())

    def test_an_account_holding_a_role_in_an_unfinished_run_is_refused(self):
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "work")
        run = self.json_fde("start", "--orchestrator", "claude_work",
                            "--shape", "research", "--", "look into a thing")
        run_id = run["run"]["runId"]
        self.fde("roles", run_id, "--set", "research=codex_work",
                 "--set", "productManagement=none", "--set", "microsoftContext=none",
                 "--allow-unavailable")
        answer = self.json_fde("accounts", "remove", "codex_work", expected=5)
        self.assertEqual(answer["error"]["code"], "account_in_use")
        self.assertIn(run_id, answer["error"]["message"])
        self.assertIn("codex_work", self.registry()["agents"])
        # --force is the documented way through, and it says what it broke.
        answer = self.json_fde("accounts", "remove", "codex_work", "--force")
        self.assertEqual([u["runId"] for u in answer["stillInUse"]], [run_id])

    def test_removing_an_unknown_account_is_a_not_found(self):
        answer = self.json_fde("accounts", "remove", "codex_nope", expected=4)
        self.assertEqual(answer["error"]["code"], "unknown_account")


class TestIdentityListsAreTheRegistry(AccountsBase):
    """The prompts used to restate the identity list as a literal, so an account
    the operator added was invisible in the very prompt that asks them to
    choose one."""

    def test_a_new_account_appears_in_the_role_question(self):
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "Client A")
        run = self.json_fde("start", "--orchestrator", "claude_work",
                            "--shape", "research", "--", "look into a thing")
        r = self.fde("roles", run["run"]["runId"])
        self.assertIn("ChatGPT / Codex: Client A", r.stdout)

    def test_a_removed_account_stops_being_offered(self):
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "Client A")
        self.json_fde("accounts", "remove", "codex_client-a")
        run = self.json_fde("start", "--orchestrator", "claude_work",
                            "--shape", "research", "--", "look into a thing")
        r = self.fde("roles", run["run"]["runId"])
        self.assertNotIn("Client A", r.stdout)

    def test_a_new_account_can_be_named_by_its_own_name(self):
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "Client A")
        run = self.json_fde("start", "--orchestrator", "claude_work",
                            "--shape", "research", "--", "look into a thing")
        r = self.fde("roles", run["run"]["runId"], "--set", "research=Client A",
                     "--set", "productManagement=none", "--set", "microsoftContext=none",
                     "--allow-unavailable")
        self.assertEqual(r.returncode, 0, r.stderr)
        roles = json.loads((self.shared / "runs" / run["run"]["runId"] /
                            "roles.json").read_text())
        self.assertEqual(roles["assignments"]["research"], ["codex_client-a"])

    def test_a_word_that_would_name_two_identities_names_neither(self):
        """Guessing which account the operator meant is the one outcome that
        cannot be undone by reading the record afterwards."""
        self.json_fde("accounts", "add", "--provider", "codex", "--name", "work")
        run = self.json_fde("start", "--orchestrator", "claude_work",
                            "--shape", "research", "--", "look into a thing")
        r = self.fde("roles", run["run"]["runId"], "--set", "research=work",
                     "--set", "productManagement=none", "--set", "microsoftContext=none",
                     "--allow-unavailable")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("more than one identity", r.stderr)

    def test_only_identities_that_can_orchestrate_are_offered_as_orchestrator(self):
        r = self.fde("start")
        self.assertIn("Identities that can orchestrate", r.stdout)
        self.assertNotIn("Microsoft Copilot", r.stdout.split("Nothing is read")[0])


if __name__ == "__main__":
    unittest.main()
