"""Feature documentation (`feature-specs` artifact profile): templates and
deterministic traceability checks.

A feature record is four Markdown documents — spec, plan, tasks, verification —
kept in the client repository as the maintained record and drafted inside an
FDE run. This module renders the templates and checks structure: IDs, the
relationships between them, required fields and content hashes.

What it does not do, by design:

  It never decides that a requirement is right or that an implementation works.
  A clean result means the documents are well formed and traceable, nothing
  more. Substantive judgement belongs to FDE review and evidence.

  It grants nothing. A ticked task, a `done` status or a passing structural
  check is not execution authority; task-file hashes and the controller's
  approvals are.

  It writes nothing. The controller owns every write; this module only reads
  text and returns findings. See docs/FDE-FEATURE-SPECS.md.

Python 3, standard library only.
"""
from __future__ import annotations

import hashlib
import pathlib
import re

SCHEMA_VERSION = 1
PROFILE = "feature-specs"
PROFILES = (PROFILE,)

# Document name -> the controller stage that owns drafting it. The workflow
# template stages are noted for readers; the controller only knows its own.
DOCUMENTS = ("spec.md", "plan.md", "tasks.md", "verification.md")
DOCUMENT_OWNER = {
    "spec.md": "research",          # workflow stage: solution-requirements
    "plan.md": "solutioning",       # workflow stage: technical-architecture
    "tasks.md": "planning",         # workflow stage: development-planning
    "verification.md": "verification",  # workflow stage: quality-review
}
PRINCIPLES = "PRINCIPLES.md"

# Which documents must exist before a handoff is recorded at a given stage.
# A stage not listed needs the full planning set: by the time anything is being
# built, the spec, plan and tasks all exist.
_PLANNING_SET = ("spec.md", "plan.md", "tasks.md")
REQUIRED_AT = {
    "intake": (),
    "research": ("spec.md",),
    "solutioning": ("spec.md", "plan.md"),
    "review": ("spec.md",),
    "reconciliation": ("spec.md",),
    "presentation": ("spec.md",),
    "planning": _PLANNING_SET,
    "implementation": _PLANNING_SET,
    "verification": DOCUMENTS,
    "deployment": DOCUMENTS,
    "observability": DOCUMENTS,
    "publication": DOCUMENTS,
}

# Documents whose change after a recorded handoff means scope or design moved,
# so the run must reconcile before continuing. verification.md is expected to
# change after implementation: it records outcomes.
SCOPE_DOCUMENTS = ("spec.md", "plan.md", "tasks.md")

FEATURE_ID_RE = re.compile(r"^FEAT-(\d{3,6})$")
KINDS = ("REQ", "TASK", "CHECK", "Q")
_ID_TOKEN_RE = re.compile(r"\b(REQ|TASK|CHECK|Q)-(\d{3,6})-(\d{3,6})\b")
_HEADING_RE = re.compile(r"^###\s+((?:REQ|TASK|CHECK|Q)-\d{3,6}-\d{3,6})\s*[:—-]\s*(.*?)\s*$")
_PLACEHOLDER_RE = re.compile(r"\{\{[^{}]*\}\}")
_FIELD_RE = re.compile(r"^\s*[-*]\s+\**([A-Za-z][A-Za-z ]{1,40}?)\**\s*:\s*\**\s*(.*?)\s*$")

TASK_STATUSES = ("todo", "in-progress", "done", "dropped")
QUESTION_STATUSES = ("open", "answered", "deferred")
CHECK_RESULTS = ("pass", "fail", "not-run", "unavailable")
VERIFICATION_METHODS = ("automated-test", "manual-test", "review", "inspection",
                        "monitoring", "demonstration")

# Things that must never reach a client-facing document. Deliberately narrow:
# a false positive here blocks a handoff, so each pattern names a credential
# shape, not a topic.
_SECRET_PATTERNS = (
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("AWS access key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
    ("Atlassian token", re.compile(r"\bATATT[A-Za-z0-9_=-]{20,}\b")),
    ("bearer token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{24,}=*")),
    ("assigned secret", re.compile(
        r"(?i)\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['\"]?[^\s'\"<>{}]{8,}")),
)

