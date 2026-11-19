#!/usr/bin/env python3
"""Judge and drive a loop in which a model closes metrics gaps.

A gap is a metric the Redpanda source registers and the metrics cluster did
not export (`not_scraped` in metrics-gaps.json). The workflow
.github/workflows/metrics-close-gaps.yml asks a model for a change to the
cluster setup, applies it, runs the cluster and checks the result. The model
only proposes. Everything that decides whether a proposal is valid, whether a
gap closed and what may change is in this script:

  baseline            record the starting gaps and the metrics that were exported
  status              say whether the loop may ask the model again
  context             write the input for one model call
  attempt             count an attempt; fail once the cap is reached
  apply               validate the model's response and apply it
  compare             compare a new run with the baseline
  record              keep or revert the attempt, from the compare result
  check-diff          fail when the working tree changed a path that is off limits
  check-leak          fail when the change carries a line of the Redpanda source
  check-requirements  fail on a requirement marked measured that no run proved
  upgrade-evidence    mark a requirement measured once a run proved it
  report              Markdown for the pull request body

The model never writes docker-compose/metrics/expected-absent.json, and never
writes "evidence": "measured". No subcommand here trusts what the model says
about its own result.

Standard library only; Python 3.9+.
"""

import argparse
import difflib
import fnmatch
import json
import os
import posixpath
import re
import shutil
import subprocess
import sys

BOOTSTRAP = "docker-compose/metrics/bootstrap-extra.yml"
OVERLAY = "docker-compose/metrics/metrics.overlay.yml"
REQUIREMENTS = "docker-compose/metrics/requirements.json"
SCRIPT = "cli-utils/generate-cluster-docs.sh"
# Never editable: an entry here says no cluster can export a metric, which
# hides the gap for good. Only a person adds one.
FORBIDDEN = "docker-compose/metrics/expected-absent.json"
# Files the model may replace as a whole.
WHOLE_FILES = (BOOTSTRAP, OVERLAY)
# Functions of SCRIPT the model may replace. Nothing else in the script.
FUNCTIONS = ("run_metrics_actions", "setup_quota_probe", "throttle_quota_probe")
NEW_FILE_RE = re.compile(r"^docker-compose/metrics/[A-Za-z0-9][A-Za-z0-9._-]*$")

RESPONSE_KEYS = ("edits", "requirements", "notes", "not_exportable", "need_files", "done")
MAX_EDITS = 8
MAX_EDIT_BYTES = 64 * 1024
MAX_REQUIREMENTS = 10
MAX_NOTES = 60
MAX_NOTE_CHARS = 600
MAX_NEED_FILES = 4

# Caps on the input for one model call, in bytes.
SOURCE_FILE_CAP = 8000      # source shown for one file that registers open gaps
SOURCE_TOTAL_CAP = 60000    # all source in one context, the extra files included
NEED_FILE_CAP = 8000        # one extra source file the model asked for
DIFF_CAP = 6000             # the diff of the last attempt
TAIL_CAP = 3000             # the end of the output of a failed run
TAIL_LINES = 40
# Lines around a registration, and around a line that looks like a guard.
BEFORE_REGISTRATION = 30
AFTER_REGISTRATION = 12
AROUND_GUARD = 3
GUARD_RE = re.compile(
    r"config::|shard_local_cfg|feature_table|features::|is_active\(|_enabled|"
    r"disable_metrics|disable_public_metrics|setup_metrics|setup_public_metrics")

# A changed line this long that is also a line of the Redpanda source counts
# as copied source.
LEAK_MIN_CHARS = 30
SOURCE_EXTENSIONS = (".cc", ".h", ".hpp", ".cpp", ".go", ".proto", ".py", ".java", ".rs")

METRIC_RE = re.compile(r"^[A-Za-z0-9_:*]+$")
ID_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
SOURCE_PATH_RE = re.compile(r"^src/[A-Za-z0-9_./-]+$")

EXIT_OK = 0
EXIT_NOTHING = 1    # compare: no gap closed. Checks: the check failed.
EXIT_USAGE = 2      # a file cannot be read, or the attempt cap is reached
EXIT_LOST = 3       # compare: a metric that was exported is gone
EXIT_INVALID = 4    # apply: the response was refused
EXIT_NO_RUN = 5     # apply: the response is valid and changes nothing


class Refused(Exception):
    """A response, a change or a file breaks a rule."""


# ---------------------------------------------------------------------------
# Files and state
# ---------------------------------------------------------------------------

def read_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path, data):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")


def read_text(path):
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def write_text(path, text):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def key_of(entry):
    return "%s:%s" % (entry["endpoint"], entry["name"])


def load_baseline(state):
    return read_json(os.path.join(state, "baseline.json"))


def attempt_count(state):
    path = os.path.join(state, "attempts.json")
    return read_json(path)["count"] if os.path.exists(path) else 0


def attempt_dir(state, number):
    return os.path.join(state, "attempts", "%02d" % number)


def load_summary(state, number):
    path = os.path.join(attempt_dir(state, number), "summary.json")
    return read_json(path) if os.path.exists(path) else {"attempt": number, "status": "unfinished"}


def save_summary(state, number, **fields):
    summary = load_summary(state, number)
    summary.update(fields)
    write_json(os.path.join(attempt_dir(state, number), "summary.json"), summary)
    return summary


def load_progress(state):
    path = os.path.join(state, "progress.json")
    return read_json(path) if os.path.exists(path) else {"closed": []}


def stop_reason(state):
    path = os.path.join(state, "stop")
    return read_text(path).strip() if os.path.exists(path) else ""


def set_stop(state, reason):
    write_text(os.path.join(state, "stop"), reason + "\n")


def load_notes(state):
    path = os.path.join(state, "notes.json")
    return read_json(path) if os.path.exists(path) else {"notes": [], "not_exportable": []}


