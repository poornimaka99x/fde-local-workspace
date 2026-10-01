"""Read-only configuration comparison. Values and credentials never leave this module."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

FILES = (
    "config/routing-policy.json", "config/security-policy.json",
    "config/evaluation-suite.json",
    "config/agents.json", "config/provider-templates.json",
    "config/capability-config.json", "config/capability-policy.json",
    "config/mcp-user-config.json", "mcp/mcp-servers.json", "CLAUDE.md",
)


def changed_paths(left, right, prefix=""):
    if isinstance(left, dict) and isinstance(right, dict):
        result = []
        for key in sorted(left.keys() | right.keys()):
            path = prefix + "/" + key.replace("~", "~0").replace("/", "~1")
            if key not in left or key not in right:
                result.append(path)
            else:
                result.extend(changed_paths(left[key], right[key], path))
        return result
    if isinstance(left, list) and isinstance(right, list):
        result = []
        for index in range(max(len(left), len(right))):
            path = f"{prefix}/{index}"
            if index >= len(left) or index >= len(right):
                result.append(path)
            else:
                result.extend(changed_paths(left[index], right[index], path))
        return result
    return [] if left == right else [prefix or "/"]


def _read(root, relative):
    path = root / relative
    if not path.exists() and not path.is_symlink():
        return {"state": "missing", "sha256": None}, None
    if not path.resolve().is_relative_to(root):
        return {"state": "outside-root", "sha256": None}, None
    try:
        data = path.read_bytes()
    except OSError:
        return {"state": "unreadable", "sha256": None}, None
    result = {"state": "present", "sha256": hashlib.sha256(data).hexdigest()}
    if path.suffix == ".json":
        try:
            return result, json.loads(data)
        except (ValueError, UnicodeError):
            result["state"] = "invalid-json"
    return result, None


def report(source_root, installed_root):
    source, installed = Path(source_root).resolve(), Path(installed_root).resolve()
    if not (source / "config/routing-policy.json").is_file():
        raise ValueError("source root must contain config/routing-policy.json (use the claude-shared directory)")
    paths = set(FILES)
    for root in (source, installed):
        paths.update(str(p.relative_to(root)) for p in (root / "config/workflows").glob("*.json"))
    files = []
    for relative in sorted(paths):
        a, av = _read(source, relative)
        b, bv = _read(installed, relative)
        if a["state"] == b["state"] == "missing":
            continue
        if any(x["state"] not in ("missing", "present") for x in (a, b)):
            status = "invalid"
        elif a["state"] == "missing":
            status = "installed-only"
        elif b["state"] == "missing":
            status = "source-only"
        elif a["sha256"] == b["sha256"]:
            status = "same"
        elif relative.endswith(".json") and av == bv:
            status = "formatting-only"
        else:
            status = "different"
        files.append({"path": relative, "status": status, "source": a, "installed": b,
                      "changedPaths": changed_paths(av, bv) if status == "different" and relative.endswith(".json") else []})
    return {"schemaVersion": 1, "sourceRoot": str(source), "installedRoot": str(installed),
            "readOnly": True, "valuesIncluded": False,
            "differences": sum(row["status"] != "same" for row in files), "files": files,
            "executionBoundary": "FDE resolution describes controller-managed invocations only; direct desktop tools and external client permissions are not attested."}
