"""Build the versioned metrics dataset, redpanda-metrics-<version>.json.

metrics.json lists every series name with a description, a type and label
keys. That is enough to print a page and too little to read from: a histogram
is four unrelated entries, a label has no values, and nothing says which
endpoint a metric is on or where a fact came from.

The dataset has one entry per metric family:

  name, endpoint, type, unit, description, source_description,
  labels [{name, observed_values}], histogram {buckets, series},
  observed, provenance {field: scraped | derived | source}

and, when a source inventory from extract_source.py is given, the file that
defines the family and the families the source can register that this scrape
did not see (observed: false).

Standard library only, so it can be imported and tested without the cluster
dependencies.
"""

import re

SCHEMA_VERSION = 1

# The series a histogram or summary exposes beside its family name.
SERIES_SUFFIXES = ("_bucket", "_count", "_sum")

# More distinct values than this and a label is an identifier (a topic, a
# partition, a group), not a set a reader can learn. The values are left out.
MAX_OBSERVED_VALUES = 12

# Labels that carry series structure, not a dimension of the metric.
STRUCTURAL_LABELS = ("le", "quantile")

_META_RE = re.compile(r"^# (HELP|TYPE|UNIT)\s+(\S+)(?:\s+(.*))?$")
_SAMPLE_RE = re.compile(r"^([A-Za-z_:][A-Za-z0-9_:]*)(\{.*\})?\s+(\S+)(?:\s+\S+)?\s*$")

# Name suffix -> unit. Redpanda emits no # UNIT lines, so the unit is read
# from the name, where the Prometheus naming convention puts it. A trailing
# _total is ignored first. Longer suffixes come first.
_UNIT_SUFFIXES = (
    ("_microseconds", "microseconds"),
    ("_milliseconds", "milliseconds"),
    ("_seconds", "seconds"),
    ("_bytes", "bytes"),
    ("_ratio", "ratio"),
    ("_sec", "seconds"),
    ("_ms", "milliseconds"),
    ("_us", "microseconds"),
)


def parse_labels(text):
    """Parse the inside of a sample's braces into [(key, value)].

    Values are quoted and may hold commas, equals signs and escaped quotes,
    so this walks the text instead of splitting on commas.
    """
    pairs = []
    i, n = 0, len(text)
    while i < n:
        while i < n and text[i] in ", \t":
            i += 1
        start = i
        while i < n and text[i] not in "=,":
            i += 1
        key = text[start:i].strip()
        if not key:
            break
        if i >= n or text[i] != "=":
            pairs.append((key, ""))
            continue
        i += 1
        if i < n and text[i] == '"':
            i += 1
            value = []
            while i < n and text[i] != '"':
                if text[i] == "\\" and i + 1 < n:
                    nxt = text[i + 1]
                    value.append("\n" if nxt == "n" else nxt)
                    i += 2
                    continue
                value.append(text[i])
                i += 1
            i += 1
            pairs.append((key, "".join(value)))
        else:
            start = i
            while i < n and text[i] != ",":
                i += 1
            pairs.append((key, text[start:i].strip()))
    return pairs


def derive_unit(name):
    """The unit a metric name states, or None."""
    base = name[:-len("_total")] if name.endswith("_total") else name
    for suffix, unit in _UNIT_SUFFIXES:
        if base.endswith(suffix):
            return unit
    return None


def _new_family():
    return {"help": None, "type": None, "unit": None, "labels": {}, "buckets": set(), "series": set()}


def parse_exposition(text):
    """Parse Prometheus exposition text into families.

    Returns name -> {help, type, unit, labels: {key: set(values)}, buckets,
    series}. A sample named <family>_bucket, _count or _sum belongs to
    <family> only when <family> has a histogram or summary TYPE line. A name
    that merely ends in _sum or _count, such as a gauge called lag_sum, stays
    its own family.
    """
    families = {}
    samples = []
    for line in text.splitlines():
        if not line.strip():
            continue
        if line.startswith("#"):
            match = _META_RE.match(line)
            if not match:
                continue
            kind, name, value = match.group(1), match.group(2), (match.group(3) or "").strip()
            family = families.setdefault(name, _new_family())
            if kind == "HELP" and not family["help"]:
                family["help"] = value
            elif kind == "TYPE" and family["type"] is None:
                family["type"] = value.split()[0] if value else None
            elif kind == "UNIT" and family["unit"] is None:
                family["unit"] = value or None
            continue
        match = _SAMPLE_RE.match(line)
        if match:
            samples.append((match.group(1), match.group(2)))

    for name, braces in samples:
        owner, suffix = name, None
        if name not in families or families[name]["type"] is None:
            for candidate in SERIES_SUFFIXES:
                base = name[:-len(candidate)]
                if name.endswith(candidate) and families.get(base, {}).get("type") in ("histogram", "summary"):
                    owner, suffix = base, candidate
                    break
        family = families.setdefault(owner, _new_family())
        if suffix:
            family["series"].add(suffix)
        for key, value in parse_labels(braces[1:-1]) if braces else []:
            if key == "le" and suffix == "_bucket":
                family["buckets"].add(value)
                continue
            if key in STRUCTURAL_LABELS:
                continue
            family["labels"].setdefault(key, set()).add(value)
    return families


