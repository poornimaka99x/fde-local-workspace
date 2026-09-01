#!/usr/bin/env python3
"""Read-only structural and safety audit for the local FDE agent harness."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys


FRONTMATTER = re.compile(r"^---\n(.*?)\n---", re.DOTALL)
SECRET_PATTERNS = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bgh[opsu]_[A-Za-z0-9_]{30,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
]
BYPASS_FLAGS = ("--yolo", "danger-full-access", "--dangerously-bypass-approvals-and-sandbox")  # fde-safety-exempt: checker definitions


def frontmatter(text):
    match = FRONTMATTER.match(text)
    if not match:
        return {}
    out = {}
    for line in match.group(1).splitlines():
        if ":" in line and not line.startswith((" ", "\t")):
            key, value = line.split(":", 1)
            out[key.strip()] = value.strip().strip('"')
    return out


def audit(plugin_root: Path, shared_root: Path | None):
    errors, warnings = [], []
    json_files = [
        plugin_root / ".claude-plugin" / "plugin.json",
        plugin_root / ".mcp.json",
        plugin_root / "hooks" / "hooks.json",
    ]
    if shared_root:
        json_files += [shared_root / "config" / "agents.json",
                       shared_root / "mcp" / "mcp-servers.json"]
    parsed = {}
    for path in json_files:
        if not path.is_file():
            errors.append(f"missing required JSON: {path}")
            continue
        try:
            parsed[str(path)] = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"invalid JSON {path}: {exc}")

    for path in sorted(plugin_root.glob("skills/*/SKILL.md")):
        meta = frontmatter(path.read_text(encoding="utf-8", errors="replace"))
        expected = path.parent.name
        if meta.get("name") != expected:
            errors.append(f"skill name mismatch: {path} ({meta.get('name')!r} != {expected!r})")
        if not meta.get("description"):
            errors.append(f"skill description missing: {path}")
    for path in sorted(plugin_root.glob("agents/*.md")):
        meta = frontmatter(path.read_text(encoding="utf-8", errors="replace"))
        for key in ("name", "description", "tools", "model"):
            if not meta.get(key):
                errors.append(f"agent {path} missing {key}")
        if all(tool in meta.get("tools", "") for tool in ("Bash", "Write", "Edit")):
            warnings.append(f"high-authority agent; confirm scope is necessary: {path.name}")

    roots = [plugin_root]
    if shared_root:
        roots += [shared_root / "bin", shared_root / "config", shared_root / "mcp"]
    for root in roots:
        if not root.exists():
            continue
        for path in (p for p in root.rglob("*") if p.is_file() and ".git" not in p.parts):
            if path.suffix.lower() in (".png", ".jpg", ".jpeg", ".pdf", ".pyc"):
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            for pattern in SECRET_PATTERNS:
                if pattern.search(text):
                    errors.append(f"possible embedded secret in {path}")
            for line_no, line in enumerate(text.splitlines(), 1):
                if "fde-safety-exempt" in line:
                    continue
                for flag in BYPASS_FLAGS:
                    if flag in line:
                        errors.append(f"sandbox-bypass flag {flag} in {path}:{line_no}")

    if shared_root:
        mcp = parsed.get(str(shared_root / "mcp" / "mcp-servers.json"), {})
        atlassian = (mcp.get("servers") or {}).get("atlassian", {})
        if "role:orchestrator" not in atlassian.get("targets", []):
            errors.append("Atlassian MCP is not restricted to the run orchestrator role")
        agents = parsed.get(str(shared_root / "config" / "agents.json"), {})
        for identity, cfg in (agents.get("agents") or {}).items():
            for forbidden in ("role", "defaultRole", "preferred", "default"):
                if forbidden in cfg:
                    errors.append(f"identity {identity} carries fixed role field {forbidden}")
        codex = (agents.get("agents") or {}).get("chatgpt_codex", {})
        if codex.get("write_requires_approval") is not True:
            errors.append("Codex write approval invariant is missing")

    return {"errors": sorted(set(errors)), "warnings": sorted(set(warnings))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugin-root", type=Path,
                        default=Path(__file__).resolve().parents[1])
    parser.add_argument("--shared-root", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = audit(args.plugin_root.resolve(),
                   args.shared_root.resolve() if args.shared_root else None)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        for level in ("errors", "warnings"):
            print(f"{level}: {len(result[level])}")
            for item in result[level]:
                print(f"  - {item}")
    sys.exit(1 if result["errors"] else 0)


if __name__ == "__main__":
    main()
