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

# rp_util's raw "units" value is always this bare abbreviation (verified
# across all cluster+broker properties); property.hbs/topic-property.hbs
# render it via {{capitalize units}}, so passing the abbreviation straight
# through renders "Ms"/"S" instead of the full word the docs actually want
# -- the same vocabulary helpers/formatUnits.js already uses for its
# property-name-suffix fallback.
UNIT_ABBREVIATION_TO_WORD = {"ms": "milliseconds", "s": "seconds"}

JSON_SCHEMA_PRIMITIVES = {"string", "integer", "number", "boolean", "object", "array"}


def _parse_embedded_json(value, property_name, field_name):
    """rp_util embeds default/bounds/enterprise values as JSON-encoded
    strings (see cluster_config_property_metadata's default_value/minimum/
    maximum/enterprise_sanctioned_value in api-doc/cluster_config.json) --
    a string containing valid JSON, not the value itself."""
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


def _build_enum_metadata(enum_values, enterprise_restricted_values):
    """Map rp_util's enterprise_restricted_values (the subset of enum_values
    that requires an enterprise license) into baseline's x-enum-metadata
    shape: every enum value mapped to {"is_enterprise": bool}. Returns None
    when rp_util reports no enterprise-restricted values at all, so a
    property with a plain (non-enterprise) enum never gets a vacuous
    all-false x-enum-metadata block baseline never produced either.
    """
    if not enum_values or not enterprise_restricted_values:
        return None
    enterprise_set = set(enterprise_restricted_values)
    return {v: {"is_enterprise": v in enterprise_set} for v in enum_values}


