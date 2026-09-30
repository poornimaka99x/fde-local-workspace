"""Cross-project user defaults for run-behavior preferences.

Unlike the per-repo workspace config (``.evo/config.json``), these live in a
single user-level file so a preference chosen in one project can be remembered
and pre-filled in the next. Discover writes the user's answer here; optimize
reads it as the fallback below the workspace default.

Location: ``$EVO_HOME/defaults.json``, or ``~/.evo/defaults.json`` when
``EVO_HOME`` is unset. ``Path.home()`` resolves on every platform (Windows
included), and the write path reuses ``atomic_write_json`` (parent mkdir +
``os.replace``) and ``advisory_lock`` (portalocker), both already cross-platform.

Recognized keys: ``autonomous``, ``subagents_only`` (booleans).
"""
from __future__ import annotations

import os
from pathlib import Path

from .core import WORKSPACE_NAME, atomic_write_json, load_json, lock_file_for
from .locking import advisory_lock

_VALID_KEYS = frozenset({"autonomous", "subagents_only"})
# String-valued defaults (as opposed to the boolean ones above).
_VALID_STR_KEYS = frozenset({"execution_backend"})


def _dir_usable(path: Path) -> bool:
    """True if `path` can be created and written. Sandboxes that block the home
    directory make `~/.evo` unusable; this lets the caller fall back."""
    try:
        path.mkdir(parents=True, exist_ok=True)
        return os.access(path, os.W_OK)
    except OSError:
        return False


def _resolve_global_evo_dir(env_override: str | None, home: Path,
                            workspace: Path | None) -> Path:
    """Pure resolver for the user-level evo home (see `global_evo_dir`)."""
    if env_override:
        return Path(env_override)
    home_evo = home / ".evo"
    if _dir_usable(home_evo):
        return home_evo
    # `~/.evo` is blocked (e.g. the Claude Science kernel sandbox). Fall back to
    # a workspace-local home so evo still works, and so delegated child kernels
    # resolve a writable home on their own without inheriting `EVO_HOME`.
    if workspace is not None:
        return workspace / WORKSPACE_NAME / "home"
    return home_evo


def global_evo_dir() -> Path:
    """User-level evo home: ``$EVO_HOME`` if set, else ``~/.evo``, else (when the
    home dir is not writable) a workspace-local ``.evo/home``."""
    from .core import find_workspace_root

    return _resolve_global_evo_dir(
        os.environ.get("EVO_HOME"), Path.home(), find_workspace_root()
    )


def global_defaults_path() -> Path:
    return global_evo_dir() / "defaults.json"


def load_user_defaults() -> dict:
    data = load_json(global_defaults_path(), {})
    return data if isinstance(data, dict) else {}


def get_user_default(key: str) -> bool | None:
    """Return the stored bool for ``key``, or None if unset."""
    if key not in _VALID_KEYS:
        raise ValueError(f"unknown user default key: {key!r}")
    value = load_user_defaults().get(key)
    return bool(value) if value is not None else None


def set_user_default(key: str, value: bool) -> None:
    if key not in _VALID_KEYS:
        raise ValueError(f"unknown user default key: {key!r}")
    path = global_defaults_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with advisory_lock(lock_file_for(path)):
        data = load_user_defaults()
        data[key] = bool(value)
        atomic_write_json(path, data)


def get_user_default_str(key: str) -> str | None:
    """Return the stored string for a string-valued default, or None if unset."""
    if key not in _VALID_STR_KEYS:
        raise ValueError(f"unknown string default key: {key!r}")
    value = load_user_defaults().get(key)
    return value if isinstance(value, str) else None


def set_user_default_str(key: str, value: str) -> None:
    if key not in _VALID_STR_KEYS:
        raise ValueError(f"unknown string default key: {key!r}")
    path = global_defaults_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with advisory_lock(lock_file_for(path)):
        data = load_user_defaults()
        data[key] = str(value)
        atomic_write_json(path, data)


def unset_user_default(key: str) -> None:
    """Remove a default (bool or string). No-op if unset."""
    if key not in _VALID_KEYS and key not in _VALID_STR_KEYS:
        raise ValueError(f"unknown user default key: {key!r}")
    path = global_defaults_path()
    if not path.exists():
        return
    with advisory_lock(lock_file_for(path)):
        data = load_user_defaults()
        if key in data:
            del data[key]
            atomic_write_json(path, data)