def merge_families(per_source):
    """Union of the families several brokers report."""
    merged = {}
    for families in per_source:
        for name, family in families.items():
            entry = merged.setdefault(name, _new_family())
            for field in ("help", "type", "unit"):
                if not entry[field] and family[field]:
                    entry[field] = family[field]
            entry["buckets"] |= family["buckets"]
            entry["series"] |= family["series"]
            for key, values in family["labels"].items():
                entry["labels"].setdefault(key, set()).update(values)
    return merged


def _bucket_key(bound):
    try:
        return (0, float(bound))
    except ValueError:
        return (1, 0.0)


def _labels(family):
    labels = []
    for key in sorted(family["labels"]):
        label = {"name": key}
        values = sorted(value for value in family["labels"][key] if value != "")
        if 0 < len(values) <= MAX_OBSERVED_VALUES:
            label["observed_values"] = values
        labels.append(label)
    return labels


def _entry(name, endpoint, family, source):
    kind = family["type"]
    unit = family["unit"]
    provenance = {"type": "scraped", "source_description": "scraped", "description": "scraped", "labels": "scraped"}
    if unit:
        provenance["unit"] = "scraped"
    else:
        unit = derive_unit(name)
        if unit:
            provenance["unit"] = "derived"
    entry = {
        "name": name,
        "endpoint": endpoint,
        "type": kind,
        "unit": unit,
        "description": family["help"] or "",
        "source_description": family["help"] or "",
        "labels": _labels(family),
        "histogram": None,
        "observed": True,
        "provenance": provenance,
    }
    if kind in ("histogram", "summary"):
        entry["histogram"] = {
            "buckets": sorted(family["buckets"], key=_bucket_key),
            "series": [suffix for suffix in SERIES_SUFFIXES if suffix in family["series"]],
        }
        provenance["histogram"] = "scraped"
    if source and source.get("defined_in"):
        entry["defined_in"] = source["defined_in"]
        provenance["defined_in"] = "source"
    return entry


def _source_only_entry(name, endpoint, source):
    """A family the source can register that this scrape did not see."""
    unit = derive_unit(name)
    # Label keys are only known from a scrape, so none are claimed here.
    provenance = {"type": "source"}
    if source.get("help"):
        provenance["source_description"] = "source"
        provenance["description"] = "source"
    if unit:
        provenance["unit"] = "derived"
    entry = {
        "name": name,
        "endpoint": endpoint,
        "type": source.get("type"),
        "unit": unit,
        "description": source.get("help") or "",
        "source_description": source.get("help") or "",
        "labels": [],
        "histogram": {"buckets": [], "series": list(SERIES_SUFFIXES)} if source.get("type") == "histogram" else None,
        "observed": False,
        "provenance": provenance,
    }
    if source.get("defined_in"):
        entry["defined_in"] = source["defined_in"]
        provenance["defined_in"] = "source"
    return entry


def build_dataset(version, public, internal, inventory=None, generated_from=None):
    """The dataset for one release.

    `public` and `internal` are merged families from parse_exposition. With an
    inventory, families only the source knows are added as observed: false,
    except the ones the source marks as never registered, which are listed
    under `excluded` with the reason.
    """
    metrics = {}
    excluded = []
    for endpoint, families in (("public", public), ("internal", internal)):
        source = (inventory or {}).get(endpoint, {})
        for name in sorted(families):
            metrics[name] = _entry(name, endpoint, families[name], source.get(name))
        for name in sorted(source):
            if name in families:
                continue
            if source[name].get("condition") == "never":
                excluded.append({"name": name, "endpoint": endpoint, "reason": "never registered"})
                continue
            metrics[name] = _source_only_entry(name, endpoint, source[name])

    counts = {"public": 0, "internal": 0, "observed": 0, "source_only": 0, "excluded": len(excluded)}
    for entry in metrics.values():
        counts[entry["endpoint"]] += 1
        counts["observed" if entry["observed"] else "source_only"] += 1

    return {
        "schema_version": SCHEMA_VERSION,
        "redpanda_version": version,
        "generated_from": generated_from or {},
        "counts": counts,
        "metrics": {name: metrics[name] for name in sorted(metrics)},
        "excluded": excluded,
    }


def series_index(dataset):
    """Series name -> family name, for every histogram and summary series.

    A lookup for redpanda_x_bucket uses this to find redpanda_x. It is built
    from the type in the data, never from the suffix alone.
    """
    index = {}
    for name, entry in dataset["metrics"].items():
        histogram = entry.get("histogram")
        if not histogram:
            continue
        for suffix in histogram["series"]:
            index.setdefault(name + suffix, name)
    return index
