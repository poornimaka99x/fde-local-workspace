"""GitDir backend: `.git`-free experiment workspaces via relocated ``GIT_DIR``.

The default ``worktree`` backend runs ``git worktree add``, which plants a
``.git`` file inside every experiment directory. Some hardened execution
environments (notably the Claude Science kernel sandbox, but also any
seatbelt/bwrap profile that protects VCS metadata) deny creating *any* path
named ``.git`` -- files and directories alike. There, ``git worktree`` and even
``git init`` fail with ``Operation not permitted``.

Git, however, never *requires* a path named ``.git``. ``GIT_DIR`` and
``GIT_WORK_TREE`` relocate the repository metadata to any name, anywhere. This
backend uses that: each experiment gets

  * a working tree at ``<run>/worktrees/<exp_id>/`` (no ``.git`` inside it), and
  * its own git directory at ``<run>/gitdirs/<exp_id>/`` (an allowed name),

with the per-experiment object store pointed at the base repo's objects via
``objects/info/alternates`` so nothing is duplicated. Isolation matches the
worktree backend (independent HEAD/index/refs per experiment); the difference is
that not a single ``.git`` path is ever created.

Downstream git invocations (``evo run``'s commit strategy, the benchmark
process) reach the right repository because they run through the
``WorkspaceExecutor`` returned by ``workspace_executor.workspace_executor_for``,
which injects :func:`git_env` for gitdir-backed nodes. Git honours those env
vars regardless of ``cwd``, so no ``.git`` discovery is needed.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from .protocol import AllocateCtx, AllocateResult, BackendError, DiscardCtx


def gitdirs_path(root: Path) -> Path:
    """Directory holding per-experiment relocated git dirs for the active run."""
    from ..core import workspace_path

    return workspace_path(root) / "gitdirs"


def gitdir_for(root: Path, exp_id: str) -> Path:
    """The relocated ``GIT_DIR`` for one experiment."""
    return gitdirs_path(root) / exp_id


def git_env(git_dir: Path, work_tree: Path) -> dict[str, str]:
    """Environment that makes ``git`` operate on a relocated, ``.git``-free repo.

    Merge this over ``os.environ`` before invoking git. ``GIT_CONFIG_GLOBAL`` /
    ``GIT_CONFIG_SYSTEM`` are pinned to the null device because the sandbox that
    motivates this backend also blocks reading the user's global git config;
    identity is supplied explicitly so commits succeed without it.
    """
    return {
        "GIT_DIR": str(git_dir),
        "GIT_WORK_TREE": str(work_tree),
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_AUTHOR_NAME": os.environ.get("GIT_AUTHOR_NAME", "evo"),
        "GIT_AUTHOR_EMAIL": os.environ.get("GIT_AUTHOR_EMAIL", "evo@localhost"),
        "GIT_COMMITTER_NAME": os.environ.get("GIT_COMMITTER_NAME", "evo"),
        "GIT_COMMITTER_EMAIL": os.environ.get("GIT_COMMITTER_EMAIL", "evo@localhost"),
    }


def base_gitdir(root: Path) -> Path:
    """Relocated git directory for the *base* repo of a gitdir-mode workspace
    (the analogue of ``.git`` in a normal repo, under an allowed name)."""
    from ..core import evo_dir

    return evo_dir(root) / "basegit"


def base_git_env(root: Path) -> dict[str, str]:
    """Environment pointing git at the relocated base repo, working tree=root."""
    return git_env(base_gitdir(root), root)


def ensure_gitdir_base(root: Path) -> str:
    """Create a ``.git``-free base repo (relocated ``GIT_DIR``) with a baseline
    commit if none exists. Idempotent. Returns the baseline commit hash.

    This is what lets ``evo init`` run where creating ``.git`` is forbidden:
    the base repo's metadata lives at ``<root>/.evo/basegit`` and evo's own
    state (``.evo/``) is excluded from the baseline so the git dir never tries
    to track itself.
    """
    gd = base_gitdir(root)
    env = {**os.environ, **base_git_env(root)}
    gd.mkdir(parents=True, exist_ok=True)
    if not (gd / "HEAD").exists():
        subprocess.run(["git", "init", "-q"], cwd=str(root), env=env, check=True)
        subprocess.run(["git", "config", "core.bare", "false"],
                       cwd=str(root), env=env, check=True)
    exclude = gd / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    exclude.write_text(".evo/\n", encoding="utf-8")
    has_head = subprocess.run(
        ["git", "rev-parse", "--verify", "HEAD"],
        cwd=str(root), env=env, capture_output=True,
    ).returncode == 0
    if not has_head:
        subprocess.run(["git", "add", "-A"], cwd=str(root), env=env, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "evo: baseline", "--allow-empty"],
            cwd=str(root), env=env, check=True,
        )
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(root), env=env, capture_output=True, text=True,
    ).stdout.strip()


class GitDirBackend:
    """Workspace allocator that isolates experiments with a relocated GIT_DIR
    plus a shared object store, creating no ``.git`` path anywhere."""

    name = "gitdir"

    # ---- git helpers ---------------------------------------------------- #

    @staticmethod
    def _git(args: list[str], *, cwd: Path, env: dict[str, str],
             check: bool = True) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", *args],
            cwd=str(cwd),
            env={**os.environ, **env},
            capture_output=True,
            text=True,
            check=check,
        )

    @classmethod
    def _base_git_dir(cls, root: Path) -> Path:
        """Absolute path to the base repo's git directory (``.git`` or a
        relocated one), for sharing its object store via alternates."""
        proc = subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            cwd=str(root), capture_output=True, text=True, check=True,
        )
        p = Path(proc.stdout.strip())
        return p if p.is_absolute() else (root / p).resolve()

    # ---- allocate ------------------------------------------------------- #

    def allocate(self, ctx: AllocateCtx) -> AllocateResult:
        from ..core import PROJECT_FILE, WORKSPACE_NAME, project_path, worktrees_path

        root = ctx.root
        worktree = worktrees_path(root) / ctx.exp_id
        git_dir = gitdir_for(root, ctx.exp_id)

        # Collision-free by construction, but a partial prior run may have left
        # a stale dir behind; clean both slots before re-allocating.
        for stale in (worktree, git_dir):
            if stale.exists():
                shutil.rmtree(stale, ignore_errors=True)
        worktree.mkdir(parents=True, exist_ok=True)
        git_dir.mkdir(parents=True, exist_ok=True)

        env = git_env(git_dir, worktree)

        # 1. Init the relocated git dir (no `.git` created anywhere).
        self._git(["init", "-q"], cwd=root, env=env)
        # A relocated git dir with GIT_WORK_TREE set must not be bare.
        self._git(["config", "core.bare", "false"], cwd=root, env=env)

        # 2. Share the base repo's object store instead of copying objects.
        base_objects = self._base_git_dir(root) / "objects"
        alternates = git_dir / "objects" / "info" / "alternates"
        alternates.parent.mkdir(parents=True, exist_ok=True)
        # git's alternates parser reads each line literally and does NOT strip a
        # trailing CR (unlike its gitignore parser). Write bytes with a bare LF:
        # Path.write_text() on Windows translates "\n" -> "\r\n", and the "\r"
        # turns the path into "objects\r", which git can't find, silently
        # unlinking the shared store. Forward slashes parse on every platform.
        alternates.write_bytes((base_objects.as_posix() + "\n").encode("utf-8"))

        # 3. Point the experiment branch at the parent commit (reachable via
        #    the shared objects) and materialise it into the working tree.
        probe = self._git(["cat-file", "-e", f"{ctx.parent_commit}^{{commit}}"],
                          cwd=root, env=env, check=False)
        if probe.returncode != 0:
            raise BackendError(
                f"parent commit {ctx.parent_commit[:12]} not found in the shared "
                f"object store for {ctx.exp_id}; is the base repo's git dir "
                f"({self._base_git_dir(root)}) intact? git: {probe.stderr.strip()}"
            )
        self._git(["update-ref", f"refs/heads/{ctx.branch}", ctx.parent_commit],
                  cwd=root, env=env)
        self._git(["symbolic-ref", "HEAD", f"refs/heads/{ctx.branch}"],
                  cwd=root, env=env)
        self._git(["reset", "--hard", ctx.parent_commit], cwd=root, env=env)

        # Propagate project.md into the worktree (uncommitted, like worktree backend).
        project_src = project_path(root)
        if project_src.exists():
            worktree_evo = worktree / WORKSPACE_NAME
            worktree_evo.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(project_src), str(worktree_evo / PROJECT_FILE))

        head = self._git(["rev-parse", "HEAD"], cwd=root, env=env).stdout.strip()
        return AllocateResult(worktree=worktree, commit=head, branch=ctx.branch)

    # ---- teardown ------------------------------------------------------- #

    def discard(self, ctx: DiscardCtx) -> None:
        """Remove the working tree and the relocated git dir (which also drops
        the experiment branch -- refs live inside that git dir, not the base repo)."""
        self._remove(ctx.root, ctx.node)

    def release_lease(self, ctx: DiscardCtx) -> None:
        """No lease state in gitdir mode."""

    def gc(self, ctx: DiscardCtx) -> bool:
        self._remove(ctx.root, ctx.node)
        return True

    def sweep_orphans(self, root: Path, live_exp_ids: set[str]) -> list[str]:
        from ..core import worktrees_path

        removed: list[str] = []
        for base in (worktrees_path(root), gitdirs_path(root)):
            if not base.exists():
                continue
            for path in sorted(base.iterdir()):
                if path.is_dir() and path.name not in live_exp_ids:
                    shutil.rmtree(path, ignore_errors=True)
                    removed.append(str(path))
        return removed

    def reset_all(self, root: Path) -> None:
        """Wipe the active run's working trees and git dirs. Experiment
        branches live inside the per-experiment git dirs, so removing the run
        directory leaves no dangling refs in the base repo."""
        from ..core import workspace_path

        shutil.rmtree(workspace_path(root), ignore_errors=True)

    @staticmethod
    def _remove(root: Path, node: dict) -> None:
        worktree = node.get("worktree")
        if worktree and Path(worktree).exists():
            shutil.rmtree(Path(worktree), ignore_errors=True)
        exp_id = node.get("id")
        if exp_id:
            gd = gitdir_for(root, exp_id)
            if gd.exists():
                shutil.rmtree(gd, ignore_errors=True)