# Repository files that already state working principles. If one exists, the
# feature record references it instead of generating a parallel rulebook.
PRINCIPLE_EQUIVALENTS = (
    "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "docs/principles.md",
    "docs/PRINCIPLES.md", "docs/features/PRINCIPLES.md",
    ".specify/memory/constitution.md", "docs/adr", "docs/decisions",
)


class FeatureSpecError(ValueError):
    pass


def feature_number(feature_id):
    match = FEATURE_ID_RE.match(feature_id or "")
    if not match:
        raise FeatureSpecError(
            f"{feature_id!r} is not a feature id; use FEAT- followed by 3-6 digits, e.g. FEAT-012")
    return match.group(1)


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    return sha256_bytes(pathlib.Path(path).read_bytes())


# ---------------------------------------------------------------- templates --

def render(template_text, *, feature_id, title, run_id, date, extra=None):
    """Substitute {{PLACEHOLDERS}}. Unknown placeholders are left visible so a
    reader sees what still needs filling rather than a silent blank."""
    values = {
        "FEATURE_ID": feature_id,
        "N": feature_number(feature_id),
        "TITLE": title,
        "RUN_ID": run_id,
        "DATE": date,
    }
    values.update(extra or {})

    def sub(match):
        key = match.group(1)
        return str(values[key]) if key in values else match.group(0)

    return re.sub(r"\{\{([A-Z_]+)\}\}", sub, template_text)


# ------------------------------------------------------------------ parsing --

