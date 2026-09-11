"""fde_plugin_import — bringing somebody else's plugin onto this machine.

An imported plugin is code from outside the trust boundary. This module is the
one door it comes through, and the door has a shape:

    stage  ->  inspect  ->  validate  ->  approve  ->  activate  ->  lock

Nothing is executed at any point in that sequence. Not an installation script,
not a hook, not a postinstall, not an MCP server. A plugin is read, hashed and
described; whether any of it ever runs is a separate decision the operator makes
afterwards, in the open, per capability.

What the door refuses, it refuses before anything is copied into place:
symbolic links, paths that resolve outside the tree, anything that is not a
regular file or a directory, a tree over the size and file-count caps, a
manifest that does not parse, a name that is reserved or unusable, and a git
source without an explicit commit — because "the latest main" is not a pin and
a supply chain you cannot name is not one you can audit.

Activation is atomic and reversible: the previous version is kept, and rollback
puts it back without going near the network.

Python 3, standard library only.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import tempfile

import fde_capabilities as cap

SCHEMA_VERSION = cap.SCHEMA_VERSION

# Caps on what may be brought in. A plugin is skills, agents, commands, hooks
# and small helpers; a tree that busts these is something else wearing a
# manifest, and it is refused rather than truncated.
MAX_FILES = 1_000
MAX_BYTES = 20 * 1024 * 1024
MAX_FILE_BYTES = 4 * 1024 * 1024

# How many superseded versions to keep for rollback.
KEEP_VERSIONS = 3

COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
REF_RE = re.compile(r"^[A-Za-z0-9._/-]{1,128}$")
GIT_URL_RE = re.compile(r"^(https://|git@|file://)[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{3,512}$")

# Runtimes a hook or script may name. Reported so an operator learns that
# switching a plugin on also means depending on Node, before they switch it on.
KNOWN_RUNTIMES = ("node", "deno", "python3", "python", "bash", "sh", "ruby", "perl")

# Files that would run something if some other tool got hold of this tree. They
# are inventoried and reported, never honoured.
INSTALL_HOOK_FILES = ("package.json", "install.sh", "setup.py", "Makefile", "postinstall.js")

GIT_TIMEOUT_SECONDS = 300

LOCK_RELATIVE = os.path.join(".claude-plugin", cap.LOCK_NAME)


class ImportError_(cap.CapabilityError):
    """A refusal from the import path, with the same envelope as the rest."""


def _now():
    return _dt.datetime.now(_dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


# ------------------------------------------------------------------ inspect --

def inspect_tree(root):
    """Walk a candidate tree and describe it. Reads only; runs nothing.

    Returns the description AND the refusals, rather than raising on the first
    one, so an operator sees everything wrong with a plugin in a single answer
    instead of fixing one problem per attempt.
    """
    root = pathlib.Path(root)
    resolved_root = root.resolve()
    report = {
        "root": str(root), "files": [], "fileCount": 0, "totalBytes": 0,
        "executables": [], "symlinks": [], "special": [], "escaping": [],
        "oversized": [], "installFiles": [], "hookFiles": [], "hooks": [],
        "runtimes": [], "manifest": None, "manifestError": None,
        "license": None, "licenseFile": None, "errors": [],
    }
    runtimes = set()

    for current, directories, names in os.walk(root, followlinks=False):
        directories.sort()
        here = pathlib.Path(current)
        for name in sorted(directories + names):
            target = here / name
            relative = str(target.relative_to(root))
            info = target.lstat()
            if stat.S_ISLNK(info.st_mode):
                # Not followed, not copied, not resolved. A symlink is how a
                # plugin reads a credential it was never given.
                report["symlinks"].append(relative)
                continue
            if target.is_dir():
                continue
            if not stat.S_ISREG(info.st_mode):
                report["special"].append(relative)
                continue
            try:
                if not str(target.resolve()).startswith(str(resolved_root) + os.sep):
                    report["escaping"].append(relative)
                    continue
            except OSError:
                report["escaping"].append(relative)
                continue
            if relative == LOCK_RELATIVE:
                # FDE's own record about this tree is not part of the tree it
                # describes. Hashing it would make every lock invalidate itself.
                continue
            if info.st_size > MAX_FILE_BYTES:
                report["oversized"].append(relative)
            report["fileCount"] += 1
            report["totalBytes"] += info.st_size
            report["files"].append({"path": relative, "bytes": info.st_size,
                                    "sha256": _sha256(target)})
            if info.st_mode & 0o111:
                report["executables"].append(relative)
            if name in INSTALL_HOOK_FILES:
                report["installFiles"].append(relative)

        # Symlinked directories are recorded above and must not be descended.
        directories[:] = [d for d in directories if not (here / d).is_symlink()]

    report["files"].sort(key=lambda entry: entry["path"])
    report["treeSha256"] = tree_digest(report["files"])

    manifest_path = root / ".claude-plugin" / "plugin.json"
    try:
        report["manifest"] = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(report["manifest"], dict):
            raise ValueError("the manifest is not an object")
    except FileNotFoundError:
        report["manifestError"] = "there is no .claude-plugin/plugin.json"
    except (json.JSONDecodeError, OSError, ValueError) as exc:
        report["manifestError"] = f"the manifest could not be read: {exc}"

    for candidate in ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"):
        if (root / candidate).is_file():
            report["licenseFile"] = candidate
            report["license"] = _license_name((root / candidate).read_text(
                encoding="utf-8", errors="replace"))
            break
    if report["license"] is None and isinstance(report["manifest"], dict):
        declared = report["manifest"].get("license")
        report["license"] = declared if isinstance(declared, str) else None

    for relative, payload in _hook_manifests(root, report["manifest"]):
        report["hookFiles"].append(relative)
        for event, body in payload.items():
            report["hooks"].append(event)
            for runtime in KNOWN_RUNTIMES:
                if re.search(rf"\b{runtime}\b", json.dumps(body)):
                    runtimes.add(runtime)
    report["hooks"] = sorted(set(report["hooks"]))
    report["runtimes"] = sorted(runtimes)
    return report


def _license_name(text):
    head = text[:4000]
    for name, pattern in (("MIT", r"\bMIT License\b"),
                          ("Apache-2.0", r"\bApache License\b"),
                          ("BSD-3-Clause", r"\bBSD 3-Clause\b"),
                          ("BSD-2-Clause", r"\bBSD 2-Clause\b"),
                          ("GPL-3.0", r"\bGNU GENERAL PUBLIC LICENSE\b[\s\S]{0,200}Version 3"),
                          ("ISC", r"\bISC License\b"),
                          ("proprietary", r"\ball rights reserved\b")):
        if re.search(pattern, head, re.I):
            return name
    return "unknown"


def _hook_manifests(root, manifest):
    """Every hook definition this tree declares, read as data."""
    candidates = []
    declared = manifest.get("hooks") if isinstance(manifest, dict) else None
    if isinstance(declared, str):
        candidates.append(declared.lstrip("./"))
    candidates.append("hooks/hooks.json")
    seen, out = set(), []
    for relative in candidates:
        if relative in seen:
            continue
        seen.add(relative)
        target = root / relative
        if not target.is_file() or target.is_symlink():
            continue
        try:
            payload = json.loads(target.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        events = payload.get("hooks") if isinstance(payload, dict) else None
        if isinstance(events, dict):
            out.append((relative, events))
    return out


def tree_digest(files):
    """One digest over path and content, so a rename is a change too."""
    digest = hashlib.sha256()
    for entry in files:
        digest.update(entry["path"].encode("utf-8"))
        digest.update(b"\0")
        digest.update(entry["sha256"].encode("ascii"))
        digest.update(b"\n")
    return digest.hexdigest()


# ----------------------------------------------------------------- validate --

def validate_import(report, *, name=None, accept_hooks=False, accept_executables=False,
                    expect_namespace=None):
    """Everything wrong with this tree, as a list. Empty means it may be activated.

    Split from activation on purpose: the same function answers "what would
    happen if I imported this" for a dry run and "may this be imported" for the
    real thing, so the preview an operator approves is the check that runs.
    """
    problems = []
    if report["manifestError"]:
        problems.append({"code": "invalid-manifest", "message": report["manifestError"]})
        manifest = {}
    else:
        manifest = report["manifest"]

    declared = manifest.get("name")
    plugin = name or (declared if isinstance(declared, str) else None)
    if not plugin:
        problems.append({"code": "no-name", "message": "the manifest declares no plugin name"})
    elif not cap.PLUGIN_RE.match(plugin):
        problems.append({"code": "invalid-name",
                         "message": f"{plugin!r} is not a usable plugin name "
                                    "(lower case, digits and hyphens)"})
    elif plugin == cap.BUILTIN_PLUGIN:
        problems.append({"code": "reserved-name",
                         "message": f"{plugin} is the built-in plugin and cannot be replaced by an import"})
    elif plugin in cap.PINNED_NAMESPACES and expect_namespace != plugin:
        problems.append({"code": "reserved-namespace",
                         "message": f"{plugin} is a reserved namespace; import it as that pinned "
                                    "plugin or choose another name"})
    if isinstance(declared, str) and plugin and declared != plugin:
        problems.append({"code": "name-mismatch",
                         "message": f"the manifest names {declared!r} but this would install as {plugin!r}"})

    for relative in report["symlinks"]:
        problems.append({"code": "symlink", "message": f"{relative} is a symbolic link"})
    for relative in report["special"]:
        problems.append({"code": "not-a-regular-file",
                         "message": f"{relative} is neither a regular file nor a directory"})
    for relative in report["escaping"]:
        problems.append({"code": "path-escape",
                         "message": f"{relative} resolves outside the plugin directory"})
    for relative in report["oversized"]:
        problems.append({"code": "file-too-large",
                         "message": f"{relative} is larger than the {MAX_FILE_BYTES // (1024 * 1024)} MB per-file limit"})
    if report["fileCount"] > MAX_FILES:
        problems.append({"code": "too-many-files",
                         "message": f"{report['fileCount']} files exceeds the {MAX_FILES} limit"})
    if report["totalBytes"] > MAX_BYTES:
        problems.append({"code": "tree-too-large",
                         "message": f"{report['totalBytes']} bytes exceeds the "
                                    f"{MAX_BYTES // (1024 * 1024)} MB limit"})
    if report["fileCount"] == 0:
        problems.append({"code": "empty", "message": "the tree contains no files"})

    # Hooks and executables are not refusals — they are the things an operator
    # has to actually look at. They become refusals only when nobody has.
    if report["hooks"] and not accept_hooks:
        problems.append({"code": "hooks-need-approval",
                         "message": "this plugin defines lifecycle hooks: "
                                    + ", ".join(report["hooks"])
                                    + ". Review them and re-run with --accept-hooks."})
    if report["executables"] and not accept_executables:
        shown = ", ".join(report["executables"][:5])
        more = "" if len(report["executables"]) <= 5 else f" (+{len(report['executables']) - 5} more)"
        problems.append({"code": "executables-need-approval",
                         "message": f"this plugin ships executable files: {shown}{more}. "
                                    "Review them and re-run with --accept-executables."})
    return problems


def dependency_report(report):
    """What switching this plugin on would make FDE depend on."""
    dependencies = []
    for runtime in report["runtimes"]:
        found = shutil.which(runtime)
        dependencies.append({"kind": "runtime", "name": runtime,
                             "state": "ok" if found else "missing", "path": found})
    for relative in report["installFiles"]:
        dependencies.append({"kind": "package-metadata", "name": relative,
                             "state": "not-executed",
                             "note": "Present in the tree. FDE never runs it."})
    return dependencies


# -------------------------------------------------------------------- stage --

def _run_git(arguments, cwd):
    try:
        result = subprocess.run(["git", *arguments], cwd=str(cwd), text=True,
                                capture_output=True, timeout=GIT_TIMEOUT_SECONDS,
                                env={**os.environ, "GIT_TERMINAL_PROMPT": "0",
                                     "GIT_ASKPASS": "/bin/true"})
    except FileNotFoundError:
        raise ImportError_("no-git", "git is not installed, so a git source cannot be fetched.")
    except subprocess.TimeoutExpired:
        raise ImportError_("git-timeout", "the git fetch did not finish in time.")
    if result.returncode != 0:
        raise ImportError_("git-failed", "the pinned commit could not be fetched.",
                           detail=(result.stderr or result.stdout).strip()[:400])
    return result


def fetch_git(url, commit, destination):
    """Fetch exactly one commit. There is no code path here that takes a branch.

    A branch is a name that means something different tomorrow. Pinning is the
    whole point of importing a plugin this way, so the commit is required, it is
    checked for shape, and the resulting tree has its .git removed before it
    goes anywhere near the plugins directory.
    """
    if not GIT_URL_RE.match(url or ""):
        raise ImportError_("invalid-source", f"{url!r} is not a usable git URL.")
    if not COMMIT_RE.match(commit or ""):
        raise ImportError_("no-commit",
                           "A git import needs an explicit 40-character commit SHA.",
                           detail="FDE does not fetch a mutable branch: --commit is required.")
    destination = pathlib.Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    _run_git(["init", "--quiet"], destination)
    _run_git(["remote", "add", "origin", url], destination)
    _run_git(["fetch", "--quiet", "--depth", "1", "origin", commit], destination)
    _run_git(["checkout", "--quiet", "FETCH_HEAD"], destination)
    head = _run_git(["rev-parse", "HEAD"], destination).stdout.strip()
    if head != commit:
        raise ImportError_("commit-mismatch",
                           f"the fetched tree is at {head[:12]}, not the requested {commit[:12]}.")
    date = _run_git(["show", "-s", "--format=%cI", "HEAD"], destination).stdout.strip()
    shutil.rmtree(destination / ".git")
    # FDE fetched this commit itself and checked what came back, so the commit
    # is verified rather than asserted.
    return {"type": "git", "url": url, "commit": commit, "commitDate": date,
            "commitVerified": True}


def stage_source(source, *, commit=None, ref=None, subdirectory=None, url=None, workdir):
    """Put a candidate tree somewhere private, and say where it came from."""
    workdir = pathlib.Path(workdir)
    staged = workdir / "tree"
    if GIT_URL_RE.match(source or ""):
        origin = fetch_git(source, commit, staged)
        origin["ref"] = ref
    else:
        path = pathlib.Path(source)
        if not path.is_absolute():
            raise ImportError_("invalid-source", "Use an absolute path to a local plugin directory.")
        try:
            path = path.resolve(strict=True)
        except OSError as exc:
            raise ImportError_("no-such-source", f"{source} could not be read.", detail=str(exc))
        if not path.is_dir():
            raise ImportError_("invalid-source", f"{source} is not a directory.")
        # copytree without symlink following: a link in the source is copied as
        # a link, so inspect_tree sees it and refuses, rather than the copy
        # quietly dereferencing it into real content.
        shutil.copytree(path, staged, symlinks=True)
        # A commit given with a local source says where that directory came
        # from. Nothing here re-fetched it, so it is recorded as the importer's
        # attestation and marked unverified. The checksum, which IS computed
        # here, is what actually pins the tree.
        if commit is not None and not COMMIT_RE.match(commit):
            raise ImportError_("invalid-commit",
                               "A commit must be a 40-character SHA, even for a local source.")
        # `url` is where this tree came from upstream; the local path is only
        # where a copy of it happened to be sitting. Recording the copy's path
        # as the source would make the provenance useless to anyone else.
        origin = {"type": "local", "url": url or str(path), "localPath": str(path),
                  "commit": commit, "commitDate": None, "ref": ref, "commitVerified": False}
    if subdirectory:
        if ".." in pathlib.PurePosixPath(subdirectory).parts or pathlib.PurePosixPath(subdirectory).is_absolute():
            raise ImportError_("invalid-subdirectory", f"{subdirectory!r} is not a relative path inside the source.")
        inner = staged / subdirectory
        if not inner.is_dir() or inner.is_symlink():
            raise ImportError_("no-such-subdirectory", f"{subdirectory} is not a directory in the source.")
        moved = workdir / "subtree"
        shutil.move(str(inner), str(moved))
        shutil.rmtree(staged)
        moved.rename(staged)
        origin["subdirectory"] = subdirectory
    return staged, origin


def prune_tree(staged, include):
    """Keep only the paths an import declares it wants.

    A plugin repository is usually more than the plugin: benchmarks, artwork,
    three translations of a README. Importing the whole thing means auditing the
    whole thing on every update. The kept set is recorded in the lock, so what
    was left behind is part of the record rather than a detail somebody
    remembers.
    """
    if not include:
        return None
    staged = pathlib.Path(staged)
    keep = set()
    for pattern in include:
        if pathlib.PurePosixPath(pattern).is_absolute() or ".." in pathlib.PurePosixPath(pattern).parts:
            raise ImportError_("invalid-include", f"{pattern!r} is not a relative path inside the source.")
        for match in staged.glob(pattern):
            if match.is_symlink():
                continue
            if match.is_file():
                keep.add(match)
            elif match.is_dir():
                keep.update(child for child in match.rglob("*")
                            if child.is_file() and not child.is_symlink())
    if not keep:
        raise ImportError_("nothing-included",
                           "None of the requested paths exist in the source.",
                           detail=", ".join(include))
    for current, directories, names in os.walk(staged, topdown=False, followlinks=False):
        here = pathlib.Path(current)
        for name in names:
            target = here / name
            if target not in keep:
                target.unlink(missing_ok=True)
        for name in directories:
            directory = here / name
            if directory.is_symlink():
                directory.unlink(missing_ok=True)
                continue
            try:
                directory.rmdir()
            except OSError:
                pass
    return sorted(include)


# ----------------------------------------------------------------- activate --

def versions_root(shared):
    return cap.plugins_root(shared) / ".versions"


def _retain(name, shared):
    directory = versions_root(shared) / name
    try:
        kept = sorted(entry for entry in directory.iterdir() if entry.is_dir())
    except (FileNotFoundError, NotADirectoryError):
        return
    for stale in kept[:-KEEP_VERSIONS]:
        shutil.rmtree(stale, ignore_errors=True)


def write_lock(plugin_root, lock):
    target = cap.plugin_lock_path(plugin_root)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + f".tmp{os.getpid()}")
    temporary.write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)
    return target


def ensure_marketplace(shared, name, description, *, present=True):
    """Keep the toolkit marketplace listing in step with what is installed.

    The marketplace is how the Claude CLI is told a plugin exists. Importing a
    plugin and leaving the listing alone produces a tree on disk that nothing
    can load, which looks exactly like a broken import. Rewritten atomically,
    and every entry that is not this one is preserved verbatim.
    """
    target = cap.plugins_root(shared).parent / ".claude-plugin" / "marketplace.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        document = json.loads(target.read_text(encoding="utf-8"))
        if not isinstance(document, dict) or not isinstance(document.get("plugins"), list):
            raise ValueError("the marketplace is not a plugin list")
    except FileNotFoundError:
        document = {"name": "fde-toolkit", "owner": {"name": "FDE user"}, "plugins": []}
    except (json.JSONDecodeError, OSError, ValueError) as exc:
        raise ImportError_("invalid-marketplace",
                           f"{target} could not be read; it was left unchanged.", detail=str(exc))
    others = [entry for entry in document["plugins"]
              if not (isinstance(entry, dict) and entry.get("name") == name)]
    if present:
        others.append({"name": name, "source": f"./plugins/{name}",
                       "description": description or f"{name} plugin."})
    document["plugins"] = sorted(others, key=lambda entry: entry.get("name", ""))
    temporary = target.with_name(target.name + f".tmp{os.getpid()}")
    temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, target)
    return target


def activate(shared, name, staged, lock):
    """Put the staged tree in place, keeping the one it replaces.

    The replaced version is moved aside, not deleted, and only then is the new
    one renamed in. A failure between the two leaves the previous tree one
    `fde plugins rollback` away rather than leaving nothing at all.
    """
    root = cap.plugins_root(shared)
    root.mkdir(parents=True, exist_ok=True)
    target = root / name
    staged = pathlib.Path(staged)
    write_lock(staged, lock)

    superseded = None
    if target.exists():
        if target.is_symlink():
            raise ImportError_("plugin-is-a-symlink",
                               f"{target} is a symbolic link; refusing to replace it.")
        stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%d%H%M%S")
        superseded = versions_root(shared) / name / f"{stamp}-{lock['treeSha256'][:8]}"
        superseded.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(target), str(superseded))
    try:
        shutil.move(str(staged), str(target))
    except OSError:
        if superseded is not None:
            shutil.move(str(superseded), str(target))
        raise
    _retain(name, shared)
    manifest_path = target / ".claude-plugin" / "plugin.json"
    try:
        description = json.loads(manifest_path.read_text(encoding="utf-8")).get("description")
    except (json.JSONDecodeError, OSError):
        description = None
    ensure_marketplace(shared, name, description)
    return {"installed": str(target),
            "superseded": str(superseded) if superseded else None}


def build_lock(report, origin, *, name, imported_paths, accepted, review_note=None):
    return {
        "schemaVersion": SCHEMA_VERSION,
        "name": name,
        "type": origin.get("type"),
        "url": origin.get("url"),
        "ref": origin.get("ref"),
        "commit": origin.get("commit"),
        "commitDate": origin.get("commitDate"),
        "commitVerified": bool(origin.get("commitVerified")),
        "subdirectory": origin.get("subdirectory"),
        "localPath": origin.get("localPath"),
        "version": (report["manifest"] or {}).get("version"),
        "license": report["license"],
        "licenseFile": report["licenseFile"],
        "importedPaths": imported_paths,
        "fileCount": report["fileCount"],
        "totalBytes": report["totalBytes"],
        "treeSha256": report["treeSha256"],
        "files": report["files"],
        "hooks": report["hooks"],
        "executables": report["executables"],
        "runtimes": report["runtimes"],
        "installFiles": report["installFiles"],
        "accepted": accepted,
        "installedAt": _now(),
        "validatedAt": _now(),
        "validationStatus": "valid",
        "reviewNote": review_note,
    }


def import_plugin(shared, source, *, name=None, commit=None, ref=None, subdirectory=None,
                  include=None, accept_hooks=False, accept_executables=False,
                  expect_namespace=None, review_note=None, url=None, dry_run=False):
    """The whole door, in order. Returns what happened, or raises with why not."""
    shared = pathlib.Path(shared)
    with tempfile.TemporaryDirectory(prefix="fde-plugin-import-") as workdir:
        staged, origin = stage_source(source, commit=commit, ref=ref,
                                      subdirectory=subdirectory, url=url, workdir=workdir)
        imported_paths = prune_tree(staged, include)
        report = inspect_tree(staged)
        problems = validate_import(report, name=name, accept_hooks=accept_hooks,
                                   accept_executables=accept_executables,
                                   expect_namespace=expect_namespace)
        plugin = name or (report["manifest"] or {}).get("name")
        summary = {
            "schemaVersion": SCHEMA_VERSION,
            "name": plugin,
            "namespace": cap.plugin_namespace(plugin) if plugin else None,
            "source": origin,
            "fileCount": report["fileCount"],
            "totalBytes": report["totalBytes"],
            "treeSha256": report["treeSha256"],
            "license": report["license"],
            "hooks": report["hooks"],
            "executables": report["executables"],
            "installFiles": report["installFiles"],
            "dependencies": dependency_report(report),
            "problems": problems,
        }
        if problems:
            raise ImportError_("import-refused",
                               f"{len(problems)} problem(s) stop this plugin being imported.",
                               detail="; ".join(problem["message"] for problem in problems))
        if dry_run:
            summary["dryRun"] = True
            return summary
        lock = build_lock(report, origin, name=plugin, imported_paths=imported_paths,
                          accepted={"hooks": bool(accept_hooks and report["hooks"]),
                                    "executables": bool(accept_executables and report["executables"])},
                          review_note=review_note)
        summary.update(activate(shared, plugin, staged, lock))
        summary["lock"] = cap.plugin_lock_path(cap.plugins_root(shared) / plugin).as_posix()
    return summary


# -------------------------------------------------------- verify / rollback --

def _plugin_root(shared, name):
    if not cap.PLUGIN_RE.match(name or ""):
        raise ImportError_("invalid-name", f"{name!r} is not a plugin name.")
    root = cap.plugins_root(shared) / name
    if root.is_symlink():
        raise ImportError_("plugin-is-a-symlink", f"{root} is a symbolic link; refusing to read through it.")
    if not root.is_dir():
        raise ImportError_("unknown-plugin", f"No plugin named {name!r} is installed.",
                           detail="see: fde plugins list")
    return root


def verify_plugin(shared, name, *, record=True):
    """Is the tree on disk still the tree that was pinned?

    A commit in a lock says where a tree came from. Only re-hashing says it is
    still that tree — which is the question worth asking on a machine where
    anyone can edit a skill in place.
    """
    root = _plugin_root(shared, name)
    lock = cap.load_plugin_lock(root)
    report = inspect_tree(root)
    if lock is None:
        return {"schemaVersion": SCHEMA_VERSION, "name": name, "pinned": False,
                "state": "unpinned", "treeSha256": report["treeSha256"],
                "message": "This plugin has no lock file, so there is nothing to verify it against."}
    expected = {entry["path"]: entry["sha256"] for entry in lock.get("files", [])}
    actual = {entry["path"]: entry["sha256"] for entry in report["files"]}
    changed = sorted(path for path in expected.keys() & actual.keys()
                     if expected[path] != actual[path])
    added = sorted(actual.keys() - expected.keys())
    removed = sorted(expected.keys() - actual.keys())
    matches = report["treeSha256"] == lock.get("treeSha256") and not (changed or added or removed)
    result = {
        "schemaVersion": SCHEMA_VERSION, "name": name, "pinned": True,
        "state": "valid" if matches else "drifted",
        "commit": lock.get("commit"), "url": lock.get("url"), "ref": lock.get("ref"),
        "license": lock.get("license"),
        "expectedTreeSha256": lock.get("treeSha256"), "treeSha256": report["treeSha256"],
        "changed": changed, "added": added, "removed": removed,
        "hooks": report["hooks"], "runtimes": report["runtimes"],
        "dependencies": dependency_report(report),
    }
    if record:
        lock["validatedAt"] = _now()
        lock["validationStatus"] = result["state"]
        try:
            write_lock(root, lock)
        except OSError:
            # A read-only install can still be verified; it just cannot record
            # that it was. The answer is the point, not the bookkeeping.
            result["recorded"] = False
    return result


def versions_of(shared, name):
    directory = versions_root(shared) / name
    try:
        return sorted(entry.name for entry in directory.iterdir() if entry.is_dir())
    except (FileNotFoundError, NotADirectoryError):
        return []


def rollback_plugin(shared, name, *, version=None):
    """Put back the version this one replaced. Touches no network."""
    root = _plugin_root(shared, name)
    kept = versions_of(shared, name)
    if not kept:
        raise ImportError_("nothing-to-roll-back-to",
                           f"No previous version of {name} is kept.",
                           detail="A rollback is available only after an update.")
    chosen = version or kept[-1]
    if chosen not in kept:
        raise ImportError_("unknown-version", f"{chosen} is not a kept version of {name}.",
                           detail=", ".join(kept))
    source = versions_root(shared) / name / chosen
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%d%H%M%S")
    aside = versions_root(shared) / name / f"{stamp}-rolledback"
    shutil.move(str(root), str(aside))
    try:
        shutil.move(str(source), str(root))
    except OSError:
        shutil.move(str(aside), str(root))
        raise
    _retain(name, shared)
    lock = cap.load_plugin_lock(root) or {}
    return {"schemaVersion": SCHEMA_VERSION, "name": name, "restored": chosen,
            "commit": lock.get("commit"), "treeSha256": lock.get("treeSha256"),
            "supersededKeptAs": aside.name}


def remove_plugin(shared, name):
    """Uninstall, keeping the tree so the decision is reversible."""
    root = _plugin_root(shared, name)
    if name == cap.BUILTIN_PLUGIN:
        raise ImportError_("reserved-name", "The built-in plugin cannot be removed.")
    stamp = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%d%H%M%S")
    aside = versions_root(shared) / name / f"{stamp}-removed"
    aside.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(root), str(aside))
    ensure_marketplace(shared, name, None, present=False)
    return {"schemaVersion": SCHEMA_VERSION, "name": name, "removed": True,
            "keptAs": str(aside)}


def list_plugins(shared):
    """Every installed plugin with its pin, its licence and its health."""
    shared = pathlib.Path(shared)
    catalog = cap.Catalog.discover(shared)
    out = []
    for item in sorted(catalog.of_kind("plugin"), key=lambda entry: entry["name"]):
        provenance = item["provenance"]
        out.append({
            "id": item["id"], "name": item["name"], "namespace": item["namespace"],
            "origin": item["origin"], "version": item["version"],
            "description": item["description"],
            "pinned": provenance.get("pinned"),
            "url": provenance.get("url"), "ref": provenance.get("ref"),
            "commit": provenance.get("commit"), "checksum": provenance.get("checksum"),
            "commitVerified": provenance.get("commitVerified"),
            "license": provenance.get("license"),
            "installedAt": provenance.get("installedAt"),
            "validatedAt": provenance.get("validatedAt"),
            "validationStatus": provenance.get("validationStatus"),
            "health": item["health"], "availability": item["availability"],
            "dependencies": item["dependencies"],
            "contributes": _contribution_counts(catalog, item),
            "versionsKept": versions_of(shared, item["name"]),
        })
    return {"schemaVersion": SCHEMA_VERSION, "pluginsRoot": str(cap.plugins_root(shared)),
            "plugins": out, "warnings": catalog.warnings}


def _contribution_counts(catalog, plugin_item):
    counts = {}
    for child in catalog.children_of(plugin_item["id"]):
        counts[child["kind"]] = counts.get(child["kind"], 0) + 1
    return counts
