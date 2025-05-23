import os
import sys
import requests
import re
import json
import logging

'''
## How it works

Fetches metrics from the brokers and parses out the `# HELP` lines, creating:

- `metrics.json`
- `metrics.adoc`

These output files are stored in a versioned folder under `docs/autogenerated/<version>/metrics`, based on the major.minor version provided as the first argument.

## Prerequisites

- **Python 3** & **pip** on your system.
- A Redpanda cluster running with the `public_metrics` and `metrics` endpoints exposed at http://localhost:19644/
'''

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

def fetch_metrics(url):
    """Fetch metrics from the given URL."""
    try:
        response = requests.get(url)
        response.raise_for_status()
        return response.text
    except requests.RequestException as e:
        logging.error(f"Error fetching metrics from {url}: {e}")
        return None

def parse_metrics(metrics_text):
    """
    Parse Prometheus exposition text into a dict:
      metric_name → { description, type, unit, labels: [<label_keys>] }

    - Strips empty `{}` on unlabelled samples
    - Propagates HELP/TYPE from base metrics onto _bucket, _count, _sum
    - Works regardless of # HELP / # TYPE order
    - Captures # UNIT metadata if present
    """

    lines = metrics_text.splitlines()

    # Gather HELP/TYPE metadata in any order
    # Gather HELP/TYPE metadata in any order
    meta = {}  # name → { 'description': str, 'type': str, 'unit': str }
    for line in lines:
        if line.startswith("# HELP"):
            m = re.match(r"# HELP\s+(\S+)\s+(.+)", line)
            if m:
                name, desc = m.groups()
                meta.setdefault(name, {})['description'] = desc
        elif line.startswith("# TYPE"):
            m = re.match(r"# TYPE\s+(\S+)\s+(\S+)", line)
            if m:
                name, mtype = m.groups()
                meta.setdefault(name, {})['type'] = mtype
        elif line.startswith("# UNIT"):
            m = re.match(r"# UNIT\s+(\S+)\s+(.+)", line)
            if m:
                name, unit = m.groups()
                meta.setdefault(name, {})['unit'] = unit
    # Collect label keys from _every_ sample line
    label_map = {}  # name → set(label_keys)
    for line in lines:
        if line.startswith("#"):
            continue

        # labelled: foo{a="1",b="2"}  42
        m_lbl = re.match(r"^(\S+)\{(.+?)\}\s+(.+)", line)
        if m_lbl:
            name, labels_str, _ = m_lbl.groups()
            keys = [kv.split("=",1)[0] for kv in labels_str.split(",")]
        else:
            # unlabelled, maybe with stray {}: foo{} 42  or just foo 42
            m_unlbl = re.match(r"^(\S+?)(?:\{\})?\s+(.+)", line)
            if not m_unlbl:
                continue
            name, _ = m_unlbl.groups()
            keys = []

        label_map.setdefault(name, set()).update(keys)

    # Propagate HELP/TYPE from base histograms/summaries
    for series in list(label_map):
        for suffix in ("_bucket", "_count", "_sum"):
            if series.endswith(suffix):
                base = series[:-len(suffix)]
                if base in meta:
                    meta.setdefault(series, {}).update(meta[base])
                break

    # Merge into final metrics dict, with warnings
    metrics = {}
    all_names = set(meta) | set(label_map)
    for name in sorted(all_names):
        desc = meta.get(name, {}).get("description")
        mtype = meta.get(name, {}).get("type")
        unit = meta.get(name, {}).get("unit")
        labels = sorted(label_map.get(name, []))

        if desc is None:
            logging.warning(f"Metric '{name}' has samples but no # HELP.")
            desc = ""
        if mtype is None:
            logging.warning(f"Metric '{name}' has no # TYPE entry.")

        metrics[name] = {
            "description": desc,
            "type": mtype,
            "unit": unit,
            "labels": labels
        }

    logging.info(f"Extracted {len(metrics)} metrics.")
    return metrics

def output_asciidoc(metrics, adoc_file):
    """Output metrics as AsciiDoc."""
    with open(adoc_file, "w") as f:
        for name, data in metrics.items():
            f.write(f"=== {name}\n\n")
            f.write(f"{data['description']}\n\n")
            f.write(f"*Type*: {data['type']}")
            if data.get("unit"):
                f.write(f"\n\n*Unit*: {data['unit']}")
            if data["labels"]:
                f.write("\n\n*Labels*:\n")
                for label in data["labels"]:
                    f.write(f"\n- `{label}`")
            f.write("\n\n---\n\n")
    logging.info(f"AsciiDoc output written to {adoc_file}")

def output_json(metrics, json_file):
    """Output metrics as JSON."""
    with open(json_file, "w") as f:
        json.dump(metrics, f, indent=4)
    logging.info(f"JSON output written to {json_file}")

def ensure_directory_exists(directory):
    """Ensure the given directory exists."""
    if not os.path.exists(directory):
        os.makedirs(directory)

if __name__ == "__main__":
    # Expect the major.minor version to be provided as the first argument.
    if len(sys.argv) < 2:
        logging.error("Major.minor version must be provided as the first argument. Exiting.")
        sys.exit(1)

    tag_modified = sys.argv[1].strip()

    # Resolve the base autogenerated folder at the repo root
    repo_root = os.getcwd()
    gen_path = os.path.join(repo_root, "autogenerated")
    if not os.path.isdir(gen_path):
        logging.error(f"autogenerated folder not found at: {gen_path}")
        sys.exit(1)

    # Build the output directory using the already provided tag_modified.
    output_dir = os.path.join(gen_path, tag_modified, "metrics")
    ensure_directory_exists(output_dir)

    METRICS_URL = "http://localhost:19644/public_metrics/"
    metrics_text = fetch_metrics(METRICS_URL)
    if not metrics_text:
        logging.error("No public metrics retrieved. Exiting.")
        sys.exit(1)

    public_metrics = parse_metrics(metrics_text)

    # Fetch internal metrics if available.
    INTERNAL_METRICS_URL = "http://localhost:19644/metrics/"
    internal_metrics_text = fetch_metrics(INTERNAL_METRICS_URL)
    if internal_metrics_text:
        internal_metrics = parse_metrics(internal_metrics_text)
    else:
        logging.error("No internal metrics retrieved.")
        internal_metrics = {}

    # Merge public and internal metrics.
    merged_metrics = {
        "public": public_metrics,
        "internal": internal_metrics
    }

    # Define output file paths.
    JSON_OUTPUT_FILE = os.path.join(output_dir, "metrics.json")
    ASCIIDOC_OUTPUT_FILE = os.path.join(output_dir, "metrics.adoc")
    INTERNAL_ASCIIDOC_OUTPUT_FILE = os.path.join(output_dir, "internal-metrics.adoc")

    output_json(merged_metrics, JSON_OUTPUT_FILE)
    output_asciidoc(public_metrics, ASCIIDOC_OUTPUT_FILE)
    output_asciidoc(internal_metrics, INTERNAL_ASCIIDOC_OUTPUT_FILE)
