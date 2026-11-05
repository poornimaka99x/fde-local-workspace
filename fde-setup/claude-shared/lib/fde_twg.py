"""Classify Atlassian Teamwork Graph CLI (`twg`) invocations for FDE.

twg reaches Jira, Confluence, Bitbucket and the rest of an Atlassian
organisation with the operator's own OAuth login. Atlassian enforces what that
login may do server-side; FDE adds one rule on top: nothing that writes reaches
Jira, Confluence or Bitbucket without `fde approve-publish` for that target.

This module is the single classifier for that rule. `fde twg` (the governed
runner) and the fde-core `twg-guard` hook both call it, so the two can never
disagree about what counts as a write.

The vocabulary comes from the published TWG command catalogue
(developer.atlassian.com/cloud/twg-cli/commands/commands-catalog/). It fails
closed: a command path with no recognised read verb is treated as a write.
"""
from __future__ import annotations

import os
import re
import shlex

# Commands that change the installation, the login or print credentials. An
# agent never runs these; the operator does, in their own terminal.
OPERATOR = frozenset({
    "login", "logout", "setup", "uninstall", "upgrade", "update", "upkeep",
    "auth", "env", "admin", "feedback", "skills", "completion", "cache",
})

# Local, offline introspection.
LOCAL = frozenset({"help", "doctor", "version", "capabilities"})

# Global options that may precede the command path, and take a value.
GLOBAL_VALUE_OPTIONS = frozenset({"--profile", "-p", "--site", "--mode"})

# Product namespaces FDE governs as publication targets.
TARGETS = {"jira": "jira", "confluence": "confluence", "bitbucket": "bitbucket"}

WRITE_VERBS = frozenset({
    "create", "update", "delete", "remove", "add", "set", "edit", "transition",
    "assign", "unassign", "move", "copy", "archive", "unarchive", "purge",
    "publish", "convert", "approve", "unapprove", "decline", "merge", "request",
    "request-changes", "remove-request-changes", "cancel", "clear", "reply",
    "resolve", "reopen", "star", "unstar", "watch", "unwatch", "share", "unshare",
    "upload", "attach", "link", "unlink", "rank", "run", "trigger", "rerun-failed",
    "invite", "suspend", "restore", "cancel-delete", "grant", "revoke",
    "enable-public-link", "disable-public-link", "set-owner", "rotate-key",
    "reset", "migrate", "rename", "replace", "delete-draft", "clone", "start",
    "stop", "complete", "close", "vote", "unvote", "notify", "send", "import",
    "bulk", "log", "default",
})

READ_VERBS = frozenset({
    "get", "list", "query", "search", "describe", "show", "view", "history",
    "diff", "diffstat", "diff-line", "patch", "activity", "commits", "conflicts",
    "mergeability", "merge-status", "inbox", "grep", "latest-failure", "tail",
    "file", "list-files", "url", "contributors", "analytics", "enabled",
    "pending", "check", "body-formats", "export", "export-status",
    "resolve-status", "get-public-link", "schema", "similar", "deep-search",
    "infer", "count", "stats", "last-active", "role-assignments", "for-commit",
    "download", "status", "context", "collaborators", "recently-viewed",
    "org-tree", "pr-tree", "work-tree", "workitem-tree", "focus-areas-tree",
    "direct-reports", "manager", "manager-chain", "peers", "connections",
    "content-references", "jira-links", "space-content", "overview", "scan",
    "dir", "access", "list-available-statuses", "members", "me", "whoami",
})

# Prefixes that run the command that follows them.
WRAPPERS = frozenset({
    "command", "exec", "env", "time", "nohup", "nice", "timeout", "xargs",
    "caffeinate", "sudo", "watch",
})
SHELLS = frozenset({"bash", "sh", "zsh", "dash"})
_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_SUBST = re.compile(r"(\$\(|`)\s*(?:\S*/)?twg(?:\.exe)?\b")


class Decision:
    __slots__ = ("kind", "target", "path", "reason")

    def __init__(self, kind, target=None, path=(), reason=""):
        self.kind = kind          # local | read | write | operator
        self.target = target      # jira | confluence | bitbucket | None
        self.path = tuple(path)
        self.reason = reason

    @property
    def is_write(self):
        return self.kind == "write"

    def as_dict(self):
        return {"kind": self.kind, "target": self.target,
                "path": list(self.path), "reason": self.reason}


def classify(args) -> Decision:
    """Classify the arguments that follow `twg`."""
    args = list(args)
    if any(a in ("--help", "-h", "--version") for a in args):
        return Decision("local", reason="help or version")
    i = 0
    while i < len(args) and args[i].startswith("-"):
        flag = args[i].split("=", 1)[0]
        if flag not in GLOBAL_VALUE_OPTIONS:
            return Decision("write", reason=f"unrecognised leading option {args[i]}")
        i += 1 if "=" in args[i] else 2
    path = []
    for a in args[i:]:
        if a.startswith("-"):
            break
        path.append(a)
    if not path:
        return Decision("local", reason="bare twg prints help")
    head = path[0].lower()
    words = {p.lower() for p in path}
    if head in OPERATOR:
        return Decision("operator", path=path,
                        reason="changes the TWG installation or login, or prints credentials")
    if head in LOCAL:
        return Decision("local", path=path, reason="local introspection")
    target = TARGETS.get(head)
    if words & WRITE_VERBS:
        verb = sorted(words & WRITE_VERBS)[0]
        return Decision("write", target, path, f"'{verb}' changes Atlassian data")
    if words & READ_VERBS:
        return Decision("read", target, path, "read-only command")
    return Decision("write", target, path,
                    "no recognised read verb; treated as a write (fail closed)")


# ------------------------------------------------------------ shell parsing --

def _segments(command):
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()\n")
    lexer.whitespace_split = True
    current = []
    try:
        for tok in lexer:
            if tok and set(tok) <= set(";&|()\n"):
                if current:
                    yield current
                current = []
            else:
                current.append(tok)
    except ValueError:
        raise
    if current:
        yield current


def _is_twg(token):
    return os.path.basename(token) in ("twg", "twg.exe")


def find_invocations(command, _depth=0):
    """Return a list of (args, Decision) for every twg call in a shell string.

    Raises ValueError when the string cannot be parsed or hides twg inside a
    command substitution; callers treat that as a refusal."""
    if _depth > 3:
        raise ValueError("nested shell too deep to inspect")
    if _SUBST.search(command):
        raise ValueError("twg inside a command substitution cannot be inspected")
    found = []
    for seg in _segments(command):
        k = 0
        while k < len(seg) and _ASSIGN.match(seg[k]):
            k += 1
        seg = seg[k:]
        if not seg:
            continue
        name = os.path.basename(seg[0])
        if name in ("fde",):
            continue  # `fde twg ...` is enforced by the controller itself
        if name in SHELLS and "-c" in seg[1:]:
            j = seg.index("-c")
            if j + 1 < len(seg):
                found += find_invocations(seg[j + 1], _depth + 1)
            continue
        if name == "eval":
            found += find_invocations(" ".join(seg[1:]), _depth + 1)
            continue
        if name in WRAPPERS:
            for j, tok in enumerate(seg[1:], start=1):
                if _is_twg(tok):
                    found.append((seg[j + 1:], classify(seg[j + 1:])))
                    break
            continue
        if _is_twg(seg[0]):
            found.append((seg[1:], classify(seg[1:])))
    return found