def git(repo, *args):
    result = subprocess.run(["git", "-C", repo] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        raise Refused("git %s failed: %s" % (" ".join(args), result.stderr.decode("utf-8", "replace").strip()))
    return result.stdout.decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# baseline, attempt, status
# ---------------------------------------------------------------------------

def observed(dataset):
    """The metrics a run exported, as endpoint:name."""
    metrics = dataset.get("metrics")
    if not isinstance(metrics, dict):
        raise Refused("the dataset has no metrics object")
    return sorted("%s:%s" % (entry.get("endpoint"), name)
                  for name, entry in metrics.items() if entry.get("observed") is True)


def gaps_of(gaps_doc):
    gaps = gaps_doc.get("not_scraped") if isinstance(gaps_doc, dict) else None
    if not isinstance(gaps, list):
        raise Refused("the gaps file has no not_scraped list")
    return [{"name": gap["name"], "endpoint": gap["endpoint"], "defined_in": gap.get("defined_in") or "unknown"}
            for gap in gaps]


def cmd_baseline(args):
    gaps = gaps_of(read_json(args.gaps))
    dataset = read_json(args.dataset)
    only = [name.strip() for name in (args.only or "").split(",") if name.strip()]
    if only:
        known = {gap["name"] for gap in gaps}
        for name in only:
            if name not in known:
                print("%s is not a gap in this run, so it is left out." % name)
        gaps = [gap for gap in gaps if gap["name"] in only]
    if os.path.isdir(args.state):
        shutil.rmtree(args.state)
    write_json(os.path.join(args.state, "baseline.json"), {
        "version": dataset.get("redpanda_version"),
        "gaps": gaps,
        "exported": observed(dataset),
    })
    print("Baseline: %d gaps to close, %d metrics exported." % (len(gaps), len(observed(dataset))))
    for gap in gaps:
        print("  %s (%s), registered in %s" % (gap["name"], gap["endpoint"], gap["defined_in"]))
    return EXIT_OK


def cmd_attempt(args):
    count = attempt_count(args.state)
    if count >= args.max:
        sys.stderr.write("The cap of %d attempts is reached. No more runs.\n" % args.max)
        return EXIT_USAGE
    write_json(os.path.join(args.state, "attempts.json"), {"count": count + 1})
    os.makedirs(attempt_dir(args.state, count + 1), exist_ok=True)
    print(count + 1)
    return EXIT_OK


def cmd_status(args):
    reason = stop_reason(args.state)
    if not reason and attempt_count(args.state) >= args.max:
        reason = "The cap of %d attempts is reached." % args.max
    if reason:
        print("stop: %s" % reason)
        return EXIT_NOTHING
    print("continue")
    return EXIT_OK


# ---------------------------------------------------------------------------
# compare and record
# ---------------------------------------------------------------------------

def compare(baseline, gaps_doc, dataset):
    """Closed, remaining and lost, measured against the baseline.

    A gap is closed only when the new run exported the metric. A gap that
    left not_scraped some other way, for example through an override or a
    written reason, is not closed.
    """
    exported = set(observed(dataset))
    still_listed = {key_of(gap) for gap in gaps_of(gaps_doc)}
    closed, remaining = [], []
    for gap in baseline["gaps"]:
        if key_of(gap) in exported:
            closed.append(gap)
        else:
            remaining.append(dict(gap, listed=key_of(gap) in still_listed))
    lost = sorted(set(baseline["exported"]) - exported)
    return {"closed": closed, "remaining": remaining, "lost": lost}


def compare_exit(result):
    if result["lost"]:
        return EXIT_LOST
    return EXIT_OK if result["closed"] else EXIT_NOTHING


def print_compare(result):
    print("Closed: %d. Remaining: %d. Lost: %d." % (len(result["closed"]), len(result["remaining"]), len(result["lost"])))
    for gap in result["closed"]:
        print("  closed     %s (%s)" % (gap["name"], gap["endpoint"]))
    for gap in result["remaining"]:
        note = "" if gap["listed"] else ", no longer listed as a gap and still not exported"
        print("  remaining  %s (%s)%s" % (gap["name"], gap["endpoint"], note))
    for key in result["lost"]:
        endpoint, name = key.split(":", 1)
        print("  lost       %s (%s): exported at the start, not exported now" % (name, endpoint))


def cmd_compare(args):
    result = compare(load_baseline(args.state), read_json(args.gaps), read_json(args.dataset))
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print_compare(result)
    return compare_exit(result)


def restore_snapshot(repo, directory):
    """Put back the files an attempt changed."""
    manifest = read_json(os.path.join(directory, "before", "manifest.json"))
    for index, item in enumerate(manifest):
        target = os.path.join(repo, item["path"])
        if item["existed"]:
            shutil.copyfile(os.path.join(directory, "before", str(index)), target)
        elif os.path.exists(target):
            os.remove(target)


def tail_of(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            lines = handle.read().splitlines()[-TAIL_LINES:]
    except OSError:
        return ""
    return "\n".join(lines)[-TAIL_CAP:]


def cmd_record(args):
    """Decide what an attempt's run means. Keep the change only for progress."""
    state = args.state
    number = attempt_count(state)
    directory = attempt_dir(state, number)
    baseline = load_baseline(state)
    progress = load_progress(state)
    summary = load_summary(state, number)
    if args.failed:
        restore_snapshot(args.repo, directory)
        save_summary(state, number, status="run_failed", kept=False, tail=tail_of(args.log) if args.log else "",
                     outcome="The cluster or the generator failed, so the change was reverted.")
        print("Attempt %d: the run failed. The change was reverted." % number)
    else:
        result = read_json(args.compare)
        closed = sorted(key_of(gap) for gap in result["closed"])
        before = set(progress["closed"])
        newly = sorted(set(closed) - before)
        reopened = sorted(before - set(closed))
        remaining = sorted(key_of(gap) for gap in result["remaining"])
        fields = {"newly_closed": newly, "remaining": remaining, "lost": result["lost"], "reopened": reopened}
        if result["lost"] or reopened:
            restore_snapshot(args.repo, directory)
            what = "A metric that was exported before is gone" if result["lost"] else "A gap that was closed is open again"
            save_summary(state, number, status="reverted", kept=False,
                         outcome="%s, so the change was reverted." % what, **fields)
            print("Attempt %d: %s. The change was reverted." % (number, what.lower()))
        elif not newly:
            restore_snapshot(args.repo, directory)
            save_summary(state, number, status="reverted", kept=False,
                         outcome="The change closed no gap, so it was reverted.", **fields)
            print("Attempt %d: no gap closed. The change was reverted." % number)
        else:
            write_json(os.path.join(state, "progress.json"), {"closed": closed})
            save_summary(state, number, status="kept", kept=True,
                         outcome="The change closed %d gaps and was kept." % len(newly), **fields)
            print("Attempt %d: closed %d gaps. The change was kept." % (number, len(newly)))
            if not remaining:
                set_stop(state, "Every listed gap is closed.")
    if summary.get("done") and not stop_reason(state):
        set_stop(state, "The model said it has nothing more to try.")
    return EXIT_OK


# ---------------------------------------------------------------------------
# The shell script: function-level edits
# ---------------------------------------------------------------------------

def function_span(text, name):
    """Start and end of a function body: after `name() {`, before the closing `}` line."""
    match = re.search(r"(?m)^%s\(\) \{\n" % re.escape(name), text)
    if not match:
        raise Refused("%s has no function %s" % (SCRIPT, name))
    end = text.find("\n}\n", match.end() - 1)
    if end < 0:
        raise Refused("the end of %s was not found in %s" % (name, SCRIPT))
    return match.end(), end + 1


def function_body(text, name):
    start, end = function_span(text, name)
    return text[start:end]


def replace_function(text, name, body):
    if not body.endswith("\n"):
        body += "\n"
    if re.search(r"(?m)^\}", body):
        raise Refused("the body of %s has a } at the start of a line, which would end the function early" % name)
    start, end = function_span(text, name)
    return text[:start] + body + text[end:]


def outside_functions(text):
    """The script with the bodies of the editable functions removed."""
    for name in FUNCTIONS:
        start, end = function_span(text, name)
        text = text[:start] + text[end:]
    return text


def bash_syntax_error(text, directory):
    path = os.path.join(directory, "syntax-check.sh")
    write_text(path, text)
    try:
        result = subprocess.run(["bash", "-n", path], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    finally:
        os.remove(path)
    return result.stderr.decode("utf-8", "replace").strip() if result.returncode != 0 else ""


# ---------------------------------------------------------------------------
# requirements.json: change entries and leave the rest of the file as it is
# ---------------------------------------------------------------------------

def requirement_spans(text):
    """(start, end) of each object in the top-level requirements array."""
    match = re.search(r'"requirements"\s*:\s*\[', text)
    if not match:
        raise Refused("%s has no requirements array" % REQUIREMENTS)
    spans, depth, start, in_string, escaped = [], 0, None, False, False
    index = match.end()
    while index < len(text):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in "{[":
            if depth == 0 and char == "{":
                start = index
            depth += 1
        elif char in "}]":
            if depth == 0:
                return spans, index
            depth -= 1
            if depth == 0 and start is not None:
                spans.append((start, index + 1))
                start = None
        index += 1
    raise Refused("the requirements array in %s does not end" % REQUIREMENTS)


def render_requirement(requirement):
    def inline(value):
        if isinstance(value, dict):
            return "{ %s }" % ", ".join("%s: %s" % (json.dumps(k), inline(v)) for k, v in value.items())
        if isinstance(value, list):
            return "[%s]" % ", ".join(inline(item) for item in value)
        return json.dumps(value, ensure_ascii=False)
    lines = ['      "id": %s' % inline(requirement["id"]),
             '      "metrics": %s' % inline(requirement["metrics"]),
             '      "requires": %s' % inline(requirement["requires"]),
             '      "evidence": %s' % inline(requirement["evidence"])]
    return "{\n%s\n    }" % ",\n".join(lines)


def put_requirements(text, entries):
    """Add each entry, or replace the entry with the same id."""
    for entry in entries:
        spans, array_end = requirement_spans(text)
        existing = [(span, json.loads(text[span[0]:span[1]])) for span in spans]
        match = [(span, current) for span, current in existing if current.get("id") == entry["id"]]
        rendered = render_requirement(entry)
        if match:
            (start, end), current = match[0]
            if current.get("evidence") != "source":
                raise Refused("the requirement %s is marked measured, so it cannot be replaced. "
                              "Add a requirement with a new id." % entry["id"])
            text = text[:start] + rendered + text[end:]
        elif spans:
            last_end = spans[-1][1]
            text = text[:last_end] + ",\n    " + rendered + text[last_end:]
        else:
            text = text[:array_end] + "\n    " + rendered + "\n  " + text[array_end:]
    json.loads(text)
    return text


def matches_any(name, patterns):
    return any(fnmatch.fnmatchcase(name, pattern) for pattern in patterns)


def changed_requirements(repo, base, path):
    """Requirements that are new or differ from the base ref."""
    current = read_json(os.path.join(repo, path)).get("requirements") or []
    try:
        before = json.loads(git(repo, "show", "%s:%s" % (base, path))).get("requirements") or []
    except Refused:
        before = []
    known = {requirement.get("id"): requirement for requirement in before}
    return [requirement for requirement in current if known.get(requirement.get("id")) != requirement]


# ---------------------------------------------------------------------------
# apply
# ---------------------------------------------------------------------------

def text_field(item, field, where, limit=MAX_NOTE_CHARS):
    value = item.get(field)
    if not isinstance(value, str) or not value.strip():
        raise Refused("%s needs a %s" % (where, field))
    if len(value) > limit:
        raise Refused("%s has a %s longer than %d characters" % (where, field, limit))
    return " ".join(value.split())


def check_requirement(entry):
    if not isinstance(entry, dict):
        raise Refused("each requirement is an object")
    extra = set(entry) - {"id", "metrics", "requires", "evidence"}
    if extra:
        raise Refused("a requirement has a key that is not allowed: %s" % ", ".join(sorted(extra)))
    identifier = entry.get("id")
    if not isinstance(identifier, str) or not ID_RE.match(identifier):
        raise Refused("a requirement needs an id in lowercase words joined by hyphens")
    metrics = entry.get("metrics")
    if not isinstance(metrics, list) or not metrics or len(set(metrics)) != len(metrics) \
            or any(not isinstance(name, str) or not METRIC_RE.match(name) for name in metrics):
        raise Refused("the requirement %s needs a metrics list of names or * patterns, each once" % identifier)
    requires = entry.get("requires")
    if not isinstance(requires, list) or not requires:
        raise Refused("the requirement %s needs a requires list" % identifier)
    for item in requires:
        if isinstance(item, dict) and set(item) == {"property", "value"} and isinstance(item["property"], str) and item["property"]:
            continue
        if isinstance(item, dict) and set(item) == {"condition"} and isinstance(item["condition"], str):
            condition = item["condition"]
            if not re.match(r"^([A-Z]|prop:).*\.$", condition) or "\n" in condition:
                raise Refused("the requirement %s has a condition that is not one sentence: "
                              "start with a capital letter or prop:, end with a period" % identifier)
            for macro in re.findall(r"prop:[^\s\[]+(?:\[[^\]]*\])?", condition):
                if not macro.endswith("[link=true]"):
                    raise Refused("the requirement %s names a property as %s. Write prop:<name>[link=true]" % (identifier, macro))
            continue
        raise Refused("the requirement %s has an item that is neither {property, value} nor {condition}" % identifier)
    # The model never decides that something was measured.
    return {"id": identifier, "metrics": metrics, "requires": requires, "evidence": "source"}


def validate_response(response, repo, created):
    """Check the whole response. Returns what to do, or raises Refused."""
    if not isinstance(response, dict):
        raise Refused("the response is not a JSON object")
    extra = set(response) - set(RESPONSE_KEYS)
    if extra:
        raise Refused("the response has a key that is not allowed: %s" % ", ".join(sorted(extra)))
    for key in ("edits", "requirements", "notes", "not_exportable", "need_files"):
        if not isinstance(response.get(key, []), list):
            raise Refused("%s is not a list" % key)
    if not isinstance(response.get("done", False), bool):
        raise Refused("done is not true or false")

    edits = response.get("edits", [])
    if len(edits) > MAX_EDITS:
        raise Refused("more than %d edits" % MAX_EDITS)
    seen, files, functions = set(), {}, {}
    for edit in edits:
        if not isinstance(edit, dict) or set(edit) - {"path", "content", "function"}:
            raise Refused("each edit is {path, content} or {path, function, content}")
        path, content = edit.get("path"), edit.get("content")
        if not isinstance(path, str) or not isinstance(content, str):
            raise Refused("each edit needs a path and a content, both strings")
        if os.path.basename(path.replace("\\", "/")) == os.path.basename(FORBIDDEN):
            raise Refused("expected-absent.json is never editable. Propose the metric in not_exportable")
        if path.startswith("/") or "\\" in path or posixpath.normpath(path) != path or path.startswith(".."):
            raise Refused("the path %s is not a plain path inside the repository" % path)
        if len(content.encode("utf-8")) > MAX_EDIT_BYTES:
            raise Refused("the content for %s is over %d bytes" % (path, MAX_EDIT_BYTES))
        target = (path, edit.get("function"))
        if target in seen:
            raise Refused("%s is edited twice" % path)
        seen.add(target)
        if path == SCRIPT:
            if edit.get("function") not in FUNCTIONS:
                raise Refused("in %s only these functions can be replaced: %s" % (SCRIPT, ", ".join(FUNCTIONS)))
            functions[edit["function"]] = content
            continue
        if "function" in edit:
            raise Refused("function is only for %s" % SCRIPT)
        if path == REQUIREMENTS:
            raise Refused("%s is changed through the requirements list, not as a file" % REQUIREMENTS)
        if path in WHOLE_FILES:
            files[path] = content
        elif NEW_FILE_RE.match(path) and (path in created or not os.path.lexists(os.path.join(repo, path))):
            files[path] = content
        else:
            raise Refused("the path %s is outside what can be changed" % path)

    requirements = response.get("requirements", [])
    if len(requirements) > MAX_REQUIREMENTS:
        raise Refused("more than %d requirements" % MAX_REQUIREMENTS)
    requirements = [check_requirement(entry) for entry in requirements]
    if len({entry["id"] for entry in requirements}) != len(requirements):
        raise Refused("two requirements have the same id")

    notes, not_exportable = [], []
    if len(response.get("notes", [])) + len(response.get("not_exportable", [])) > MAX_NOTES:
        raise Refused("more than %d notes" % MAX_NOTES)
    for kind, fields, target in (("notes", ("tried", "saw"), notes), ("not_exportable", ("reason", "tried"), not_exportable)):
        for item in response.get(kind, []):
            if not isinstance(item, dict) or not isinstance(item.get("metric"), str) or not METRIC_RE.match(item["metric"]):
                raise Refused("each entry in %s needs a metric name" % kind)
            entry = {"metric": item["metric"]}
            for field in fields:
                entry[field] = text_field(item, field, "the %s entry for %s" % (kind, item["metric"]))
            target.append(entry)

    need_files = response.get("need_files", [])
    if len(need_files) > MAX_NEED_FILES:
        raise Refused("more than %d files in need_files" % MAX_NEED_FILES)
    for path in need_files:
        if not isinstance(path, str) or not SOURCE_PATH_RE.match(path) or ".." in path:
            raise Refused("need_files takes paths under src/ in the Redpanda source")

    return {"files": files, "functions": functions, "requirements": requirements, "notes": notes,
            "not_exportable": not_exportable, "need_files": need_files, "done": response.get("done", False)}


def normalized(line):
    return " ".join(line.split())


def source_matches(source, candidates):
    """Candidates that are also a line of a source file under <source>/src."""
    found = set()
    if not candidates:
        return found
    for root, _dirs, names in os.walk(os.path.join(source, "src")):
        for name in names:
            if not name.endswith(SOURCE_EXTENSIONS):
                continue
            try:
                with open(os.path.join(root, name), encoding="utf-8", errors="replace") as handle:
                    for line in handle:
                        line = normalized(line)
                        if line in candidates:
                            found.add(line)
            except OSError:
                continue
    return found


def leak_candidates(texts):
    return {normalized(line) for text in texts for line in text.splitlines() if len(normalized(line)) >= LEAK_MIN_CHARS}


def merge_notes(state, plan):
    notes = load_notes(state)
    for kind in ("notes", "not_exportable"):
        merged = {item["metric"]: item for item in notes[kind]}
        for item in plan[kind]:
            merged[item["metric"]] = item
        notes[kind] = [merged[name] for name in sorted(merged)]
    write_json(os.path.join(state, "notes.json"), notes)


def unified(path, before, after):
    return "".join(difflib.unified_diff(
        before.splitlines(True), after.splitlines(True), "a/" + path, "b/" + path, n=2))


def cmd_apply(args):
    state, repo = args.state, args.repo
    number = attempt_count(state)
    directory = attempt_dir(state, number)
    os.makedirs(directory, exist_ok=True)
    created_path = os.path.join(state, "created.json")
    created = read_json(created_path) if os.path.exists(created_path) else []
    try:
        try:
            response = read_json(args.response)
        except (OSError, ValueError) as error:
            raise Refused("the response file cannot be read as JSON: %s" % error)
        plan = validate_response(response, repo, created)

        after = dict(plan["files"])
        if plan["functions"]:
            script = read_text(os.path.join(repo, SCRIPT))
            for name, body in plan["functions"].items():
                script = replace_function(script, name, body)
            error = bash_syntax_error(script, directory)
            if error:
                raise Refused("%s no longer parses: %s" % (SCRIPT, error.replace(directory, "")))
            after[SCRIPT] = script
        if plan["requirements"]:
            after[REQUIREMENTS] = put_requirements(read_text(os.path.join(repo, REQUIREMENTS)), plan["requirements"])

        if args.source:
            texts = list(plan["files"].values()) + list(plan["functions"].values())
            texts += [json.dumps(plan["requirements"]), json.dumps(plan["notes"]), json.dumps(plan["not_exportable"])]
            texts += [item[field] for kind in ("notes", "not_exportable") for item in plan[kind] for field in item]
            texts += [item.get("condition", "") for entry in plan["requirements"] for item in entry["requires"]]
            if source_matches(args.source, leak_candidates(texts)):
                raise Refused("the response repeats a line of the Redpanda source. Name files, metrics and "
                              "properties, and never quote source code")
    except Refused as error:
        save_summary(state, number, status="invalid", kept=False, error=str(error),
                     outcome="The response was refused and nothing was changed.")
        sys.stderr.write("Refused: %s.\n" % error)
        return EXIT_INVALID

    manifest, diff = [], []
    for index, path in enumerate(sorted(after)):
        target = os.path.join(repo, path)
        existed = os.path.exists(target)
        before = read_text(target) if existed else ""
        if before == after[path] and existed:
            continue
        manifest.append({"path": path, "existed": existed, "before": before})
        diff.append(unified(path, before, after[path]))
        if not existed and path not in created:
            created.append(path)
    # The snapshot is written before the tree changes, so a revert always has it.
    os.makedirs(os.path.join(directory, "before"), exist_ok=True)
    for index, item in enumerate(manifest):
        if item["existed"]:
            write_text(os.path.join(directory, "before", str(index)), item.pop("before"))
        else:
            item.pop("before")
    write_json(os.path.join(directory, "before", "manifest.json"), manifest)
    for item in manifest:
        write_text(os.path.join(repo, item["path"]), after[item["path"]])
    write_json(created_path, created)
    write_text(os.path.join(directory, "applied.diff"), "".join(diff))
    merge_notes(state, plan)
    write_json(os.path.join(state, "need_files.json"), plan["need_files"])
    changed = [item["path"] for item in manifest]
    save_summary(state, number, status="applied", changed=changed, done=plan["done"])
    if not changed:
        save_summary(state, number, status="no_change", kept=False,
                     outcome="The response changed no file, so no cluster was run.")
        if plan["done"]:
            set_stop(state, "The model said it has nothing more to try.")
        print("Attempt %d: the response is valid and changes no file." % number)
        return EXIT_NO_RUN
    print("Attempt %d: applied a change to %s." % (number, ", ".join(changed)))
    return EXIT_OK


# ---------------------------------------------------------------------------
# context
# ---------------------------------------------------------------------------

CONTRACT = """\
# Input for one attempt to close metrics gaps

## What you can change, and how to answer

Answer with one JSON object, written to the response file, with these keys:

- `edits`: a list. Each item is one of:
  - `{"path": "%(bootstrap)s", "content": "<the whole new file>"}`
  - `{"path": "%(overlay)s", "content": "<the whole new file>"}`
  - `{"path": "docker-compose/metrics/<new file name>", "content": "<the whole file>"}` for a file that does not exist yet
  - `{"path": "%(script)s", "function": "<name>", "content": "<the whole new body>"}` where the name is one of %(functions)s. The body is what stands between `name() {` and the closing `}`. The rest of the script cannot change.
- `requirements`: entries to add to `%(requirements)s`, or to replace by `id`. Each is `{"id", "metrics", "requires"}`. An item of `requires` is `{"property": "<name>", "value": <value>}` or `{"condition": "<one sentence>"}`. Evidence is always written as `source`.
- `notes`: `{"metric", "tried", "saw"}` for each gap you did not close.
- `not_exportable`: `{"metric", "reason", "tried"}` for a metric you conclude no cluster can export.
- `need_files`: up to %(need)d paths under `src/` in the Redpanda source to see next time.
- `done`: `true` when you have nothing more to try.

Any other path is refused, and `expected-absent.json` is always refused. A refused response uses up an attempt.
""" % {"bootstrap": BOOTSTRAP, "overlay": OVERLAY, "script": SCRIPT, "requirements": REQUIREMENTS,
       "functions": ", ".join("`%s`" % name for name in FUNCTIONS), "need": MAX_NEED_FILES}


def read_source(source, ref, path):
    """A source file as text, or None. From a checkout, or from a ref of a clone."""
    if not SOURCE_PATH_RE.match(path) or ".." in path:
        return None
    if ref:
        result = subprocess.run(["git", "-C", source, "show", "%s:%s" % (ref, path)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return result.stdout.decode("utf-8", "replace") if result.returncode == 0 else None
    full = os.path.realpath(os.path.join(source, path))
    if not full.startswith(os.path.realpath(source) + os.sep) or not os.path.isfile(full):
        return None
    with open(full, encoding="utf-8", errors="replace") as handle:
        return handle.read()


def registration_lines(lines, names):
    """Indexes of lines that name a metric: the longest suffix of the name found in quotes."""
    found = set()
    for name in names:
        tokens = name.split("_")
        for start in range(len(tokens)):
            quoted = '"%s"' % "_".join(tokens[start:])
            hits = [index for index, line in enumerate(lines) if quoted in line]
            if hits:
                found.update(hits)
                break
    return found


def excerpt(text, names, cap):
    """The part of a source file that matters, and a note when something was left out."""
    if len(text.encode("utf-8")) <= cap:
        return text.rstrip("\n"), ""
    lines = text.splitlines()
    registrations = registration_lines(lines, names)
    keep = set()
    for index in registrations:
        keep.update(range(max(0, index - BEFORE_REGISTRATION), min(len(lines), index + AFTER_REGISTRATION + 1)))
    for index, line in enumerate(lines):
        if GUARD_RE.search(line):
            keep.update(range(max(0, index - AROUND_GUARD), min(len(lines), index + AROUND_GUARD + 1)))
    if not keep:
        keep = set(range(min(len(lines), 80)))
    out, size, previous, cut = [], 0, -1, False
    for index in sorted(keep):
        if index != previous + 1:
            out.append("[... lines %d to %d left out ...]" % (previous + 2, index))
        piece = lines[index]
        size += len(piece.encode("utf-8")) + 1
        if size > cap:
            cut = True
            break
        out.append(piece)
        previous = index
    if not cut and previous + 1 < len(lines):
        out.append("[... lines %d to %d left out ...]" % (previous + 2, len(lines)))
    note = "Trimmed to the registrations and the lines that look like guards"
    if not registrations:
        note += "; no registration was found by name"
    if cut:
        note += "; cut at %d bytes" % cap
    return "\n".join(out), note + "."


def fence(text, language=""):
    ticks = "```"
    while ticks in text:
        ticks += "`"
    return "%s%s\n%s\n%s" % (ticks, language, text.rstrip("\n"), ticks)


def capped(text, cap):
    data = text.encode("utf-8")
    if len(data) <= cap:
        return text, False
    return data[:cap].decode("utf-8", "ignore"), True


def history_lines(state):
    count = attempt_count(state)
    if not count:
        return ["No attempt yet."]
    lines = []
    for number in range(1, count):
        summary = load_summary(state, number)
        changed = ", ".join(os.path.basename(path) for path in summary.get("changed") or []) or "nothing"
        lines.append("- Attempt %d: %s. Changed: %s. %s" % (
            number, summary["status"], changed, summary.get("error") or summary.get("outcome") or ""))
    summary = load_summary(state, count)
    lines += ["", "### Attempt %d, the last one" % count, "",
              "Result: %s. %s" % (summary["status"], summary.get("outcome") or "")]
    if summary.get("error"):
        lines.append("Why it was refused: %s." % summary["error"])
    for label, field in (("Closed by it", "newly_closed"), ("Lost", "lost"), ("Open again", "reopened")):
        if summary.get(field):
            lines.append("%s: %s." % (label, ", ".join(key.split(":", 1)[1] for key in summary[field])))
    diff_path = os.path.join(attempt_dir(state, count), "applied.diff")
    if os.path.exists(diff_path) and read_text(diff_path):
        diff, cut = capped(read_text(diff_path), DIFF_CAP)
        lines += ["", "The change%s:" % (" (cut at %d bytes)" % DIFF_CAP if cut else ""), "", fence(diff, "diff")]
    if summary.get("tail"):
        lines += ["", "The end of the run's output:", "", fence(summary["tail"])]
    return lines


def build_context(state, repo, source, ref):
    """The input for one model call. Parts that change least come first."""
    baseline = load_baseline(state)
    closed = set(load_progress(state)["closed"])
    open_gaps = [gap for gap in baseline["gaps"] if key_of(gap) not in closed]
    groups = {}
    for gap in open_gaps:
        groups.setdefault(gap["defined_in"], []).append(gap)
    trimmed = []
    out = [CONTRACT, "## Redpanda source that registers the open gaps", "",
           "Redpanda %s. This text is for you only. Never copy a line of it into your answer." % (baseline.get("version") or "")]
    budget = SOURCE_TOTAL_CAP
    for path in sorted(groups):
        names = [gap["name"] for gap in groups[path]]
        out += ["", "### %s" % path, ""]
        text = read_source(source, ref, path)
        if text is None:
            out.append("This file could not be read from the source checkout.")
            continue
        if budget <= 0:
            out.append("Left out: the cap of %d bytes of source is used up. Ask for it in need_files." % SOURCE_TOTAL_CAP)
            trimmed.append("%s left out (total cap)" % path)
            continue
        body, note = excerpt(text, names, min(SOURCE_FILE_CAP, budget))
        budget -= len(body.encode("utf-8"))
        if note:
            out += [note, ""]
            trimmed.append("%s trimmed" % path)
        out.append(fence(body, "cpp"))

    need_path = os.path.join(state, "need_files.json")
    need_files = read_json(need_path) if os.path.exists(need_path) else []
    if need_files:
        out += ["", "## Source files you asked for", ""]
        for path in need_files[:MAX_NEED_FILES]:
            out += ["### %s" % path, ""]
            text = read_source(source, ref, path)
            if text is None:
                out += ["No such file in the source checkout.", ""]
                continue
            body, cut = capped(text, min(NEED_FILE_CAP, max(budget, 0)))
            budget -= len(body.encode("utf-8"))
            if cut:
                out += ["Cut at %d bytes." % len(body.encode("utf-8")), ""]
                trimmed.append("%s cut" % path)
            out += [fence(body, "cpp"), ""]

    out += ["", "## The files you can change, as they are now", ""]
    for path in (BOOTSTRAP, OVERLAY, REQUIREMENTS):
        out += ["### %s" % path, "", fence(read_text(os.path.join(repo, path))), ""]
    script = read_text(os.path.join(repo, SCRIPT))
    for name in FUNCTIONS:
        out += ["### %s, the body of %s" % (SCRIPT, name), "", fence(function_body(script, name), "bash"), ""]

    out += ["## Gaps", "", "Open (%d):" % len(open_gaps), ""]
    for path in sorted(groups):
        out.append("- %s: %s" % (path, ", ".join("%s (%s)" % (gap["name"], gap["endpoint"]) for gap in groups[path])))
    if closed:
        out += ["", "Closed so far (%d): %s." % (len(closed), ", ".join(sorted(key.split(":", 1)[1] for key in closed)))]
    notes = load_notes(state)
    if notes["notes"] or notes["not_exportable"]:
        out += ["", "Your notes so far:", ""]
        out += ["- %s: tried %s Saw %s" % (item["metric"], item["tried"][:300], item["saw"][:300]) for item in notes["notes"]]
        out += ["- %s: proposed as not exportable. %s" % (item["metric"], item["reason"][:300]) for item in notes["not_exportable"]]
    out += ["", "## History", ""] + history_lines(state)
    return "\n".join(out) + "\n", trimmed


def cmd_context(args):
    text, trimmed = build_context(args.state, args.repo, args.source, args.ref)
    write_text(args.out, text)
    size = len(text.encode("utf-8"))
    print("Context: %d bytes, about %d tokens at 4 bytes a token." % (size, size // 4))
    print("Trimmed: %s." % ("; ".join(trimmed) if trimmed else "nothing"))
    return EXIT_OK


# ---------------------------------------------------------------------------
# Checks the workflow runs after the loop, with no trust in the model
# ---------------------------------------------------------------------------

def changed_paths(repo, base):
    """(status, path) for every path that differs from the base ref, untracked files included."""
    changes = []
    for line in git(repo, "diff", "--name-status", "--no-renames", base, "--").splitlines():
        status, path = line.split("\t", 1)
        changes.append((status[0], path))
    for path in git(repo, "ls-files", "--others", "--exclude-standard").splitlines():
        changes.append(("A", path))
    return changes


def cmd_check_diff(args):
    problems = []
    try:
        changes = changed_paths(args.repo, args.base)
        for status, path in changes:
            if path == FORBIDDEN:
                problems.append("%s changed. Only a person edits it." % path)
            elif os.path.islink(os.path.join(args.repo, path)):
                problems.append("%s is a symbolic link." % path)
            elif matches_any(path, args.allow):
                continue
            elif status == "A" and matches_any(path, args.allow_new):
                continue
            else:
                problems.append("%s changed and is outside the allowed paths." % path)
        if any(path == SCRIPT for _status, path in changes):
            before = git(args.repo, "show", "%s:%s" % (args.base, SCRIPT))
            if outside_functions(before) != outside_functions(read_text(os.path.join(args.repo, SCRIPT))):
                problems.append("%s changed outside the functions %s." % (SCRIPT, ", ".join(FUNCTIONS)))
    except Refused as error:
        problems.append(str(error))
    for problem in problems:
        sys.stderr.write(problem + "\n")
    if problems:
        return EXIT_NOTHING
    print("Changed paths are all allowed: %s." % (", ".join(sorted({path for _s, path in changes})) or "none"))
    return EXIT_OK


def cmd_check_leak(args):
    try:
        added = []
        for line in git(args.repo, "diff", "--no-renames", "-U0", args.base, "--").splitlines():
            if line.startswith("+") and not line.startswith("+++"):
                added.append(line[1:])
        for path in git(args.repo, "ls-files", "--others", "--exclude-standard").splitlines():
            full = os.path.join(args.repo, path)
            if os.path.isfile(full) and not os.path.islink(full):
                with open(full, encoding="utf-8", errors="replace") as handle:
                    added += handle.read().splitlines()
        for path in args.text or []:
            added += read_text(path).splitlines()
    except (Refused, OSError) as error:
        sys.stderr.write("%s\n" % error)
        return EXIT_USAGE
    found = source_matches(args.source, leak_candidates(added))
    if found:
        sys.stderr.write("%d changed lines are also lines of the Redpanda source. "
                         "Source code must not be copied into this repository.\n" % len(found))
        return EXIT_NOTHING
    print("No changed line is a line of the Redpanda source.")
    return EXIT_OK


def closed_names(compare_path):
    return {gap["name"] for gap in read_json(compare_path)["closed"]}


def cmd_check_requirements(args):
    closed = closed_names(args.compare)
    problems = []
    for requirement in changed_requirements(args.repo, args.base, args.requirements):
        evidence = requirement.get("evidence")
        proved = any(matches_any(name, requirement.get("metrics") or []) for name in closed)
        if evidence == "measured" and not proved:
            problems.append("The requirement %s says measured, and none of its metrics is a gap this run closed. "
                            "It must say source." % requirement.get("id"))
        elif evidence not in ("measured", "source"):
            problems.append("The requirement %s has no valid evidence." % requirement.get("id"))
    for problem in problems:
        sys.stderr.write(problem + "\n")
    if problems:
        return EXIT_NOTHING
    print("Every changed requirement has evidence the run supports.")
    return EXIT_OK


def cmd_upgrade_evidence(args):
    """Mark a changed requirement measured when every metric it matches is a gap the run closed."""
    closed = closed_names(args.compare)
    names = list(read_json(args.dataset)["metrics"])
    path = os.path.join(args.repo, args.requirements)
    text = read_text(path)
    upgraded = []
    for requirement in changed_requirements(args.repo, args.base, args.requirements):
        matched = [name for name in names if matches_any(name, requirement["metrics"])]
        if requirement.get("evidence") != "source" or not matched or any(name not in closed for name in matched):
            continue
        spans, _end = requirement_spans(text)
        for start, end in spans:
            if json.loads(text[start:end]).get("id") == requirement["id"]:
                text = text[:start] + render_requirement(dict(requirement, evidence="measured")) + text[end:]
                upgraded.append(requirement["id"])
                break
    if upgraded:
        json.loads(text)
        write_text(path, text)
    print("Marked measured: %s." % (", ".join(upgraded) or "none"))
    return EXIT_OK


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------

def plain(text):
    """Model text, made safe for a pull request body: one line, no mentions."""
    return " ".join(str(text).split()).replace("@", "@ ").replace("<", "&lt;")


def cmd_report(args):
    result = read_json(args.compare)
    notes = read_json(args.notes) if args.notes and os.path.exists(args.notes) else {"notes": [], "not_exportable": []}
    tried = {item["metric"]: item for item in notes.get("notes", [])}
    proposed = notes.get("not_exportable", [])
    lines = ["## Metrics gaps", ""]
    if args.run_url:
        lines += ["This change was made by an agent and verified by a cluster run in this workflow: %s" % args.run_url, ""]
    lines += ["The run started a fresh cluster from this branch after the agent finished. "
              "A gap counts as closed only when that cluster exported the metric.", "",
              "### Closed, verified by a cluster run (%d)" % len(result["closed"]), ""]
    lines += ["- `%s` (%s), registered in `%s`" % (gap["name"], gap["endpoint"], gap["defined_in"]) for gap in result["closed"]]
    if not result["closed"]:
        lines.append("None.")
    if result["lost"]:
        lines += ["", "### Lost (%d)" % len(result["lost"]), "",
                  "These were exported at the start and not after the change. The change must not merge."]
        lines += ["", ] + ["- `%s` (%s)" % tuple(reversed(key.split(":", 1))) for key in result["lost"]]
    lines += ["", "### Still open (%d)" % len(result["remaining"]), ""]
    for gap in result["remaining"]:
        note = tried.get(gap["name"])
        text = "Tried: %s Saw: %s" % (plain(note["tried"]), plain(note["saw"])) if note else "The agent left no note."
        lines.append("- `%s` (%s), registered in `%s`. %s" % (gap["name"], gap["endpoint"], gap["defined_in"], text))
    if not result["remaining"]:
        lines.append("None.")
    lines += ["", "### Proposed as not exportable, for a person to decide (%d)" % len(proposed), ""]
    if proposed:
        lines += ["The agent could not edit `%s`, and this change does not touch it. "
                  "These are proposals only." % FORBIDDEN, ""]
        lines += ["- `%s`. Reason: %s Tried: %s" % (item["metric"], plain(item["reason"]), plain(item["tried"])) for item in proposed]
    else:
        lines.append("None.")
    print("\n".join(lines))
    return EXIT_OK


# ---------------------------------------------------------------------------

def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def command(name, func, state=True, repo=False):
        p = sub.add_parser(name)
        p.set_defaults(func=func)
        if state:
            p.add_argument("--state", required=True, help="Directory that holds the loop's state")
        if repo:
            p.add_argument("--repo", default=".", help="Root of this repository (default: the current directory)")
        return p

    p = command("baseline", cmd_baseline)
    p.add_argument("--gaps", required=True)
    p.add_argument("--dataset", required=True)
    p.add_argument("--only", help="Comma-separated metric names to limit the run to")
    p = command("attempt", cmd_attempt)
    p.add_argument("--max", type=int, required=True)
    p = command("status", cmd_status)
    p.add_argument("--max", type=int, required=True)
    p = command("compare", cmd_compare)
    p.add_argument("--gaps", required=True)
    p.add_argument("--dataset", required=True)
    p.add_argument("--json", action="store_true")
    p = command("record", cmd_record, repo=True)
    p.add_argument("--compare", help="JSON output of compare for this attempt's run")
    p.add_argument("--failed", action="store_true", help="The cluster or the generator failed")
    p.add_argument("--log", help="Output of the failed run")
    p = command("context", cmd_context, repo=True)
    p.add_argument("--source", required=True, help="Checkout of the Redpanda source at the tag")
    p.add_argument("--ref", help="Read the source from this ref of a clone, not from its working tree")
    p.add_argument("--out", required=True)
    p = command("apply", cmd_apply, repo=True)
    p.add_argument("--response", required=True)
    p.add_argument("--source", help="Checkout of the Redpanda source, to refuse a response that copies it")
    p = command("check-diff", cmd_check_diff, state=False, repo=True)
    p.add_argument("--base", required=True)
    p.add_argument("--allow", action="append", default=[], metavar="GLOB", help="A path that may change")
    p.add_argument("--allow-new", action="append", default=[], metavar="GLOB", help="A path that may be added, not changed")
    p = command("check-leak", cmd_check_leak, state=False, repo=True)
    p.add_argument("--base", required=True)
    p.add_argument("--source", required=True)
    p.add_argument("--text", action="append", help="Another file to check, such as the pull request body")
    p = command("check-requirements", cmd_check_requirements, repo=True)
    p.add_argument("--compare", required=True)
    p.add_argument("--requirements", default=REQUIREMENTS)
    p.add_argument("--base", required=True)
    p = command("upgrade-evidence", cmd_upgrade_evidence, state=False, repo=True)
    p.add_argument("--compare", required=True)
    p.add_argument("--dataset", required=True)
    p.add_argument("--requirements", default=REQUIREMENTS)
    p.add_argument("--base", required=True)
    p = command("report", cmd_report)
    p.add_argument("--compare", required=True)
    p.add_argument("--notes")
    p.add_argument("--run-url")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    try:
        return args.func(args)
    except (OSError, ValueError, KeyError, Refused) as error:
        sys.stderr.write("gap_loop.py %s: %s\n" % (args.command, error))
        return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main())
