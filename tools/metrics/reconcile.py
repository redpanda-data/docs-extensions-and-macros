#!/usr/bin/env python3
"""Reconcile a source inventory of metric families with a scrape.

The scrape alone cannot prove the metrics reference is complete: a cluster
exports a family only when the feature that registers it is in use. The
inventory from extract_source.py lists every family the source can register.
This script compares the two and fails when:

  - a family is in the scrape and not in the inventory (the extractor missed
    a registration),
  - a family is in the inventory, not in the scrape, and not explained,
  - a family has a different type in the scrape than in the source, or
  - a scraped family has an empty HELP line.

A missing family is explained when the inventory marks it as never registered
(condition "never"), or when --expected-absent names it with a reason.

Usage:
  reconcile.py --inventory inventory.json \\
      --public-file b0-public.txt [--public-file b1-public.txt ...] \\
      --internal-file b0-internal.txt [...] \\
      [--expected-absent expected-absent.json] [--json]

expected-absent.json maps a family name, or an fnmatch pattern, to the reason
it cannot appear in the scrape:

  {"redpanda_instance_*": "needs a recognized cloud VM"}

Exit codes: 0 reconciled, 1 gaps found, 2 bad input.
Standard library only; Python 3.9+.
"""

import argparse
import fnmatch
import json
import re
import sys

HELP_RE = re.compile(r"^# HELP\s+(\S+)(?:\s+(.*))?$")
TYPE_RE = re.compile(r"^# TYPE\s+(\S+)\s+(\S+)")


def parse_scrape(paths):
    """Union of the families in Prometheus text files: name -> {help, type}."""
    texts = []
    for path in paths:
        with open(path, encoding="utf-8", errors="replace") as handle:
            texts.append(handle.read())
    return parse_scrape_texts(texts)


def parse_scrape_texts(texts):
    """Union of the families in Prometheus payloads: name -> {help, type}."""
    families = {}
    for text in texts:
        if True:
            for line in text.splitlines():
                line = line.rstrip("\n")
                match = HELP_RE.match(line)
                if match:
                    entry = families.setdefault(match.group(1), {"help": None, "type": None})
                    text = (match.group(2) or "").strip()
                    if entry["help"] is None or (not entry["help"] and text):
                        entry["help"] = text
                    continue
                match = TYPE_RE.match(line)
                if match:
                    entry = families.setdefault(match.group(1), {"help": None, "type": None})
                    if entry["type"] is None:
                        entry["type"] = match.group(2)
    return families


def explain(name, entry, expected_absent):
    """The reason a source family may be absent from the scrape, or None."""
    if entry.get("condition") == "never":
        return "never registered"
    if "<" in name:
        # A placeholder such as <upstream>: the real name is set by configuration.
        return "name depends on configuration"
    for pattern, reason in expected_absent.items():
        if name == pattern or fnmatch.fnmatchcase(name, pattern):
            return reason
    return None


def reconcile_endpoint(source, scraped, expected_absent):
    result = {
        "in_source": len(source),
        "scraped": len(scraped),
        "in_both": 0,
        "scrape_only": [],
        "missing_unexplained": [],
        "missing_explained": {},
        "type_mismatch": [],
        "empty_help": [],
    }
    for name in sorted(scraped):
        if name not in source:
            result["scrape_only"].append(name)
            continue
        result["in_both"] += 1
        want = source[name].get("type")
        got = scraped[name]["type"]
        if want and got and want != got:
            result["type_mismatch"].append({"name": name, "source": want, "scrape": got})
        if not scraped[name]["help"]:
            result["empty_help"].append(name)
    for name in sorted(source):
        if name in scraped:
            continue
        reason = explain(name, source[name], expected_absent)
        if reason:
            result["missing_explained"][name] = reason
        else:
            result["missing_unexplained"].append(name)
    return result


def failed(result):
    return bool(result["scrape_only"] or result["missing_unexplained"]
                or result["type_mismatch"] or result["empty_help"])


def print_report(report, out):
    for endpoint in ("public", "internal"):
        r = report[endpoint]
        out.write("%s: %d in source, %d scraped, %d in both, %d missing and explained\n" % (
            endpoint, r["in_source"], r["scraped"], r["in_both"], len(r["missing_explained"])))
        for key, title in (("scrape_only", "In the scrape but not in the source inventory"),
                           ("missing_unexplained", "In source, not scraped, not explained"),
                           ("empty_help", "Scraped with an empty HELP line")):
            if r[key]:
                out.write("  %s (%d):\n" % (title, len(r[key])))
                for name in r[key]:
                    out.write("    %s\n" % name)
        if r["type_mismatch"]:
            out.write("  Type differs between source and scrape (%d):\n" % len(r["type_mismatch"]))
            for item in r["type_mismatch"]:
                out.write("    %s: source %s, scrape %s\n" % (item["name"], item["source"], item["scrape"]))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--inventory", required=True, help="JSON from extract_source.py")
    parser.add_argument("--public-file", action="append", default=[], help="/public_metrics scrape; repeat per broker")
    parser.add_argument("--internal-file", action="append", default=[], help="/metrics scrape; repeat per broker")
    parser.add_argument("--expected-absent", help="JSON of family name or pattern -> reason")
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    args = parser.parse_args(argv)

    if not args.public_file or not args.internal_file:
        sys.stderr.write("error: give at least one --public-file and one --internal-file\n")
        return 2
    try:
        with open(args.inventory, encoding="utf-8") as handle:
            inventory = json.load(handle)
        expected_absent = {}
        if args.expected_absent:
            with open(args.expected_absent, encoding="utf-8") as handle:
                expected_absent = json.load(handle)
        scraped = {"public": parse_scrape(args.public_file), "internal": parse_scrape(args.internal_file)}
    except (OSError, ValueError) as error:
        sys.stderr.write("error: %s\n" % error)
        return 2
    if not isinstance(inventory.get("public"), dict) or not isinstance(inventory.get("internal"), dict):
        sys.stderr.write("error: %s has no public and internal family maps\n" % args.inventory)
        return 2
    if not isinstance(expected_absent, dict):
        sys.stderr.write("error: %s must be a JSON object of name -> reason\n" % args.expected_absent)
        return 2

    report = {endpoint: reconcile_endpoint(inventory[endpoint], scraped[endpoint], expected_absent)
              for endpoint in ("public", "internal")}
    report["unresolved"] = inventory.get("unresolved", [])
    ok = not any(failed(report[endpoint]) for endpoint in ("public", "internal")) and not report["unresolved"]
    report["ok"] = ok

    if args.json:
        json.dump(report, sys.stdout, indent=1)
        sys.stdout.write("\n")
    else:
        print_report(report, sys.stdout)
        if report["unresolved"]:
            sys.stdout.write("Registrations the extractor could not resolve (%d)\n" % len(report["unresolved"]))
        sys.stdout.write("Reconciled.\n" if ok else "Not reconciled.\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
