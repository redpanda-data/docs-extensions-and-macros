"""
Maps rp_util's JSON schema output into property_extractor.py's existing
pre-override property-dict shape, then splices the result into an already-
generated enhanced-output file (the same {"properties": ..., "definitions":
...} shape --enhanced-output writes).

rp_util (see tools/property-extractor/rp-util-fetch.js) gives us default,
bounds, and enterprise-restriction data already resolved at runtime --
unlike property_extractor.py's C++-source parsing, which infers the same
facts by pattern-matching constructor call shapes (see EnterpriseTransformer
in transformers.py). This module never re-runs that inference for the
properties rp_util covers; it derives the equivalent fields directly from
rp_util's fields instead. Topic properties, and anything rp_util doesn't
cover, pass through the existing --enhanced-output file untouched.

Integration point: this splices into the FINAL enhanced-output, not into
property_extractor.py's raw pre-resolution properties dict. That raw dict is
still an intermediate, C++-source-shaped representation (unresolved type
references, unexpanded chrono expressions, numeric enum defaults) that
resolve_type_and_default/map_enum_defaults/evaluate_chrono_expressions exist
specifically to resolve -- rp_util's data is already in the final, resolved
shape those functions produce, so it is spliced in after them, not fed
through them.
"""

import json
import logging
import os

logger = logging.getLogger(__name__)

# rp_util's defined_in string for each schema, keyed by the SCHEMA_FLAGS keys
# rp-util-fetch.js's getRpUtilSchema() returns. Matches the exact literal
# strings add_config_scope() in property_extractor.py already keys on.
DEFINED_IN_BY_SCHEMA_KEY = {
    "clusterSchema": "src/v/config/configuration.cc",
    "nodeSchema": "src/v/config/node_config.cc",
    "pandaproxySchema": "src/v/pandaproxy/rest/configuration.cc",
    "kafkaClientSchema": "src/v/kafka/client/configuration.cc",
    "schemaRegistrySchema": "src/v/pandaproxy/schema_registry/configuration.cc",
}

CONFIG_SCOPE_BY_SCHEMA_KEY = {
    "clusterSchema": "cluster",
    "nodeSchema": "broker",
    "pandaproxySchema": "broker",
    "kafkaClientSchema": "broker",
    "schemaRegistrySchema": "broker",
}


def _parse_embedded_json(value, property_name, field_name):
    """rp_util embeds default/bounds/enterprise values as JSON-encoded
    strings (see cluster_config_property_metadata's default_value/minimum/
    maximum/enterprise_sanctioned_value/enterprise_restricted_value in
    api-doc/cluster_config.json) -- a string containing valid JSON, not the
    value itself."""
    if value is None:
        return None
    try:
        return json.loads(value)
    except (TypeError, ValueError) as exc:
        logger.warning(
            "%s: could not parse rp_util's %s (%r) as JSON: %s",
            property_name, field_name, value, exc,
        )
        return None


def _derive_enterprise_fields(meta, default_value, property_name):
    """Recreate is_enterprise/enterprise_constructor/enterprise_value/
    enterprise_restricted_value/enterprise_sanctioned_value -- the fields
    EnterpriseTransformer (transformers.py) infers from C++ constructor call
    shapes -- directly from rp_util's ground truth instead.

    config::enterprise<P> has exactly two constructors: one that takes only
    a restriction (the sanctioned value then defaults to the property's own
    default value), and one that also takes an explicit sanctioned value.
    rp_util's enterprise_sanctioned_value is therefore always present when
    is_enterprise is true -- whether it differs from the property's own
    default is what distinguishes those two constructors here, since there
    is no separate marker for it (unlike the C++-source pattern matcher's
    "restricted_with_sanctioned" vs. "restricted_only" cases, which come
    from counting constructor arguments).
    """
    is_enterprise = bool(meta.get("is_enterprise", False))
    if not is_enterprise:
        return {"is_enterprise": False}

    fields = {"is_enterprise": True}

    if meta.get("enterprise_restriction_is_dynamic"):
        # The restriction is a predicate function (e.g.
        # is_enterprise_sasl_mechanism), not a static value or list --
        # nothing to enumerate.
        fields["enterprise_constructor"] = "simple"
        return fields

    restricted = _parse_embedded_json(
        meta.get("enterprise_restricted_value"), property_name,
        "enterprise_restricted_value",
    )
    sanctioned = _parse_embedded_json(
        meta.get("enterprise_sanctioned_value"), property_name,
        "enterprise_sanctioned_value",
    )
    restricted_list = restricted if isinstance(restricted, list) else [restricted]

    if sanctioned == default_value:
        fields["enterprise_constructor"] = "restricted_only"
        fields["enterprise_restricted_value"] = restricted_list
        fields["enterprise_value"] = restricted_list  # backward compat, see transformers.py
    else:
        fields["enterprise_constructor"] = "restricted_with_sanctioned"
        fields["enterprise_restricted_value"] = restricted_list
        fields["enterprise_sanctioned_value"] = (
            sanctioned if isinstance(sanctioned, list) else [sanctioned]
        )
    return fields