def front_matter(text):
    """A minimal `key: value` front-matter block. Not YAML: no nesting."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    out = {}
    for line in lines[1:]:
        if line.strip() == "---":
            return out
        if ":" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition(":")
            out[key.strip()] = value.strip()
    return {}


def parse_items(text):
    """Every `### <ID>: <title>` block with its `- Field: value` lines.

    Returns (items, duplicates). Each item: {id, kind, number, title, line,
    fields{lower-name: value}, body}.
    """
    items, duplicates, current = [], [], None
    seen = {}
    for n, line in enumerate(text.splitlines(), start=1):
        heading = _HEADING_RE.match(line)
        if heading:
            ident = heading.group(1)
            kind, number, _ = ident.split("-")
            current = {"id": ident, "kind": kind, "number": number,
                       "title": heading.group(2), "line": n, "fields": {}, "body": []}
            if ident in seen:
                duplicates.append((ident, seen[ident], n))
            else:
                seen[ident] = n
            items.append(current)
            continue
        if line.startswith("#"):
            current = None
            continue
        if current is None:
            continue
        field = _FIELD_RE.match(line)
        if field:
            current["fields"][field.group(1).strip().lower()] = field.group(2).strip()
        elif line.strip():
            current["body"].append(line.strip())
    return items, duplicates


def id_list(value):
    """IDs named in a field value, in order, without repeats."""
    out = []
    for kind, a, b in _ID_TOKEN_RE.findall(value or ""):
        ident = f"{kind}-{a}-{b}"
        if ident not in out:
            out.append(ident)
    return out


def _is_none(value):
    return (value or "").strip().lower().strip(".") in ("none", "n/a", "-", "")


def secrets_in(text):
    hits = []
    for n, line in enumerate(text.splitlines(), start=1):
        for label, pattern in _SECRET_PATTERNS:
            if pattern.search(line):
                hits.append((label, n))
    return hits


# --------------------------------------------------------------- validation --

def _finding(severity, code, doc, message, line=None, ident=None):
    row = {"severity": severity, "code": code, "document": doc, "message": message}
    if line is not None:
        row["line"] = line
    if ident:
        row["id"] = ident
    return row


def validate(documents, *, feature_id, stage=None, baseline=None):
    """Structural and traceability findings for one feature.

    documents: {name: bytes} for the files that exist (missing ones absent).
    stage:     controller stage; decides which documents are required. None
               requires only spec.md.
    baseline:  {name: sha256} from the latest recorded handoff, or None.

    Returns a payload with `valid` (no errors), `findings`, `ids` and `hashes`.
    Warnings never make a record invalid; they name things a person should look
    at before claiming the feature is done.
    """
    number = feature_number(feature_id)
    findings = []
    texts, hashes = {}, {}
    for name in DOCUMENTS:
        if name in documents:
            raw = documents[name]
            hashes[name] = sha256_bytes(raw)
            texts[name] = raw.decode("utf-8", errors="replace")

    required = REQUIRED_AT.get(stage, ("spec.md",)) if stage else ("spec.md",)
    # Documents a stage does not yet require are drafts: their IDs, references
    # and credential check still apply, but completeness rules (placeholders,
    # verification results) wait until a stage requires them. With no stage,
    # every document present is held to every rule.
    active = set(required) if stage else set(texts)
    for name in required:
        if name not in texts:
            findings.append(_finding("error", "missing-document", name,
                                     f"{name} is required at {stage or 'any stage'} "
                                     f"(owned by the {DOCUMENT_OWNER[name]} stage)"))

    defined = {}      # id -> (doc, item)
    by_doc = {}
    for name, text in texts.items():
        fm = front_matter(text)
        if fm.get("feature") != feature_id:
            findings.append(_finding("error", "wrong-feature", name,
                                     f"front matter names feature {fm.get('feature') or '(none)'}, "
                                     f"expected {feature_id}"))
        if name in active:
            unfilled = [n for n, line in enumerate(text.splitlines(), start=1)
                        if _PLACEHOLDER_RE.search(line)]
            if unfilled:
                findings.append(_finding("error", "unfilled-placeholder", name,
                                         f"{len(unfilled)} template placeholder line(s) still "
                                         "to fill", unfilled[0]))
        for label, line in secrets_in(text):
            findings.append(_finding("error", "credential", name,
                                     f"looks like a {label}; client-facing documents carry no "
                                     "credentials — remove it and rotate it if it was real", line))
        items, duplicates = parse_items(text)
        by_doc[name] = items
        for ident, first, again in duplicates:
            findings.append(_finding("error", "duplicate-id", name,
                                     f"{ident} is defined twice (lines {first} and {again})",
                                     again, ident))
        for item in items:
            if item["number"] != number:
                findings.append(_finding("error", "foreign-id", name,
                                         f"{item['id']} does not belong to {feature_id}",
                                         item["line"], item["id"]))
            if name == "verification.md":
                continue  # verification entries record results, they define nothing
            owner = {"REQ": "spec.md", "CHECK": "spec.md", "Q": "spec.md",
                     "TASK": "tasks.md"}[item["kind"]]
            if name != owner:
                findings.append(_finding("error", "misplaced-id", name,
                                         f"{item['id']} is defined here; {item['kind']} items "
                                         f"belong in {owner}", item["line"], item["id"]))
                continue
            if item["id"] in defined and defined[item["id"]][0] != name:
                findings.append(_finding("error", "duplicate-id", name,
                                         f"{item['id']} is also defined in {defined[item['id']][0]}",
                                         item["line"], item["id"]))
            defined.setdefault(item["id"], (name, item))

    reqs = {i: it for i, (d, it) in defined.items() if it["kind"] == "REQ"}
    checks = {i: it for i, (d, it) in defined.items() if it["kind"] == "CHECK"}
    tasks = {i: it for i, (d, it) in defined.items() if it["kind"] == "TASK"}
    questions = {i: it for i, (d, it) in defined.items() if it["kind"] == "Q"}

    if "spec.md" in texts and not reqs:
        findings.append(_finding("error", "no-requirements", "spec.md",
                                 "spec.md defines no REQ items"))

    # Every reference anywhere must resolve to a definition.
    for name, text in texts.items():
        for n, line in enumerate(text.splitlines(), start=1):
            # A heading defines its ID, except in verification.md, where a
            # heading records a result for a check defined in spec.md.
            heading = _HEADING_RE.match(line)
            head_id = heading.group(1) if heading and name != "verification.md" else None
            for ident in id_list(line):
                if ident == head_id:
                    continue
                if ident.split("-")[1] != number:
                    findings.append(_finding("error", "foreign-reference", name,
                                             f"references {ident}, which belongs to another feature",
                                             n, ident))
                elif ident not in defined:
                    findings.append(_finding("error", "unknown-reference", name,
                                             f"references {ident}, which is not defined", n, ident))

    # Requirements -> acceptance checks.
    covered = {}
    for cid, check in checks.items():
        req_ids = id_list(check["fields"].get("requirement", "")
                          + " " + check["fields"].get("requirements", ""))
        if not req_ids:
            findings.append(_finding("error", "check-without-requirement", "spec.md",
                                     f"{cid} names no Requirement", check["line"], cid))
        for rid in req_ids:
            covered.setdefault(rid, []).append(cid)
        method = check["fields"].get("verification", "")
        if _is_none(method):
            findings.append(_finding("error", "check-without-method", "spec.md",
                                     f"{cid} has no Verification method", check["line"], cid))
        elif method.split()[0].lower().strip(",;") not in VERIFICATION_METHODS:
            findings.append(_finding("warning", "unusual-method", "spec.md",
                                     f"{cid} verification method {method!r} is not one of "
                                     f"{', '.join(VERIFICATION_METHODS)}", check["line"], cid))
    for rid, req in reqs.items():
        if rid not in covered:
            findings.append(_finding("error", "requirement-without-check", "spec.md",
                                     f"{rid} has no acceptance check", req["line"], rid))

    # Open questions stay explicitly open.
    for qid, question in questions.items():
        status = question["fields"].get("status", "").lower()
        if status not in QUESTION_STATUSES:
            findings.append(_finding("error", "question-without-status", "spec.md",
                                     f"{qid} needs Status: {' | '.join(QUESTION_STATUSES)}",
                                     question["line"], qid))
        elif status == "answered" and _is_none(question["fields"].get("answer")):
            findings.append(_finding("error", "answer-missing", "spec.md",
                                     f"{qid} is marked answered but records no Answer",
                                     question["line"], qid))
        elif status == "open":
            findings.append(_finding("warning", "open-question", "spec.md",
                                     f"{qid} is unresolved", question["line"], qid))

    # Tasks -> requirements, dependencies, completion criteria.
    for tid, task in tasks.items():
        fields = task["fields"]
        req_ids = id_list(fields.get("requirements", "") + " " + fields.get("requirement", ""))
        if not req_ids and _is_none(fields.get("justification")):
            findings.append(_finding("error", "task-without-requirement", "tasks.md",
                                     f"{tid} references no requirement and gives no Justification",
                                     task["line"], tid))
        for rid in req_ids:
            if not rid.startswith("REQ-"):
                findings.append(_finding("error", "task-bad-requirement", "tasks.md",
                                         f"{tid} lists {rid} as a requirement", task["line"], tid))
        for dep in id_list(fields.get("depends on", "")):
            if not dep.startswith("TASK-"):
                findings.append(_finding("error", "task-bad-dependency", "tasks.md",
                                         f"{tid} depends on {dep}, which is not a task",
                                         task["line"], tid))
            elif dep == tid:
                findings.append(_finding("error", "task-self-dependency", "tasks.md",
                                         f"{tid} depends on itself", task["line"], tid))
        if _is_none(fields.get("done when")):
            findings.append(_finding("error", "task-without-completion", "tasks.md",
                                     f"{tid} has no 'Done when' criterion", task["line"], tid))
        status = fields.get("status", "").lower()
        if status not in TASK_STATUSES:
            findings.append(_finding("error", "task-without-status", "tasks.md",
                                     f"{tid} needs Status: {' | '.join(TASK_STATUSES)}",
                                     task["line"], tid))
    cycle = _dependency_cycle(tasks)
    if cycle:
        findings.append(_finding("error", "task-dependency-cycle", "tasks.md",
                                 "task dependencies form a cycle: " + " → ".join(cycle)))
    if "tasks.md" in texts and reqs:
        tasked = {rid for t in tasks.values()
                  for rid in id_list(t["fields"].get("requirements", ""))}
        for rid in reqs:
            if rid not in tasked:
                findings.append(_finding("warning", "requirement-without-task", "tasks.md",
                                         f"{rid} is not referenced by any task", None, rid))

    # Verification: one recorded result per acceptance check. Completion of a
    # task and acceptance of a requirement are different facts, kept apart.
    results = {}
    if "verification.md" in texts and "verification.md" in active:
        for item in by_doc.get("verification.md", []):
            if item["kind"] != "CHECK":
                continue
            if item["id"] not in checks:
                continue  # already reported as an unknown reference below
            result = item["fields"].get("result", "").lower()
            if result not in CHECK_RESULTS:
                findings.append(_finding("error", "result-missing", "verification.md",
                                         f"{item['id']} needs Result: {' | '.join(CHECK_RESULTS)}",
                                         item["line"], item["id"]))
                continue
            results[item["id"]] = result
            if result == "pass" and _is_none(item["fields"].get("evidence")):
                findings.append(_finding("error", "pass-without-evidence", "verification.md",
                                         f"{item['id']} passes with no Evidence",
                                         item["line"], item["id"]))
        for cid, check in checks.items():
            if cid not in results and not any(i["id"] == cid for i in by_doc.get("verification.md", [])):
                findings.append(_finding("error", "check-unrecorded", "verification.md",
                                         f"{cid} has no entry", None, cid))
        for tid, task in tasks.items():
            if task["fields"].get("status", "").lower() != "done":
                continue
            for rid in id_list(task["fields"].get("requirements", "")):
                if not any(results.get(c) == "pass" for c in covered.get(rid, [])):
                    findings.append(_finding("warning", "done-not-accepted", "verification.md",
                                             f"{tid} is done but {rid} has no passing check",
                                             None, rid))

    # Hashes against the latest recorded handoff.
    changed = []
    if baseline:
        for name, digest in baseline.items():
            now_digest = hashes.get(name)
            if now_digest == digest:
                continue
            changed.append(name)
            if name in SCOPE_DOCUMENTS:
                findings.append(_finding(
                    "error", "changed-since-handoff", name,
                    f"{name} {'was removed' if now_digest is None else 'changed'} after the "
                    "recorded handoff; reconcile scope through the run, then record a new handoff"))
            else:
                findings.append(_finding("info", "outcome-updated", name,
                                         f"{name} changed after the recorded handoff"))

    errors = [f for f in findings if f["severity"] == "error"]
    return {
        "schemaVersion": SCHEMA_VERSION,
        "featureId": feature_id,
        "stage": stage,
        "valid": not errors,
        "errorCount": len(errors),
        "warningCount": sum(1 for f in findings if f["severity"] == "warning"),
        "findings": findings,
        "documents": sorted(texts),
        "hashes": hashes,
        "changedSinceHandoff": changed,
        "ids": {"requirements": sorted(reqs), "checks": sorted(checks),
                "tasks": sorted(tasks), "questions": sorted(questions)},
        "results": dict(sorted(results.items())),
        "boundary": ("Structure and traceability only. This does not establish that a "
                     "requirement is correct or that an implementation works, and it grants "
                     "no execution authority."),
    }


def _dependency_cycle(tasks):
    graph = {tid: [d for d in id_list(t["fields"].get("depends on", "")) if d in tasks and d != tid]
             for tid, t in tasks.items()}
    state, stack = {}, []

    def visit(node):
        state[node] = 1
        stack.append(node)
        for nxt in graph.get(node, []):
            if state.get(nxt) == 1:
                return stack[stack.index(nxt):] + [nxt]
            if not state.get(nxt):
                found = visit(nxt)
                if found:
                    return found
        state[node] = 2
        stack.pop()
        return None

    for node in sorted(graph):
        if not state.get(node):
            found = visit(node)
            if found:
                return found
    return None


def read_documents(directory):
    """{name: bytes} for the regular, non-symlink documents present."""
    directory = pathlib.Path(directory)
    out = {}
    for name in DOCUMENTS:
        path = directory / name
        if path.is_file() and not path.is_symlink():
            out[name] = path.read_bytes()
    return out


def principle_equivalents(repo):
    """Repository files that already state working principles."""
    repo = pathlib.Path(repo)
    return [rel for rel in PRINCIPLE_EQUIVALENTS if (repo / rel).exists()]
