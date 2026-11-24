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

# The types the schema allows. Any other TYPE value is stored as null.
METRIC_TYPES = ("counter", "gauge", "histogram", "summary", "untyped")

_NAME_RE = re.compile(r"^[A-Za-z_:][A-Za-z0-9_:]*$")
# An inventory name may also hold a placeholder such as <upstream>, for a
# part of the name that is set at run time.
_INVENTORY_NAME_RE = re.compile(r"^[A-Za-z_:][A-Za-z0-9_:<>]*$")

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

# A rate, not a duration, so the time suffix is not the unit.
_RATE_SUFFIXES = ("_per_sec", "_per_second")


class DatasetError(ValueError):
    """The inputs cannot be turned into a dataset that can be trusted."""


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
    if base.endswith(_RATE_SUFFIXES):
        return None
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
            if not _NAME_RE.match(name):
                continue
            family = families.setdefault(name, _new_family())
            if kind == "HELP" and not family["help"]:
                family["help"] = value
            elif kind == "TYPE" and family["type"] is None:
                declared = value.split()[0] if value else None
                family["type"] = declared if declared in METRIC_TYPES else None
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
            # le and quantile carry a histogram's or a summary's series
            # structure. On any other family they are ordinary labels.
            if key in STRUCTURAL_LABELS and family["type"] in ("histogram", "summary"):
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


def check_inventory(inventory):
    """Raise DatasetError unless the inventory has the shape extract_source.py writes."""
    if not isinstance(inventory, dict):
        raise DatasetError('the top level must be an object with "public" and "internal" objects')
    if inventory.get("ref") is not None and not isinstance(inventory["ref"], str):
        raise DatasetError('"ref" must be a string')
    for endpoint in ("public", "internal"):
        families = inventory.get(endpoint)
        if not isinstance(families, dict):
            raise DatasetError(f'"{endpoint}" must be an object of family name to entry')
        for name, entry in families.items():
            if not _INVENTORY_NAME_RE.match(name):
                raise DatasetError(f'{endpoint} family "{name}" is not a metric name')
            if not isinstance(entry, dict):
                raise DatasetError(f"{endpoint} family {name} must be an object")
            if entry.get("type") is not None and entry["type"] not in METRIC_TYPES:
                raise DatasetError(f'{endpoint} family {name} has the type {entry["type"]!r}, expected one of {", ".join(METRIC_TYPES)}')
            for field in ("help", "defined_in"):
                if entry.get(field) is not None and not isinstance(entry[field], str):
                    raise DatasetError(f'{endpoint} family {name} must have a string "{field}"')
    unresolved = inventory.get("unresolved")
    if unresolved is not None:
        if not isinstance(unresolved, list):
            raise DatasetError('"unresolved" must be a list of registrations')
        for site in unresolved:
            if not isinstance(site, dict):
                raise DatasetError('each "unresolved" item must be an object with "file", "line" and "reason"')
            for field, kinds in (("file", str), ("line", int), ("reason", str)):
                if site.get(field) is not None and not isinstance(site[field], kinds):
                    raise DatasetError(f'an "unresolved" item has a "{field}" that is not a {kinds.__name__}')


def _endpoint_conflicts(public, internal, inventory):
    """Families that the scrape and the inventory put on both endpoints."""
    sides = [(endpoint, families, inventory.get(endpoint, {}))
             for endpoint, families in (("public", public), ("internal", internal))]
    on_both = (set(public) | set(sides[0][2])) & (set(internal) | set(sides[1][2]))
    conflicts = []
    for name in sorted(on_both):
        seen = []
        for endpoint, families, source in sides:
            if name in families:
                seen.append(f"scraped on {endpoint}")
            elif name in source:
                seen.append(f"in the inventory under {endpoint}")
        conflicts.append(f"{name} ({', '.join(seen)})")
    return conflicts


def build_dataset(version, public, internal, inventory=None, generated_from=None):
    """The dataset for one release.

    `public` and `internal` are merged families from parse_exposition. With an
    inventory, families only the source knows are added as observed: false,
    except the ones the source marks as never registered and the ones whose
    name holds a placeholder, which are listed under `excluded` with the
    reason.

    A family has one entry, keyed by its name, so a name on both endpoints
    would lose one side. That raises DatasetError.
    """
    inventory = inventory or {}
    conflicts = _endpoint_conflicts(public, internal, inventory)
    if conflicts:
        raise DatasetError(
            "A family must be on one endpoint, and the scrape and the source inventory must agree on it. "
            "Check: " + "; ".join(conflicts)
        )

    metrics = {}
    excluded = []
    for endpoint, families in (("public", public), ("internal", internal)):
        source = inventory.get(endpoint, {})
        for name in sorted(families):
            metrics[name] = _entry(name, endpoint, families[name], source.get(name))
        for name in sorted(source):
            if name in families:
                continue
            if "<" in name or ">" in name:
                excluded.append({"name": name, "endpoint": endpoint, "reason": "name depends on configuration"})
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
