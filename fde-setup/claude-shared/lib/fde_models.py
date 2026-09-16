"""Live model discovery for FDE automatic routing.

The routing policy describes judgement (tiers, costs, strengths). Provider CLIs
describe availability.  Mixing those two facts in one hand-maintained list is
how a retired model remains selectable, so this module intersects them at run
time and keeps a last-known-good snapshot for offline use.
"""
from __future__ import annotations

import copy
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import subprocess

SCHEMA_VERSION = 1
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
EFFORTS = ("auto", "low", "medium", "high", "xhigh", "max")
_PROCESS_SNAPSHOT = None


def _now():
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def cache_path(shared):
    override = os.environ.get("FDE_MODEL_CATALOG_CACHE")
    return pathlib.Path(override) if override else pathlib.Path(shared) / "cache" / "model-catalog.json"


def _run(argv, timeout=20):
    result = subprocess.run(argv, text=True, capture_output=True, timeout=timeout, check=False)
    output = result.stdout or ""
    if result.returncode != 0:
        detail = (result.stderr or output or f"exit {result.returncode}").strip().splitlines()
        raise RuntimeError(detail[-1][:240] if detail else f"exit {result.returncode}")
    if len(output.encode("utf-8", errors="replace")) > MAX_OUTPUT_BYTES:
        raise RuntimeError("provider model catalogue exceeded 2 MiB")
    return output


def _codex_models(binary):
    raw = json.loads(_run([binary, "debug", "models"]))
    models = []
    for item in raw.get("models") or []:
        if item.get("visibility") != "list":
            continue
        model_id = item.get("slug")
        if not isinstance(model_id, str) or not model_id:
            continue
        efforts = [entry.get("effort") for entry in item.get("supported_reasoning_levels") or []]
        efforts = [effort for effort in efforts if effort in EFFORTS]
        if efforts:
            models.append({
                "id": model_id,
                "label": item.get("display_name") or model_id,
                "efforts": efforts,
                "priority": item.get("priority"),
            })
    if not models:
        raise RuntimeError("Codex returned no visible routable models")
    return models


def _gemini_models(binary):
    models = []
    for line in _run([binary, "models"]).splitlines():
        model_id, separator, label = line.partition("\t")
        if not separator or not model_id.startswith("gemini-"):
            continue
        match = re.search(r"-(low|medium|high)$", model_id)
        efforts = [match.group(1)] if match else ["medium"]
        models.append({"id": model_id, "label": label.strip() or model_id, "efforts": efforts})
    if not models:
        raise RuntimeError("Antigravity returned no Gemini models")
    return models


