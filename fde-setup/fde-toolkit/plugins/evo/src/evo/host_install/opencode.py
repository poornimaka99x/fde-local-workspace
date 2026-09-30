"""Opencode plugin install — drop the bundled JS plugin into opencode's
auto-discovery directory, plus install the evo skills via the
cross-host ``npx skills add`` so users don't have to run a second
command.

Opencode discovers plugins from `~/.config/opencode/plugins/*.{ts,js}`
automatically at startup. We ship a pre-bundled `evo.js` (built via
`bun build` from `evo/opencode_plugin/index.ts`).

Skills come from the github.com/evo-hq/evo repo at install time — pinned
to ``--version`` when set (recommended for release-tagged installs).
Local-source mode (``--from-path``) passes a filesystem path through.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Same shape claude_code._RELEASE_VERSION_RE uses to decide whether to
# auto-prefix with `v` for the GitHub tag URL.
_RELEASE_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+([.\-+a-zA-Z0-9]*)$")


def _opencode_plugins_dir(workspace: bool = False) -> Path:
    if workspace:
        return Path.cwd() / ".opencode" / "plugins"
    home = Path.home()
    base = Path(os.environ.get("XDG_CONFIG_HOME", str(home / ".config")))
    return base / "opencode" / "plugins"


def _bundled_plugin_source() -> Path | None:
    """The pre-bundled evo.js shipped inside the evo pip wheel."""
    here = Path(__file__).resolve().parent.parent  # evo/
    bundle = here / "opencode_plugin" / "evo.bundle.js"
    return bundle if bundle.exists() else None


def _skills_source(from_path: str | None, version: str | None) -> str:
    """Source spec for ``npx skills add``.

    Local-source: passes the filesystem path through verbatim (used by
    live tests + manual installs from a clone).

    Tagged release: ``https://github.com/evo-hq/evo.git#v<version>`` —
    npx skills's ``owner/repo@<ref>`` form treats ``<ref>`` as a
    skill-name filter, not a git ref, so all-skills-from-a-tag needs
    the URL form.

    Default: ``evo-hq/evo`` (default branch).
    """
    if from_path:
        return from_path
    if version:
        ref = f"v{version}" if _RELEASE_VERSION_RE.match(version) else version
        return f"https://github.com/evo-hq/evo.git#{ref}"
    return "evo-hq/evo"


def _install_skills(source: str) -> None:
    """Run ``npx -y skills add <source> --agent opencode -g -y``.

    Skips with a warning when npx isn't on PATH. Skills land under
    ``~/.agents/skills/`` (the cross-host convention), which opencode
    auto-discovers along with ``~/.config/opencode/skills/``.
    """
    npx = shutil.which("npx")
    if npx is None:
        print(
            "WARNING: `npx` not on PATH; skipping skill install.\n"
            "  Install Node 22+ (https://nodejs.org), then re-run "
            "`evo install opencode`.",
            file=sys.stderr,
        )
        return
    cmd = [npx, "-y", "skills", "add", source, "--agent", "opencode", "-g", "-y"]
    print(f"$ {' '.join(cmd)}")
    subprocess.call(cmd)


def install(args: argparse.Namespace) -> int:
    src = _bundled_plugin_source()
    if src is None:
        print(
            "ERROR: bundled opencode plugin not found in this evo install.\n"
            "  Expected at evo/opencode_plugin/evo.bundle.js (built via `bun build`).",
            file=sys.stderr,
        )
        return 2

    workspace = bool(getattr(args, "workspace", False))
    target_dir = _opencode_plugins_dir(workspace=workspace)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / "evo.js"

    shutil.copyfile(src, target)
    print(f"installed evo plugin: {target}")

    # Install skills via the cross-host npx skills CLI. Source resolution:
    # --from-path takes precedence, --version tag-pins, otherwise default
    # branch. Skills are always installed globally (-g); --workspace only
    # affects the JS plugin location.
    source = _skills_source(
        getattr(args, "from_path", None),
        getattr(args, "version", None),
    )
    print(f"\nInstalling evo skills via npx skills add (source: {source}) ...")
    _install_skills(source)

    if workspace:
        print("\nWorkspace-local install. Restart `opencode` in this directory to load it.")
    else:
        print("\nGlobal install. Any opencode session will auto-load the plugin at startup.")
    return 0


def uninstall(args: argparse.Namespace) -> int:
    targets = [
        _opencode_plugins_dir(workspace=False) / "evo.js",
        _opencode_plugins_dir(workspace=True) / "evo.js",
    ]
    removed = 0
    for t in targets:
        if t.exists():
            t.unlink()
            print(f"removed: {t}")
            removed += 1
    if removed == 0:
        print("evo plugin not installed for opencode (nothing to remove)")
    return 0


def doctor(args: argparse.Namespace) -> int:
    targets = [
        _opencode_plugins_dir(workspace=False) / "evo.js",
        _opencode_plugins_dir(workspace=True) / "evo.js",
    ]
    found = [t for t in targets if t.exists()]
    if not found:
        print("✗ evo plugin not installed for opencode")
        print("  Run: evo install opencode")
        return 1
    for t in found:
        print(f"✓ {t}")
    return 0