def _derive_enterprise_fields(meta, default_value, property_name):
    """Recreate is_enterprise/enterprise_constructor/enterprise_value/
    enterprise_restricted_value/enterprise_sanctioned_value (this module's
    own field names, not rp_util's) -- the fields
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
        # The restriction is a predicate function, not a static value or
        # list -- nothing to enumerate.
        fields["enterprise_constructor"] = "simple"
        return fields

    # Unlike enterprise_sanctioned_value below, enterprise_restricted_values
    # is a real JSON array in rp_util's output, not a JSON-encoded string --
    # one item per restricted value, already in the shape this module wants.
    restricted_list = meta.get("enterprise_restricted_values") or []
    sanctioned = _parse_embedded_json(
        meta.get("enterprise_sanctioned_value"), property_name,
        "enterprise_sanctioned_value",
    )

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


def _resolve_type(raw_type, has_enum_values, definitions):
    """Resolve a raw C++ type/class name from rp_util into the JSON-schema
    type name property.hbs actually renders.

    rp_util's own "type" field is a JSON-schema primitive only for scalars;
    for anything else it's the literal C++ class/typedef name (e.g.
    "net::unresolved_address", "tls_config", "leaders_preference"), and
    property.hbs renders `type` literally -- an unmapped pass-through leaks
    C++ internals straight into the published Type column. rp_util's naming
    isn't consistently bare or namespace-qualified (e.g. "leaders_preference"
    is bare where baseline's definitions dict key is
    "config::leaders_preference", but "net::unresolved_address" already
    carries its own prefix), so try bare, then the model:: and config::
    prefixes baseline's definitions dict actually uses.
    """
    if raw_type in JSON_SCHEMA_PRIMITIVES:
        return raw_type

    for candidate in (raw_type, f"model::{raw_type}", f"config::{raw_type}"):
        entry = definitions.get(candidate)
        if entry:
            resolved = entry.get("type", "object")
            # baseline renders enum-backed properties as `string` (enum) in
            # the Type column, never as a bare "enum" -- see property.hbs.
            return "string" if resolved == "enum" else resolved

    # Not found: baseline's definitions dict is known-incomplete (confirmed
    # missing tls_config, throughput_control_group, ...) -- fall back the
    # same way baseline effectively does for an unrecognized struct type.
    return "string" if has_enum_values else "object"


def map_rp_util_property(name, meta, config_scope, defined_in, definitions):
    """Map one rp_util property entry (cluster_config_property_metadata)
    into property_extractor.py's property-dict shape."""
    default_value = _parse_embedded_json(meta.get("default_value"), name, "default_value")
    has_enum_values = bool(meta.get("enum_values"))

    # Baseline consistently unwraps a single-element list default to its
    # bare element when that element is a plain scalar (confirmed for
    # sasl_mechanisms) -- formatPropertyValue.js renders a bare scalar list
    # literally (e.g. "[SCRAM]"), so left as-is this is a real, if minor,
    # rendered-output regression relative to today's docs, not just a
    # JSON-shape difference. The property's own "type" still correctly says
    # "array" regardless, so no information is lost. Only the *displayed*
    # default is unwrapped -- _derive_enterprise_fields below still gets the
    # original shape, since its enterprise_sanctioned_value == default_value
    # comparison needs to match rp_util's own (unwrapped) val_container_t
    # serialization.
    #
    # This must NOT apply when the single element is an object (confirmed
    # for admin/kafka_api/pandaproxy_api/schema_registry_api): unwrapping
    # there strips the array away before formatPropertyValue.js ever sees
    # it, so its correct array-of-object branch never runs and its object
    # branch renders a bracket-less `{name: "", address: ..., port: ...}`
    # instead -- contradicting the property's own "array" type and not
    # something a reader could paste back into a real array-typed config.
    display_default = default_value
    if (
        isinstance(display_default, list)
        and len(display_default) == 1
        and not isinstance(display_default[0], dict)
    ):
        display_default = display_default[0]

    prop = {
        "name": name,
        "config_scope": config_scope,
        "defined_in": defined_in,
        "description": meta.get("description") or "",
        "type": _resolve_type(meta.get("type"), has_enum_values, definitions),
        "nullable": bool(meta.get("nullable", False)),
        "needs_restart": bool(meta.get("needs_restart", False)),
        "visibility": meta.get("visibility"),
        "is_secret": bool(meta.get("is_secret", False)),
        # rp_util's for_each() already excludes is_hidden() properties
        # (see config_schema_util.cc), so anything reaching here
        # is, by construction, not deprecated-and-hidden.
        "is_deprecated": False,
        "default": display_default,
    }

    # enterprise_restricted_values is never nested under items -- it
    # describes the whole property's license gating the same way
    # is_enterprise/enterprise_sanctioned_value do, whether the property is
    # a scalar or an array, so both the scalar and per-element branches
    # below read it from the top level of meta.
    enterprise_restricted_values = meta.get("enterprise_restricted_values")
    if has_enum_values:
        prop["enum"] = meta["enum_values"]
        metadata = _build_enum_metadata(meta["enum_values"], enterprise_restricted_values)
        if metadata:
            prop["x-enum-metadata"] = metadata
    if meta.get("items"):
        items = dict(meta["items"])
        item_enum_values = items.pop("enum_values", None)
        if items.get("type"):
            items["type"] = _resolve_type(items["type"], bool(item_enum_values), definitions)
        if item_enum_values:
            # rp_util reports an array property's per-element accepted
            # values under items.enum_values -- baseline (and property.hbs)
            # expect them nested the same way, but keyed "enum" (matching
            # the top-level convention: "enum_values" only because swagger
            # forbids the reserved word "enum" as a generated struct member).
            items["enum"] = item_enum_values
            metadata = _build_enum_metadata(item_enum_values, enterprise_restricted_values)
            if metadata:
                items["x-enum-metadata"] = metadata
        prop["items"] = items
    if meta.get("example") is not None:
        # Matches ExampleTransformer (transformers.py): wrap in backticks for
        # inline code formatting -- property.hbs renders {{{example}}} as
        # raw HTML, so the backticks are the only thing producing that
        # styling. Without this, a passed-through example loses its
        # code-block appearance relative to every other property's.
        prop["example"] = f"`{meta['example']}`"
    units = meta.get("units")
    if units is not None:
        # Expand rp_util's bare abbreviation to the full word
        # property.hbs's {{capitalize units}} expects -- see
        # UNIT_ABBREVIATION_TO_WORD.
        prop["units"] = UNIT_ABBREVIATION_TO_WORD.get(units, units)
    if meta.get("aliases"):
        prop["aliases"] = meta["aliases"]
    if "gets_restored" in meta:
        prop["gets_restored"] = bool(meta["gets_restored"])

    minimum = _parse_embedded_json(meta.get("minimum"), name, "minimum")
    if minimum is not None:
        prop["minimum"] = minimum
    maximum = _parse_embedded_json(meta.get("maximum"), name, "maximum")
    if maximum is not None:
        prop["maximum"] = maximum

    if units in UNIT_ABBREVIATION_TO_WORD and isinstance(display_default, (int, float)):
        # Mirrors property_extractor.py's evaluate_chrono_expressions, which
        # computes this from just (value, unit) -- verified to reproduce
        # baseline's value exactly for every ms/s property whose default
        # isn't itself wrong (see the two evaluator bugs this migration
        # already found and fixed independently of this field). bool is an
        # int subclass in Python -- isinstance(display_default, (int, float))
        # would wrongly accept a boolean default, but no ms/s-unit property
        # has a boolean default, so this is a non-issue in practice.
        from property_extractor import format_time_human_readable
        prop["default_human_readable"] = format_time_human_readable(display_default, units)

    prop.update(_derive_enterprise_fields(meta, default_value, name))
    return prop


