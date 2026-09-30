"""Claude Science host install.

Claude Science is unlike the file-copy hosts. Its skill catalog is not
file-installable (it is written only through the in-session ``host.skills``
API), and its execution kernel runs in a sandbox that forbids creating any
``.git`` path. So this adapter does the one host-setup step a CLI *can* do
from outside a session: make evo default to the ``gitdir`` execution backend,
which relocates git metadata off ``.git`` so evo runs inside the sandbox.

evo's driving-skills are published into the catalog separately, by the
``evo-autoresearch-claude-science-setup`` skill running inside Claude Science
(github.com/evo-hq/evo-claude-science). A CLI cannot do that part.
"""
from __future__ import annotations

import argparse


def install(args: argparse.Namespace) -> int:
    from ..user_defaults import set_user_default_str

    set_user_default_str("execution_backend", "gitdir")
    print(
        "Claude Science: default execution backend set to `gitdir` "
        "(.git-free). New workspaces (`evo init`) will use it automatically."
    )
    print(
        "Note: evo's driving-skills are published into the Claude Science "
        "catalog by the `evo-autoresearch-claude-science-setup` skill (via "
        "host.skills) from inside a session -- the CLI cannot write the catalog."
    )
    return 0


def uninstall(args: argparse.Namespace) -> int:
    from ..user_defaults import get_user_default_str, unset_user_default

    if get_user_default_str("execution_backend") == "gitdir":
        unset_user_default("execution_backend")
        print("Claude Science: cleared the gitdir backend default.")
    else:
        print("Claude Science: no gitdir default set (nothing to remove).")
    return 0


def doctor(args: argparse.Namespace) -> int:
    from ..user_defaults import get_user_default_str

    backend = get_user_default_str("execution_backend")
    ok = backend == "gitdir"
    mark = "✓" if ok else "✗"
    print(f"{mark} default execution_backend = {backend or '<unset>'} (want: gitdir)")
    if not ok:
        print("  Run: evo install claude-science")
    return 0 if ok else 1