def map_rp_util_property(name, meta, config_scope, defined_in):
    """Map one rp_util property entry (cluster_config_property_metadata)
    into property_extractor.py's property-dict shape."""
    default_value = _parse_embedded_json(meta.get("default_value"), name, "default_value")

    prop = {
        "name": name,
        "config_scope": config_scope,
        "defined_in": defined_in,
        "description": meta.get("description") or "",
        "type": meta.get("type"),
        "nullable": bool(meta.get("nullable", False)),
        "needs_restart": bool(meta.get("needs_restart", False)),
        "visibility": meta.get("visibility"),
        # rp_util's for_each() already excludes is_hidden() properties
        # (see cluster_config_schema_util.cc), so anything reaching here
        # is, by construction, not deprecated-and-hidden.
        "is_deprecated": False,
        "default": default_value,
    }

    if meta.get("enum_values"):
        prop["enum"] = meta["enum_values"]
    if meta.get("items"):
        prop["items"] = meta["items"]
    if meta.get("example") is not None:
        prop["example"] = meta["example"]
    if meta.get("units") is not None:
        prop["units"] = meta["units"]
    if meta.get("aliases"):
        prop["aliases"] = meta["aliases"]

    minimum = _parse_embedded_json(meta.get("minimum"), name, "minimum")
    if minimum is not None:
        prop["minimum"] = minimum
    maximum = _parse_embedded_json(meta.get("maximum"), name, "maximum")
    if maximum is not None:
        prop["maximum"] = maximum

    prop.update(_derive_enterprise_fields(meta, default_value, name))
    return prop


def map_schema(schema_json, schema_key):
    """Map one rp_util schema blob into a {name: property_dict} dict.
    schema_key is one of DEFINED_IN_BY_SCHEMA_KEY's keys."""
    config_scope = CONFIG_SCOPE_BY_SCHEMA_KEY[schema_key]
    defined_in = DEFINED_IN_BY_SCHEMA_KEY[schema_key]
    properties = (schema_json or {}).get("properties", {})
    return {
        name: map_rp_util_property(name, meta, config_scope, defined_in)
        for name, meta in properties.items()
    }


def map_rp_util_schemas(schemas):
    """Map every schema in `schemas` (the dict rp-util-fetch.js's
    getRpUtilSchema() returns) into one combined {name: property_dict} dict
    covering all of cluster and broker scope."""
    combined = {}
    for schema_key in DEFINED_IN_BY_SCHEMA_KEY:
        if schema_key in schemas:
            combined.update(map_schema(schemas[schema_key], schema_key))
    return combined


def merge_with_existing_output(
    existing_properties_and_definitions, rp_util_schemas, overrides,
    overrides_file_path=None, cloud_config=None,
):
    """
    Replace every cluster- and broker-scope property in an existing
    enhanced-output dict (property_extractor.py's --enhanced-output shape)
    with rp_util-derived data, running the same override-application (and,
    if given, cloud metadata) steps used for every other property so both
    sources produce identically-shaped output. Topic properties -- and
    anything rp_util doesn't cover -- pass through untouched.

    @param existing_properties_and_definitions: {"properties": {...}, "definitions": {...}}
    @param rp_util_schemas: dict as returned by rp-util-fetch.js's getRpUtilSchema()
    @param overrides: parsed docs-data/property-overrides.json contents
    @param cloud_config: an already-fetched cloud_config.CloudConfig, or None to skip
        cloud metadata (mirrors property_extractor.py's own --cloud-support flag)
    """
    # Imported lazily: property_extractor.py has heavy import-time side
    # effects (tree-sitter setup) that only matter when this module runs as
    # part of the full pipeline invoking it, not for its own unit tests.
    from property_extractor import apply_property_overrides

    raw = map_rp_util_schemas(rp_util_schemas)
    enhanced = apply_property_overrides(raw, overrides, overrides_file_path)

    if cloud_config is not None:
        from cloud_config import add_cloud_support_metadata
        add_cloud_support_metadata(enhanced, cloud_config)

    merged_properties = dict(existing_properties_and_definitions.get("properties", {}))
    replaced = sum(1 for name in enhanced if name in merged_properties)
    added = len(enhanced) - replaced
    merged_properties.update(enhanced)

    logger.info(
        "rp_util merge: replaced %d existing propert%s, added %d new from rp_util",
        replaced, "y" if replaced == 1 else "ies", added,
    )

    return {
        "properties": merged_properties,
        "definitions": existing_properties_and_definitions.get("definitions", {}),
    }


def _load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Merge rp_util schema JSON into an existing property_extractor "
                     "--enhanced-output file."
    )
    parser.add_argument("--enhanced", required=True,
                         help="Path to the existing --enhanced-output JSON file")
    parser.add_argument("--rp-util-dir", required=True,
                         help="Directory containing <schemaKey>.json files, "
                              "one per rp-util-fetch.js SCHEMA_FLAGS key")
    parser.add_argument("--overrides", help="Path to property-overrides.json")
    parser.add_argument("--output", required=True, help="Where to write the merged JSON")
    args = parser.parse_args()

    existing = _load_json(args.enhanced)

    schemas = {}
    for schema_key in DEFINED_IN_BY_SCHEMA_KEY:
        schema_path = os.path.join(args.rp_util_dir, f"{schema_key}.json")
        if os.path.exists(schema_path):
            schemas[schema_key] = _load_json(schema_path)
        else:
            logger.warning("No %s found at %s; that scope keeps its existing (non-rp_util) data",
                            schema_key, schema_path)

    overrides = _load_json(args.overrides) if args.overrides and os.path.exists(args.overrides) else {}

    merged = merge_with_existing_output(existing, schemas, overrides, args.overrides)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=4, sort_keys=True)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