def map_schema(schema_json, schema_key, definitions):
    """Map one rp_util schema blob into a {name: property_dict} dict.
    schema_key is one of DEFINED_IN_BY_SCHEMA_KEY's keys."""
    config_scope = CONFIG_SCOPE_BY_SCHEMA_KEY[schema_key]
    defined_in = DEFINED_IN_BY_SCHEMA_KEY[schema_key]
    properties = (schema_json or {}).get("properties", {})
    return {
        name: map_rp_util_property(name, meta, config_scope, defined_in, definitions)
        for name, meta in properties.items()
    }


def map_rp_util_schemas(schemas, definitions=None):
    """Map every schema in `schemas` (the dict rp-util-fetch.js's
    getRpUtilSchema() returns) into one combined {name: property_dict} dict
    covering all of cluster and broker scope.
    @param definitions: the existing --enhanced-output's "definitions" dict,
        used to resolve non-primitive C++ type names (see _resolve_type).
    """
    combined = {}
    for schema_key in DEFINED_IN_BY_SCHEMA_KEY:
        if schema_key in schemas:
            combined.update(map_schema(schemas[schema_key], schema_key, definitions or {}))
    return combined


def _preserve_validator_derived_enum_data(prop, existing_prop):
    """FALLBACK, not the primary path (mirrors _carry_forward_gets_restored):
    rp_util now exposes accepted-value/enterprise-tier data for properties
    like sasl_mechanisms directly (enum_set_property's enum_values(), plus
    enterprise<P>'s enterprise_restricted_values(), see streaming-enterprise's
    property.h) instead of it living only in a validator function's source, which
    ValidatorEnumExtractor (transformers.py) used to have to parse. This
    only fires against an rp_util build from before that existed, as a
    stopgap so a stale rp_util binary doesn't regress published docs by
    silently dropping real, verified, licensing-relevant content that
    baseline already has. Preserve baseline's value whenever rp_util's
    entry has none -- the same pass-through treatment topic properties
    already get. Should be removed once every consumer reliably runs an
    rp_util build new enough to report this itself.
    """
    if not existing_prop:
        return
    if not prop.get("enum") and existing_prop.get("enum"):
        prop["enum"] = existing_prop["enum"]
    if not prop.get("x-enum-metadata") and existing_prop.get("x-enum-metadata"):
        prop["x-enum-metadata"] = existing_prop["x-enum-metadata"]
    if isinstance(prop.get("items"), dict) and isinstance(existing_prop.get("items"), dict):
        # Array-typed properties (e.g. sasl_mechanisms) carry their enum --
        # and, critically, its enterprise-tier x-enum-metadata flags -- under
        # items, not at the top level.
        if not prop["items"].get("enum") and existing_prop["items"].get("enum"):
            prop["items"]["enum"] = existing_prop["items"]["enum"]
        if not prop["items"].get("x-enum-metadata") and existing_prop["items"].get("x-enum-metadata"):
            prop["items"]["x-enum-metadata"] = existing_prop["items"]["x-enum-metadata"]


