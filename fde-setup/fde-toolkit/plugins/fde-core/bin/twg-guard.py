#!/usr/bin/env python3
"""PreToolUse(Bash) hook: keep direct `twg` calls inside FDE's publication rules.

Reads pass (inside an FDE run only once its roles are confirmed). Anything the
shared classifier treats as a write is refused here and must go through
`fde twg --run <id> -- …`, which consumes an `fde approve-publish` approval.
Login, setup and credential commands are refused outright: they are the
operator's to run in their own terminal.

This inspects command text. It is a guardrail for cooperative agents, not a
sandbox; Atlassian's own OAuth permissions remain the hard ceiling.
Exit 2 blocks the call and returns stderr to the agent.
"""
import json
import os
import pathlib
import subprocess
import sys


def deny(message):
    print(f"FDE twg guard: {message}", file=sys.stderr)
    sys.exit(2)


def load_classifier():
    here = pathlib.Path(__file__).resolve().parent
    shared = pathlib.Path(os.environ.get("CLAUDE_SHARED",
                                         pathlib.Path.home() / ".claude-shared"))
    candidates = [shared / "lib"]
    if len(here.parents) > 3:  # a source checkout: fde-toolkit/plugins/fde-core/bin
        candidates.append(here.parents[3] / "claude-shared" / "lib")
    for lib in candidates:
        if (lib / "fde_twg.py").is_file():
            sys.path.insert(0, str(lib))
            import fde_twg  # noqa: E402
            return fde_twg, shared
    return None, shared


def main():
    try:
        event = json.load(sys.stdin)
    except (ValueError, OSError):
        return 0
    if event.get("tool_name") != "Bash":
        return 0
    command = (event.get("tool_input") or {}).get("command") or ""
    if "twg" not in command:
        return 0
    fde_twg, shared = load_classifier()
    if fde_twg is None:
        deny("the twg classifier (claude-shared/lib/fde_twg.py) is missing; "
             "re-run install.sh. Refusing rather than guessing.")
    try:
        calls = fde_twg.find_invocations(command)
    except ValueError as exc:
        deny(f"{exc}. Call twg as a plain command so it can be checked.")
    run_id = os.environ.get("FDE_RUN_ID", "")
    for args, decision in calls:
        shown = "twg " + " ".join(args)
        if decision.kind == "operator":
            deny(f"'{shown}' {decision.reason}. Ask the operator to run it in their own terminal.")
        if decision.is_write:
            where = run_id or "<run-id>"
            target = decision.target or "<target>"
            deny(f"'{shown}' is a write ({decision.reason}). Writes go through "
                 f"`fde twg --run {where} -- {' '.join(args)}` after the operator runs "
                 f"`fde approve-publish {where} {target}`. Do not run approve-publish yourself.")
        if decision.kind == "read" and run_id:
            controller = shared / "bin" / "fde"
            try:
                guard = subprocess.run(
                    [sys.executable, str(controller), "guard", run_id,
                     "--activity", "reading Atlassian data through twg"],
                    capture_output=True, text=True, timeout=30)
            except (OSError, subprocess.SubprocessError) as exc:
                deny(f"could not confirm run {run_id} roles: {exc}")
            if guard.returncode != 0:
                deny((guard.stderr or guard.stdout).strip()
                     or f"run {run_id} roles are not confirmed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
