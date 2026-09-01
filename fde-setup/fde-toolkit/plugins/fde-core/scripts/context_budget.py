#!/usr/bin/env python3
"""Estimate static context overhead for the FDE Claude plugin.

This is deliberately approximate and read-only. It identifies relative bloat;
it does not claim to know a model's private tokenization or live context state.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re


def estimate_tokens(text: str) -> int:
    return max(1, round(len(text) / 4))


def description_words(text: str) -> int:
    match = re.match(r"^---\n(.*?)\n---", text, re.DOTALL)
    if not match:
        return 0
    line = next((ln for ln in match.group(1).splitlines()
                 if ln.startswith("description:")), "")
    return len(line.partition(":")[2].strip().strip('"').split())


def inventory_files(paths, kind, heavy_lines, description_limit=30):
    items = []
    for path in sorted(paths):
        text = path.read_text(encoding="utf-8", errors="replace")
        lines = len(text.splitlines())
        words = description_words(text)
        flags = []
        if lines > heavy_lines:
            flags.append(f"heavy>{heavy_lines} lines")
        if words > description_limit:
            flags.append(f"description>{description_limit} words")
        items.append({
            "kind": kind,
            "path": str(path),
            "lines": lines,
            "estimatedTokens": estimate_tokens(text),
            "descriptionWords": words,
            "flags": flags,
        })
    return items


def build_report(plugin_root: Path, repo: Path | None):
    items = []
    items += inventory_files(plugin_root.glob("agents/*.md"), "agent", 200)
    items += inventory_files(plugin_root.glob("skills/*/SKILL.md"), "skill", 400)
    items += inventory_files(plugin_root.glob("commands/*.md"), "command", 160)

    if repo:
        for name in ("AGENTS.md", "CLAUDE.md"):
            path = repo / name
            if path.is_file():
                text = path.read_text(encoding="utf-8", errors="replace")
                items.append({
                    "kind": "repo-instructions", "path": str(path),
                    "lines": len(text.splitlines()),
                    "estimatedTokens": estimate_tokens(text),
                    "descriptionWords": 0,
                    "flags": ["instructions>300 lines"] if len(text.splitlines()) > 300 else [],
                })

    mcp_path = plugin_root / ".mcp.json"
    mcp_servers = []
    if mcp_path.is_file():
        try:
            mcp_servers = sorted(json.loads(mcp_path.read_text()).get("mcpServers", {}))
        except (json.JSONDecodeError, OSError):
            mcp_servers = ["(invalid .mcp.json)"]

    totals = {}
    for item in items:
        bucket = totals.setdefault(item["kind"], {"count": 0, "estimatedTokens": 0})
        bucket["count"] += 1
        bucket["estimatedTokens"] += item["estimatedTokens"]
    issues = [item for item in items if item["flags"]]
    return {
        "pluginRoot": str(plugin_root),
        "method": "characters/4; comparative estimate, not live model usage",
        "totals": totals,
        "estimatedStaticTokens": sum(i["estimatedTokens"] for i in items),
        "mcpServers": mcp_servers,
        "issues": issues,
        "heaviest": sorted(items, key=lambda x: x["estimatedTokens"], reverse=True)[:10],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plugin-root", type=Path,
                        default=Path(__file__).resolve().parents[1])
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = build_report(args.plugin_root.resolve(), args.repo.resolve() if args.repo else None)
    if args.json:
        print(json.dumps(report, indent=2))
        return
    print(f"Estimated static context: ~{report['estimatedStaticTokens']:,} tokens")
    for kind, total in sorted(report["totals"].items()):
        print(f"  {kind:<18} {total['count']:>3} files  ~{total['estimatedTokens']:,} tokens")
    print(f"  {'MCP servers':<18} {len(report['mcpServers']):>3} configured  "
          f"{', '.join(report['mcpServers']) or '(none)'}")
    print("\nHeaviest components:")
    for item in report["heaviest"][:5]:
        flags = f" — {', '.join(item['flags'])}" if item["flags"] else ""
        print(f"  ~{item['estimatedTokens']:>5}  {item['path']}{flags}")
    if not report["issues"]:
        print("\nNo size-threshold issues detected.")


if __name__ == "__main__":
    main()