def _carry_forward_gets_restored(prop, existing_prop):
    """FALLBACK, not the primary path: rp_util now exposes gets_restored
    directly (map_rp_util_property sets it from meta["gets_restored"] when
    present -- see streaming-enterprise's config_schema_util.cc).
    This only fires against an rp_util build from before that field existed
    (confirmed absent by enumerating every key across all five schemas as of
    PR #63's original state), as a stopgap so a stale rp_util binary doesn't
    actively regress published docs in the meantime: property.hbs/
    topic-property.hbs render a missing gets_restored as "Yes" via
    {{#if (ne gets_restored false)}}, silently inverting the correct "No"
    for properties like cloud_storage_access_key. This fallback is itself
    imperfect -- fragile for a newly-introduced property (never seen in a
    baseline run) and silently stale if a property's real flag value ever
    changes upstream -- so it should be removed once every consumer is
    reliably running an rp_util build that includes the field.
    """
    if "gets_restored" in prop:
        return
    if existing_prop and "gets_restored" in existing_prop:
        prop["gets_restored"] = existing_prop["gets_restored"]


def _carry_forward_example(prop, existing_prop):
    """rp_util's own `example` field (config::base_property::example(), a
    plain C++ string literal) only exists for a property whose author wrote
    one there -- unlike enum/gets_restored data, there is no equivalent
    override or dynamic source to fall back to, and no expectation that
    every property should have one. But a property that already had a
    correct, hand-written multi-line example in the existing output (e.g.
    ExampleOverrideTransformer-applied content, or one baseline's own
    parser found) must not silently lose it just because rp_util itself
    reports none for that property. Preserve baseline's value whenever
    rp_util's entry has none -- the same pass-through treatment topic
    properties already get. Unlike the other two fallbacks above, this is
    not a stopgap for a stale rp_util binary: rp_util is not expected to
    ever report every property's example, so this keeps applying
    indefinitely.
    """
    if "example" in prop:
        return
    if existing_prop and "example" in existing_prop:
        prop["example"] = existing_prop["example"]


CLOUD_METADATA_FIELDS = ("cloud_editable", "cloud_readonly", "cloud_supported", "cloud_byoc_only")


def _carry_forward_cloud_metadata(prop, existing_prop):
    """add_cloud_support_metadata (cloud_config.py) is the only source of
    cloud_editable/cloud_readonly/cloud_supported/cloud_byoc_only, and it
    only runs when merge_with_existing_output is given a CloudConfig (the
    --cloud-support flag). Without one, a rp_util-covered property's
    replaced entry has none of these four fields, silently erasing them for
    any property that had real cloud metadata from an earlier
    --cloud-support run -- until the next run happens to pass one again.
    Preserve the existing values whenever they're missing, the same
    fallback treatment gets_restored/example already get. A no-op whenever
    add_cloud_support_metadata did run, since it always sets all four.
    """
    if not existing_prop:
        return
    for field in CLOUD_METADATA_FIELDS:
        if field not in prop and field in existing_prop:
            prop[field] = existing_prop[field]


