"""Validate bounded handoffs and aggregate evidence-backed harness evaluations."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path


def read_json(path):
    try:
        document = json.loads(Path(path).read_text())
    except (OSError, ValueError) as exc:
        raise ValueError(f"cannot read JSON: {path}") from exc
    if not isinstance(document, dict):
        raise ValueError("expected a JSON object")
    return document


def text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a nonempty string")
    return value


def strings(value, label, *, empty=False):
    if not isinstance(value, list) or (not value and not empty):
        raise ValueError(f"{label} must be a {'possibly empty ' if empty else 'nonempty '}list")
    for item in value:
        text(item, label)
    if len(set(value)) != len(value):
        raise ValueError(f"{label} contains duplicates")
    return value


def number(value, label, *, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum:
        raise ValueError(f"{label} must be a finite number >= {minimum}")
    return value


def bounded_path(root, relative):
    text(relative, "path")
    root = Path(root).resolve()
    path = (root / relative).resolve()
    if Path(relative).is_absolute() or not path.is_relative_to(root) or path == root:
        raise ValueError("evidence and output paths must stay inside their run directory")
    return path


def evidence(root, row):
    if not isinstance(row, dict):
        raise ValueError("evidence must be an object")
    path = bounded_path(root, row.get("path"))
    try:
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError as exc:
        raise ValueError(f"evidence is unavailable: {row.get('path')}") from exc
    if row.get("sha256") != digest:
        raise ValueError(f"evidence hash mismatch: {row.get('path')}")
    return {"path": row["path"], "sha256": digest}


def validate_handoff(root, relative, run_id):
    doc = read_json(bounded_path(root, relative))
    if doc.get("schemaVersion") != 1 or doc.get("runId") != run_id:
        raise ValueError("handoff schemaVersion or runId does not match")
    for field in ("taskId", "objective", "specialist", "assignedIdentity", "stage", "stopCondition", "escalationCondition"):
        text(doc.get(field), field)
    requirements = strings(doc.get("requirementIds"), "requirementIds")
    evidence(root, doc.get("task"))
    inputs = doc.get("inputEvidence")
    if not isinstance(inputs, list):
        raise ValueError("inputEvidence must be a list")
    for row in inputs:
        evidence(root, row)
        text(row.get("source"), "evidence source")
        text(row.get("retrievedAt"), "evidence retrieval time")
    checks = doc.get("acceptanceChecks")
    if not isinstance(checks, list) or not checks:
        raise ValueError("acceptanceChecks must be nonempty")
    covered = set()
    for check in checks:
        if not isinstance(check, dict) or check.get("requirementId") not in requirements:
            raise ValueError("acceptance check references an unknown requirement")
        text(check.get("check"), "acceptance check")
        covered.add(check["requirementId"])
    if covered != set(requirements):
        raise ValueError("every requirement needs an acceptance check")
    permissions = doc.get("permissions")
    if not isinstance(permissions, dict):
        raise ValueError("permissions must be an object")
    tools = strings(permissions.get("tools"), "permissions.tools", empty=True)
    writes = strings(permissions.get("writePaths"), "permissions.writePaths", empty=True)
    strings(doc.get("ownedPaths"), "ownedPaths", empty=True)
    if doc.get("reviewOnly") not in (True, False) or not isinstance(doc.get("reviewOnly"), bool):
        raise ValueError("reviewOnly must be boolean")
    if doc["reviewOnly"] and (writes or set(tools) - {"Read", "Grep", "Glob"}):
        raise ValueError("review-only handoffs cannot request write, shell, connector or delegation tools")
    if writes and not doc["ownedPaths"]:
        raise ValueError("writers must declare ownedPaths")
    output = doc.get("output")
    if not isinstance(output, dict):
        raise ValueError("output must be an object")
    bounded_path(root, output.get("path"))
    text(output.get("format"), "output format")
    budget = doc.get("budget")
    if not isinstance(budget, dict):
        raise ValueError("budget must be an object")
    attempts = number(budget.get("maxAttempts"), "maxAttempts", minimum=1)
    if not isinstance(attempts, int):
        raise ValueError("maxAttempts must be an integer")
    number(budget.get("maxSeconds"), "maxSeconds", minimum=1)
    number(budget.get("maxCostUnits"), "maxCostUnits")
    return {"schemaVersion": 1, "valid": True, "taskId": doc["taskId"],
            "requirements": requirements, "evidenceFiles": len(inputs) + 1,
            "boundary": "Validated task contract and evidence only; this does not grant tools, approve writes or replace the frozen routing budget."}


def evaluate(suite, results, root):
    if suite.get("schemaVersion") != 1 or results.get("schemaVersion") != 1:
        raise ValueError("evaluation schemaVersion must be 1")
    if results.get("suiteRevision") != suite.get("revision"):
        raise ValueError("suite revision mismatch")
    for field in ("model", "toolVersion", "policyRevision", "evaluator"):
        text(results.get(field), field)
    cases = suite.get("cases")
    if not isinstance(cases, list) or not cases:
        raise ValueError("suite needs cases")
    expected = {}
    for case in cases:
        if not isinstance(case, dict):
            raise ValueError("case must be an object")
        key = text(case.get("id"), "case id")
        if key in expected:
            raise ValueError("duplicate suite case")
        strings(case.get("checks"), "case checks")
        safety = strings(case.get("safetyChecks"), "safety checks", empty=True)
        if not set(safety) <= set(case["checks"]):
            raise ValueError("unknown safety check")
        expected[key] = case
    attempts = results.get("attempts")
    if not isinstance(attempts, list):
        raise ValueError("attempts must be a list")
    grouped = {key: [] for key in expected}
    safety_failures = []
    for row in attempts:
        if not isinstance(row, dict) or row.get("caseId") not in expected:
            raise ValueError("attempt references an unknown case")
        case_id = row["caseId"]
        n = number(row.get("attempt"), "attempt", minimum=1)
        if not isinstance(n, int):
            raise ValueError("attempt must be integer")
        checks = row.get("checks")
        if not isinstance(checks, dict) or set(checks) != set(expected[case_id]["checks"]):
            raise ValueError("attempt must report every declared check exactly once")
        for key, status in checks.items():
            if status not in ("pass", "fail", "unavailable"):
                raise ValueError("check status must be pass, fail or unavailable")
            if key in expected[case_id]["safetyChecks"] and status != "pass":
                safety_failures.append({"caseId": case_id, "attempt": n, "check": key, "status": status})
        artifacts = row.get("evidence")
        if not isinstance(artifacts, list) or not artifacts:
            raise ValueError("each attempt needs hashed evidence")
        for artifact in artifacts:
            evidence(root, artifact)
        for metric in ("latencySeconds", "humanReworkMinutes", "escapedDefects", "reviewerFalsePositives"):
            if row.get(metric) is not None:
                number(row[metric], metric)
        cost = row.get("cost")
        if not isinstance(cost, dict) or cost.get("provenance") not in ("reported", "estimated", "unavailable"):
            raise ValueError("cost needs reported, estimated or unavailable provenance")
        if cost["provenance"] == "unavailable":
            if cost.get("units") is not None:
                raise ValueError("unavailable cost must be null")
        else:
            number(cost.get("units"), "cost units")
        grouped[case_id].append(row)
    first, eventual, missing = 0, 0, []
    outcomes = []
    for key, rows in grouped.items():
        rows.sort(key=lambda row: row["attempt"])
        if [row["attempt"] for row in rows] != list(range(1, len(rows) + 1)):
            raise ValueError("attempts must be unique and contiguous, starting at 1")
        passed = lambda row: all(status == "pass" for status in row["checks"].values())
        if not rows:
            missing.append(key)
        first += bool(rows and passed(rows[0]))
        accepted = bool(rows and passed(rows[-1]))
        eventual += accepted
        outcomes.append({"caseId": key, "firstAttemptPass": bool(rows and passed(rows[0])),
                         "accepted": accepted, "attempts": len(rows)})
    cost_complete = bool(attempts) and all(row["cost"]["provenance"] != "unavailable" for row in attempts)
    total_cost = sum(row["cost"]["units"] for row in attempts) if cost_complete else None
    metrics = {}
    for metric in ("latencySeconds", "humanReworkMinutes", "escapedDefects", "reviewerFalsePositives"):
        values = [row.get(metric) for row in attempts]
        metrics[metric] = {"total": sum(values) if values and all(v is not None for v in values) else None,
                           "measuredAttempts": sum(v is not None for v in values)}
    return {"schemaVersion": 1, "suiteRevision": suite["revision"], "caseCount": len(expected),
            "model": results["model"], "toolVersion": results["toolVersion"],
            "policyRevision": results["policyRevision"], "evaluator": results["evaluator"],
            "firstAttemptAcceptanceRate": first / len(expected),
            "eventualAcceptanceRate": eventual / len(expected), "cases": outcomes,
            "missingCases": missing, "safetyFailures": safety_failures,
            "totalCostUnits": total_cost,
            "costPerAcceptedCase": total_cost / eventual if total_cost is not None and eventual else None,
            "costProvenance": sorted({row["cost"]["provenance"] for row in attempts}),
            "metrics": metrics,
            "pass": not missing and not safety_failures and eventual == len(expected),
            "boundary": "Aggregates supplied check judgments and verifies artifact hashes; does not itself judge semantic correctness or execute models."}