def refresh(shared):
    """Query installed provider clients and atomically save a safe snapshot."""
    global _PROCESS_SNAPSHOT
    providers, failures, fallback_providers = {}, {}, []
    target = cache_path(shared)
    try:
        previous = json.loads(target.read_text(encoding="utf-8")).get("providers") or {}
    except (OSError, ValueError, AttributeError):
        previous = {}
    probes = (
        ("codex", _codex_models, os.environ.get("FDE_CODEX_BIN", "codex")),
        ("gemini", _gemini_models, os.environ.get("FDE_AGY_BIN", "agy")),
    )
    for name, probe, binary in probes:
        try:
            providers[name] = {"source": f"{binary} model catalogue", "models": probe(binary)}
        except (OSError, subprocess.SubprocessError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
            failures[name] = str(exc)[:240]
            if isinstance(previous.get(name), dict):
                providers[name] = previous[name]
                fallback_providers.append(name)
    snapshot = {
        "schemaVersion": SCHEMA_VERSION,
        "refreshedAt": _now(),
        "providers": providers,
        "failures": failures,
        "fallbackProviders": fallback_providers,
    }
    if providers:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    _PROCESS_SNAPSHOT = snapshot
    return snapshot


def load_snapshot(shared, *, live=True):
    global _PROCESS_SNAPSHOT
    if _PROCESS_SNAPSHOT is not None:
        return _PROCESS_SNAPSHOT
    mode = os.environ.get("FDE_MODEL_DISCOVERY", "live").strip().lower()
    if mode == "static":
        return None
    if live and mode != "cache":
        fresh = refresh(shared)
        if fresh.get("providers"):
            return fresh
    target = cache_path(shared)
    try:
        cached = json.loads(target.read_text(encoding="utf-8"))
        if cached.get("schemaVersion") == SCHEMA_VERSION and isinstance(cached.get("providers"), dict):
            cached["cacheFallback"] = True
            _PROCESS_SNAPSHOT = cached
            return cached
    except (OSError, ValueError, AttributeError):
        pass
    return _PROCESS_SNAPSHOT


def _classified(provider, discovered):
    model_id = discovered["id"].lower()
    if provider == "codex":
        if "astra" in model_id or "sol" in model_id:
            tier, weight = "premium", 14
            strengths = ["architecture", "reconciliation", "security-review"]
        elif "terra" in model_id:
            tier, weight = "premium", 12
            strengths = ["architecture", "ambiguous-synthesis", "implementation"]
        elif "luna" in model_id or "mini" in model_id:
            tier, weight = "standard", 7
            strengths = ["implementation", "research", "review"]
        else:
            tier, weight = "standard", 6
            strengths = ["implementation", "test-engineering", "independent-read"]
        limitations = ["discovered from the installed Codex catalogue; no 'auto' effort"]
    else:
        if "pro" in model_id:
            tier, weight = "premium", 10
            strengths = ["research", "ambiguous-synthesis", "review"]
        else:
            tier, weight = "standard", 3
            strengths = ["research", "long-context", "review"]
        limitations = ["discovered from the installed Antigravity catalogue"]
    return {
        "id": discovered["id"],
        "label": discovered.get("label") or discovered["id"],
        "tier": tier,
        "efforts": list(discovered["efforts"]),
        "costWeight": weight,
        "contextTokens": None,
        "strengths": strengths,
        "limitations": limitations,
    }


def apply(policy, snapshot):
    """Return policy intersected with live availability, retaining policy judgement."""
    result = copy.deepcopy(policy)
    if not snapshot:
        result["_modelDiscovery"] = {"state": "static", "reason": "live discovery disabled"}
        return result
    for provider in ("codex", "gemini"):
        live = (snapshot.get("providers", {}).get(provider) or {}).get("models")
        if not live:
            continue
        if provider not in result["providers"]:
            result["providers"][provider] = {
                "label": "Gemini through Antigravity" if provider == "gemini" else "ChatGPT / Codex",
                "models": [],
            }
        configured = ((result.get("providers") or {}).get(provider) or {}).get("models") or []
        by_id = {entry["id"]: entry for entry in configured}
        merged = []
        for discovered in live:
            entry = copy.deepcopy(by_id.get(discovered["id"]) or _classified(provider, discovered))
            allowed_efforts = [effort for effort in discovered["efforts"] if effort in EFFORTS]
            entry["efforts"] = [effort for effort in entry["efforts"] if effort in allowed_efforts]
            if not entry["efforts"]:
                entry["efforts"] = allowed_efforts
            if entry["efforts"]:
                entry["label"] = discovered.get("label") or entry.get("label") or entry["id"]
                merged.append(entry)
        if merged:
            result["providers"][provider]["models"] = merged
    availability = {
        name: [{"id": model.get("id"), "efforts": model.get("efforts") or []}
               for model in entry.get("models") or []]
        for name, entry in sorted(snapshot.get("providers", {}).items())
    }
    digest = "sha256:" + hashlib.sha256(
        json.dumps(availability, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    state = ("unavailable" if not snapshot.get("providers")
             else "cache" if snapshot.get("cacheFallback") or snapshot.get("fallbackProviders")
             else "live")
    result["_modelDiscovery"] = {
        "state": state,
        "refreshedAt": snapshot.get("refreshedAt"),
        "catalogDigest": digest,
        "sources": {name: entry.get("source") for name, entry in snapshot.get("providers", {}).items()},
        "failures": snapshot.get("failures") or {},
        "fallbackProviders": snapshot.get("fallbackProviders") or [],
    }
    return result