def _resync_topic_properties_inherited_from_cluster(merged_properties):
    """topic_property_extractor.py (property_extractor.py's Tree-sitter pass)
    copies `default`/`default_human_readable`/`type` from a topic property's
    corresponding_cluster_property onto the topic property itself, at
    extraction time -- before this module ever runs. Once rp_util has
    corrected that same cluster property's default/type here, the topic
    property's own copy of it is stale (confirmed real: log_segment_ms's
    default was the human string "2 weeks" in the old extraction and the
    correct raw integer via rp_util; a topic property that inherited the
    stale one would keep showing "2 weeks" as its own default forever,
    since nothing re-copies it after this point otherwise). Mirror that
    same copy here, now that the source it copies from is corrected.
    """
    for prop in merged_properties.values():
        cluster_prop_name = prop.get("corresponding_cluster_property")
        if not cluster_prop_name:
            continue
        cluster_prop = merged_properties.get(cluster_prop_name)
        if not cluster_prop:
            continue
        if "default" in cluster_prop:
            prop["default"] = cluster_prop["default"]
        if "default_human_readable" in cluster_prop:
            prop["default_human_readable"] = cluster_prop["default_human_readable"]
        elif "default_human_readable" in prop:
            del prop["default_human_readable"]
        if "type" in cluster_prop:
            prop["type"] = cluster_prop["type"]


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

    existing_properties = existing_properties_and_definitions.get("properties", {})
    raw = map_rp_util_schemas(rp_util_schemas, existing_properties_and_definitions.get("definitions"))

    # apply_property_overrides treats any override key with no matching
    # entry in `properties` as a removed/renamed property and fabricates a
    # phantom stub for it -- appropriate when `properties` is the full
    # extraction, but `raw` here is only cluster+broker scope. Left
    # unfiltered, every topic-only override key (the large majority of
    # docs-data/property-overrides.json) would fabricate a stub, which then
    # clobbers that topic property's real, correctly-extracted entry when
    # merged back into the existing output below.
    scoped_overrides = dict(overrides)
    scoped_overrides["properties"] = {
        name: override for name, override in overrides.get("properties", {}).items()
        if name in raw
    }

    enhanced = apply_property_overrides(raw, scoped_overrides, overrides_file_path)

    for name, prop in enhanced.items():
        _preserve_validator_derived_enum_data(prop, existing_properties.get(name))
        _carry_forward_gets_restored(prop, existing_properties.get(name))
        _carry_forward_example(prop, existing_properties.get(name))
        _carry_forward_cloud_metadata(prop, existing_properties.get(name))

    merged_properties = dict(existing_properties)
    replaced = sum(1 for name in enhanced if name in merged_properties)
    added = len(enhanced) - replaced
    merged_properties.update(enhanced)

    # Annotated after the merge, over the whole property map rather than over
    # the rp_util slice alone, so that every cluster property in the output
    # has been through the same CloudConfig no matter which pass produced it.
    # add_cloud_support_metadata touches cluster-scope entries only and
    # always sets all four fields, so re-running it over the properties
    # property_extractor.py already annotated is idempotent.
    #
    # What actually gets this metadata onto a property rp_util reports but
    # the Tree-sitter pass never saw (real case: post-#63 Tree-sitter drops
    # http_authentication and rp_util restores it) is main() building a
    # CloudConfig for --cloud-support/CLOUD_SUPPORT=1. Without one there is
    # nothing to annotate with, and such a property has no existing entry for
    # _carry_forward_cloud_metadata to copy from either, so it lands with no
    # cloud_supported at all -- which drops it from the Cloud reference's
    # redpanda-cloud tagged include.
    if cloud_config is not None:
        from cloud_config import add_cloud_support_metadata
        add_cloud_support_metadata(merged_properties, cloud_config)

    _resync_topic_properties_inherited_from_cluster(merged_properties)

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
    parser.add_argument("--cloud-support", action="store_true",
                         help="Fetch Cloud metadata from the cloudv2 install pack and annotate "
                              "cluster properties with it (requires GITHUB_TOKEN). Mirrors "
                              "property_extractor.py's flag of the same name; without it, a "
                              "property rp_util adds that the Tree-sitter pass missed gets no "
                              "cloud metadata at all.")
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

    # Flag or CLOUD_SUPPORT=1, the same pair property_extractor.py honors
    # (see its own --cloud-support handling), so a doc-tools run that asked
    # for cloud metadata still gets it here even when the flag itself isn't
    # threaded all the way through merge-rp-util.js.
    cloud_config = None
    if args.cloud_support or os.environ.get("CLOUD_SUPPORT") == "1":
        from cloud_config import fetch_cloud_config
        # Deliberately allowed to raise, exactly as property_extractor.py's
        # own --cloud-support path does: writing cluster properties with no
        # cloud metadata is the outcome this flag exists to prevent, so it
        # must not degrade quietly into a run that looks successful.
        cloud_config = fetch_cloud_config()
        logger.info(
            "Cloud support enabled; annotating with install-pack configuration version %s",
            cloud_config.version,
        )

    merged = merge_with_existing_output(
        existing, schemas, overrides, args.overrides, cloud_config
    )

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=4, sort_keys=True)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
