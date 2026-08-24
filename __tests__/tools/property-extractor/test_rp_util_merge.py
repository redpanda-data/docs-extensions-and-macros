"""
Unit tests for tools/property-extractor/rp_util_merge.py.

Covers mapping rp_util's JSON schema shape (cluster_config_property_metadata,
see api-doc/cluster_config.json in redpanda-data/streaming-enterprise) into
property_extractor.py's property-dict shape, and splicing the result into an
existing --enhanced-output file.
"""

import json
import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../tools/property-extractor'))

from rp_util_merge import (
    _parse_embedded_json,
    _derive_enterprise_fields,
    _resolve_type,
    _carry_forward_example,
    _carry_forward_cloud_metadata,
    _resync_topic_properties_inherited_from_cluster,
    map_rp_util_property,
    map_schema,
    map_rp_util_schemas,
    merge_with_existing_output,
)


class TestParseEmbeddedJson(unittest.TestCase):
    def test_parses_valid_json_string(self):
        self.assertEqual(_parse_embedded_json('50000', 'p', 'default_value'), 50000)
        self.assertEqual(_parse_embedded_json('"delete"', 'p', 'default_value'), "delete")
        self.assertEqual(
            _parse_embedded_json('{"address":"127.0.0.1","port":9644}', 'p', 'default_value'),
            {"address": "127.0.0.1", "port": 9644},
        )

    def test_none_input_returns_none(self):
        self.assertIsNone(_parse_embedded_json(None, 'p', 'minimum'))

    def test_invalid_json_returns_none_not_an_exception(self):
        self.assertIsNone(_parse_embedded_json('not json', 'p', 'default_value'))


class TestDeriveEnterpriseFields(unittest.TestCase):
    def test_non_enterprise_property(self):
        self.assertEqual(
            _derive_enterprise_fields({"is_enterprise": False}, None, 'p'),
            {"is_enterprise": False},
        )

    def test_dynamic_restriction_maps_to_simple(self):
        meta = {"is_enterprise": True, "enterprise_restriction_is_dynamic": True}
        self.assertEqual(
            _derive_enterprise_fields(meta, False, 'sasl_mechanisms_overrides'),
            {"is_enterprise": True, "enterprise_constructor": "simple"},
        )

    def test_restricted_only_when_sanctioned_equals_default(self):
        # audit_enabled: default false, restricted to true, no explicit
        # sanctioned value given -> sanctioned defaults to the property's own default.
        meta = {
            "is_enterprise": True,
            "enterprise_restriction_is_dynamic": False,
            "enterprise_restricted_value": "true",
            "enterprise_sanctioned_value": "false",
        }
        result = _derive_enterprise_fields(meta, False, 'audit_enabled')
        self.assertEqual(result["enterprise_constructor"], "restricted_only")
        self.assertEqual(result["enterprise_restricted_value"], [True])
        self.assertEqual(result["enterprise_value"], [True])
        self.assertNotIn("enterprise_sanctioned_value", result)

    def test_restricted_with_sanctioned_when_sanctioned_differs_from_default(self):
        meta = {
            "is_enterprise": True,
            "enterprise_restriction_is_dynamic": False,
            "enterprise_restricted_value": '"continuous"',
            "enterprise_sanctioned_value": '"node_wide"',
        }
        # The property's own default (unrelated to the sanctioned value here)
        # is what distinguishes this case from restricted_only.
        result = _derive_enterprise_fields(meta, "off", 'partition_autobalancing_mode')
        self.assertEqual(result["enterprise_constructor"], "restricted_with_sanctioned")
        self.assertEqual(result["enterprise_restricted_value"], ["continuous"])
        self.assertEqual(result["enterprise_sanctioned_value"], ["node_wide"])
        self.assertNotIn("enterprise_value", result)

    def test_restricted_value_already_a_list_is_not_double_wrapped(self):
        # val_container_t case: the restriction was constructed from a vector.
        meta = {
            "is_enterprise": True,
            "enterprise_restriction_is_dynamic": False,
            "enterprise_restricted_value": '["GSSAPI", "OAUTHBEARER"]',
            "enterprise_sanctioned_value": '[]',
        }
        result = _derive_enterprise_fields(meta, [], 'sasl_mechanisms')
        self.assertEqual(result["enterprise_restricted_value"], ["GSSAPI", "OAUTHBEARER"])


class TestMapRpUtilProperty(unittest.TestCase):
    def test_maps_a_plain_bounded_cluster_property(self):
        meta = {
            "description": "Capacity of an abort index segment.",
            "nullable": False,
            "needs_restart": True,
            "visibility": "tunable",
            "is_secret": False,
            "type": "integer",
            "default_value": "50000",
            "minimum": "0",
            "maximum": "4294967295",
            "is_enterprise": False,
        }
        prop = map_rp_util_property("abort_index_segment_size", meta, "cluster",
                                     "src/v/config/configuration.cc", {})
        self.assertEqual(prop["name"], "abort_index_segment_size")
        self.assertEqual(prop["config_scope"], "cluster")
        self.assertEqual(prop["defined_in"], "src/v/config/configuration.cc")
        self.assertEqual(prop["default"], 50000)
        self.assertEqual(prop["minimum"], 0)
        self.assertEqual(prop["maximum"], 4294967295)
        self.assertFalse(prop["is_enterprise"])
        self.assertFalse(prop["is_deprecated"])
        self.assertFalse(prop["is_secret"])

    def test_maps_a_broker_property_with_object_default(self):
        meta = {
            "description": "Network address for the Admin API server.",
            "nullable": False,
            "needs_restart": True,
            "visibility": "user",
            "type": "object",
            "default_value": '{"address":"127.0.0.1","port":9644}',
            "is_enterprise": False,
        }
        prop = map_rp_util_property("admin", meta, "broker", "src/v/config/node_config.cc", {})
        self.assertEqual(prop["default"], {"address": "127.0.0.1", "port": 9644})
        self.assertEqual(prop["config_scope"], "broker")

    def test_enum_values_maps_to_enum_key(self):
        meta = {
            "description": "d", "type": "string", "default_value": '"delete"',
            "enum_values": ["none", "delete", "compact"], "is_enterprise": False,
        }
        prop = map_rp_util_property("log_cleanup_policy", meta, "cluster",
                                     "src/v/config/configuration.cc", {})
        self.assertEqual(prop["enum"], ["none", "delete", "compact"])
        self.assertNotIn("enum_values", prop)

    def test_omits_optional_fields_when_absent(self):
        meta = {"description": "d", "type": "boolean", "default_value": "false", "is_enterprise": False}
        prop = map_rp_util_property("x", meta, "cluster", "src/v/config/configuration.cc", {})
        for key in ("enum", "items", "example", "units", "aliases", "minimum", "maximum",
                    "default_human_readable", "gets_restored"):
            self.assertNotIn(key, prop)

    def test_maps_gets_restored_when_rp_util_provides_it(self):
        meta = {
            "description": "d", "type": "string", "default_value": "null",
            "gets_restored": False, "is_enterprise": False,
        }
        prop = map_rp_util_property("cloud_storage_access_key", meta, "cluster",
                                     "src/v/config/configuration.cc", {})
        self.assertFalse(prop["gets_restored"])

    def test_is_secret_defaults_false_and_maps_true(self):
        meta = {"description": "d", "type": "string", "default_value": '""', "is_enterprise": False}
        prop = map_rp_util_property("x", meta, "cluster", "src/v/config/configuration.cc", {})
        self.assertFalse(prop["is_secret"])

        meta["is_secret"] = True
        prop = map_rp_util_property("cloud_storage_secret_key", meta, "cluster",
                                     "src/v/config/configuration.cc", {})
        self.assertTrue(prop["is_secret"])

    def test_example_gets_wrapped_in_backticks_like_ExampleTransformer(self):
        meta = {
            "description": "d", "type": "integer", "default_value": "1073741824",
            "example": "1073741824", "is_enterprise": False,
        }
        prop = map_rp_util_property("x", meta, "cluster", "src/v/config/configuration.cc", {})
        self.assertEqual(prop["example"], "`1073741824`")

    def test_units_abbreviation_expands_to_full_word(self):
        meta = {
            "description": "d", "type": "integer", "default_value": "5000",
            "units": "ms", "is_enterprise": False,
        }
        prop = map_rp_util_property("alive_timeout_ms", meta, "cluster",
                                     "src/v/config/configuration.cc", {})
        self.assertEqual(prop["units"], "milliseconds")

    def test_default_human_readable_computed_for_ms_and_s_properties(self):
        meta = {
            "description": "d", "type": "integer", "default_value": "5000",
            "units": "ms", "is_enterprise": False,
        }
        prop = map_rp_util_property("alive_timeout_ms", meta, "cluster",
                                     "src/v/config/configuration.cc", {})
        self.assertEqual(prop["default_human_readable"], "5 seconds")

    def test_default_human_readable_skipped_when_default_is_null(self):
        # nullable chrono properties (e.g. crash_loop_sleep_sec) have no
        # default to format -- must not raise or fabricate a value.
        meta = {
            "description": "d", "type": "integer", "default_value": "null",
            "units": "s", "nullable": True, "is_enterprise": False,
        }
        prop = map_rp_util_property("crash_loop_sleep_sec", meta, "cluster",
                                     "src/v/config/configuration.cc", {})
        self.assertNotIn("default_human_readable", prop)

    def test_non_primitive_type_resolved_against_definitions(self):
        definitions = {"model::rack_id": {"type": "string"}}
        meta = {"description": "d", "type": "rack_id", "default_value": '""', "is_enterprise": False}
        prop = map_rp_util_property("rack", meta, "broker", "src/v/config/node_config.cc", definitions)
        self.assertEqual(prop["type"], "string")

    def test_enum_backed_definition_type_renders_as_string_not_enum(self):
        definitions = {
            "model::partition_autobalancing_mode": {"type": "enum", "enum": ["off", "continuous"]},
        }
        meta = {
            "description": "d", "type": "partition_autobalancing_mode",
            "default_value": '"off"', "is_enterprise": False,
        }
        prop = map_rp_util_property("partition_autobalancing_mode", meta, "cluster",
                                     "src/v/config/configuration.cc", definitions)
        self.assertEqual(prop["type"], "string")

    def test_unresolvable_non_primitive_type_falls_back_to_object(self):
        # tls_config is a real, confirmed gap in baseline's definitions dict.
        meta = {"description": "d", "type": "tls_config", "default_value": "{}", "is_enterprise": False}
        prop = map_rp_util_property("broker_tls", meta, "broker",
                                     "src/v/kafka/client/configuration.cc", {})
        self.assertEqual(prop["type"], "object")

    def test_unresolvable_type_falls_back_to_string_when_enum_values_present(self):
        meta = {
            "description": "d", "type": "some_unmapped_enum_type", "default_value": '"a"',
            "enum_values": ["a", "b"], "is_enterprise": False,
        }
        prop = map_rp_util_property("x", meta, "cluster", "src/v/config/configuration.cc", {})
        self.assertEqual(prop["type"], "string")

    def test_single_element_scalar_list_default_unwraps_to_bare_scalar(self):
        # Matches baseline's own convention (confirmed for sasl_mechanisms)
        # -- otherwise formatPropertyValue.js renders a visible "[SCRAM]"
        # where today's docs show a bare "SCRAM".
        meta = {
            "description": "d", "type": "array", "default_value": '["SCRAM"]',
            "items": {"type": "string"}, "is_enterprise": False,
        }
        prop = map_rp_util_property("sasl_mechanisms", meta, "cluster",
                                     "src/v/config/configuration.cc", {})
        self.assertEqual(prop["default"], "SCRAM")

    def test_multi_element_list_default_is_not_unwrapped(self):
        meta = {
            "description": "d", "type": "array", "default_value": '["a", "b"]',
            "items": {"type": "string"}, "is_enterprise": False,
        }
        prop = map_rp_util_property("x", meta, "cluster", "src/v/config/configuration.cc", {})
        self.assertEqual(prop["default"], ["a", "b"])

    def test_single_element_object_list_default_is_not_unwrapped(self):
        # admin/kafka_api/pandaproxy_api/schema_registry_api are single-
        # element lists of *objects*, not scalars -- unwrapping one of these
        # strips the array away before formatPropertyValue.js's correct
        # array-of-object branch ever runs, producing a bracket-less
        # `{name: ..., address: ..., port: ...}` that contradicts the
        # property's own "array" type and isn't valid to paste back into a
        # real array-typed config.
        meta = {
            "description": "d", "type": "array",
            "default_value": '[{"name": "", "address": "127.0.0.1", "port": 9644}]',
            "items": {"type": "broker_endpoint"}, "is_enterprise": False,
        }
        prop = map_rp_util_property("admin", meta, "broker", "src/v/config/node_config.cc", {})
        self.assertEqual(prop["default"], [{"name": "", "address": "127.0.0.1", "port": 9644}])

    def test_items_type_is_also_resolved(self):
        definitions = {"model::broker_endpoint": {"type": "object"}}
        meta = {
            "description": "d", "type": "array", "default_value": "[]",
            "items": {"type": "broker_endpoint"}, "is_enterprise": False,
        }
        prop = map_rp_util_property("admin", meta, "broker", "src/v/config/node_config.cc", definitions)
        self.assertEqual(prop["items"]["type"], "object")

    def test_scalar_enum_with_enterprise_subset_builds_x_enum_metadata(self):
        meta = {
            "description": "d", "type": "string", "default_value": '"delete"',
            "enum_values": ["none", "delete", "compact"],
            "enterprise_enum_values": ["compact"], "is_enterprise": False,
        }
        prop = map_rp_util_property("x", meta, "cluster", "src/v/config/configuration.cc", {})
        self.assertEqual(prop["enum"], ["none", "delete", "compact"])
        self.assertEqual(prop["x-enum-metadata"], {
            "none": {"is_enterprise": False},
            "delete": {"is_enterprise": False},
            "compact": {"is_enterprise": True},
        })

    def test_scalar_enum_without_enterprise_subset_omits_x_enum_metadata(self):
        # A plain (non-licensing-gated) enum -- e.g. log_cleanup_policy --
        # must not get a vacuous all-false x-enum-metadata block baseline
        # never produced for it either.
        meta = {
            "description": "d", "type": "string", "default_value": '"delete"',
            "enum_values": ["none", "delete", "compact"], "is_enterprise": False,
        }
        prop = map_rp_util_property("log_cleanup_policy", meta, "cluster",
                                     "src/v/config/configuration.cc", {})
        self.assertNotIn("x-enum-metadata", prop)

    def test_items_enum_values_map_to_items_enum(self):
        # Array-element accepted values (e.g. sasl_mechanisms via
        # enum_set_property) belong under items, not the top-level "enum" --
        # they constrain each element, not the whole array value.
        meta = {
            "description": "d", "type": "array", "default_value": '["SCRAM"]',
            "items": {
                "type": "string",
                "enum_values": ["GSSAPI", "SCRAM", "OAUTHBEARER", "PLAIN"],
                "enterprise_enum_values": ["GSSAPI", "OAUTHBEARER"],
            },
            "is_enterprise": True,
        }
        prop = map_rp_util_property("sasl_mechanisms", meta, "cluster",
                                     "src/v/config/configuration.cc", {})
        self.assertNotIn("enum", prop)
        self.assertEqual(
            prop["items"]["enum"], ["GSSAPI", "SCRAM", "OAUTHBEARER", "PLAIN"])
        self.assertEqual(prop["items"]["x-enum-metadata"], {
            "GSSAPI": {"is_enterprise": True},
            "SCRAM": {"is_enterprise": False},
            "OAUTHBEARER": {"is_enterprise": True},
            "PLAIN": {"is_enterprise": False},
        })
        self.assertNotIn("enum_values", prop["items"])
        self.assertNotIn("enterprise_enum_values", prop["items"])

    def test_items_without_enum_values_omits_enum_key(self):
        # Regression guard: an ordinary array property with no accepted-
        # values list (e.g. admin's broker_endpoint items) must not gain a
        # spurious "enum" key just because items.pop() now runs.
        definitions = {"model::broker_endpoint": {"type": "object"}}
        meta = {
            "description": "d", "type": "array", "default_value": "[]",
            "items": {"type": "broker_endpoint"}, "is_enterprise": False,
        }
        prop = map_rp_util_property("admin", meta, "broker", "src/v/config/node_config.cc", definitions)
        self.assertNotIn("enum", prop["items"])
        self.assertNotIn("x-enum-metadata", prop["items"])


class TestResolveType(unittest.TestCase):
    def test_primitive_passes_through(self):
        self.assertEqual(_resolve_type("integer", False, {}), "integer")
        self.assertEqual(_resolve_type("object", False, {}), "object")

    def test_tries_bare_then_model_then_config_prefix(self):
        self.assertEqual(_resolve_type("rack_id", False, {"model::rack_id": {"type": "string"}}), "string")
        self.assertEqual(
            _resolve_type("leaders_preference", False, {"config::leaders_preference": {"type": "object"}}),
            "object",
        )
        self.assertEqual(
            _resolve_type("net::unresolved_address", False, {"net::unresolved_address": {"type": "object"}}),
            "object",
        )


class TestMapSchema(unittest.TestCase):
    def test_tags_config_scope_and_defined_in_per_schema_key(self):
        schema = {"properties": {
            "foo": {"description": "d", "type": "boolean", "default_value": "true", "is_enterprise": False},
        }}
        mapped = map_schema(schema, "nodeSchema", {})
        self.assertEqual(mapped["foo"]["config_scope"], "broker")
        self.assertEqual(mapped["foo"]["defined_in"], "src/v/config/node_config.cc")

    def test_empty_schema_maps_to_empty_dict(self):
        self.assertEqual(map_schema({"properties": {}}, "clusterSchema", {}), {})
        self.assertEqual(map_schema(None, "clusterSchema", {}), {})


class TestMapRpUtilSchemas(unittest.TestCase):
    def test_combines_all_schema_keys_without_clobbering(self):
        schemas = {
            "clusterSchema": {"properties": {
                "cluster_prop": {"description": "d", "type": "boolean", "default_value": "true", "is_enterprise": False},
            }},
            "kafkaClientSchema": {"properties": {
                "retries": {"description": "d", "type": "integer", "default_value": "5", "is_enterprise": False},
            }},
        }
        combined = map_rp_util_schemas(schemas)
        self.assertEqual(set(combined.keys()), {"cluster_prop", "retries"})
        self.assertEqual(combined["cluster_prop"]["config_scope"], "cluster")
        self.assertEqual(combined["retries"]["config_scope"], "broker")
        self.assertEqual(combined["retries"]["defined_in"], "src/v/kafka/client/configuration.cc")

    def test_missing_schema_keys_are_skipped_not_errors(self):
        self.assertEqual(map_rp_util_schemas({}), {})


class TestCarryForwardExample(unittest.TestCase):
    def test_preserves_existing_example_when_rp_util_has_none(self):
        prop = {"name": "x"}
        existing_prop = {"example": "`some hand-written example`"}
        _carry_forward_example(prop, existing_prop)
        self.assertEqual(prop["example"], "`some hand-written example`")

    def test_does_not_overwrite_rp_utils_own_example(self):
        prop = {"name": "x", "example": "`1073741824`"}
        existing_prop = {"example": "`some other example`"}
        _carry_forward_example(prop, existing_prop)
        self.assertEqual(prop["example"], "`1073741824`")

    def test_no_op_when_neither_side_has_an_example(self):
        prop = {"name": "x"}
        _carry_forward_example(prop, {"name": "x"})
        self.assertNotIn("example", prop)
        _carry_forward_example(prop, None)
        self.assertNotIn("example", prop)


class TestCarryForwardCloudMetadata(unittest.TestCase):
    def test_preserves_all_four_fields_when_rp_util_has_none(self):
        prop = {"name": "x"}
        existing_prop = {
            "cloud_editable": True, "cloud_readonly": False,
            "cloud_supported": True, "cloud_byoc_only": False,
        }
        _carry_forward_cloud_metadata(prop, existing_prop)
        self.assertEqual(prop["cloud_editable"], True)
        self.assertEqual(prop["cloud_readonly"], False)
        self.assertEqual(prop["cloud_supported"], True)
        self.assertEqual(prop["cloud_byoc_only"], False)

    def test_does_not_overwrite_freshly_computed_fields(self):
        prop = {"name": "x", "cloud_supported": False}
        existing_prop = {"cloud_supported": True}
        _carry_forward_cloud_metadata(prop, existing_prop)
        self.assertFalse(prop["cloud_supported"])

    def test_no_op_when_neither_side_has_cloud_metadata(self):
        prop = {"name": "x"}
        _carry_forward_cloud_metadata(prop, {"name": "x"})
        for field in ("cloud_editable", "cloud_readonly", "cloud_supported", "cloud_byoc_only"):
            self.assertNotIn(field, prop)
        _carry_forward_cloud_metadata(prop, None)
        for field in ("cloud_editable", "cloud_readonly", "cloud_supported", "cloud_byoc_only"):
            self.assertNotIn(field, prop)


class TestResyncTopicPropertiesInheritedFromCluster(unittest.TestCase):
    """topic_property_extractor.py copies default/type from a topic
    property's corresponding_cluster_property at Tree-sitter extraction
    time, before rp_util corrects that same cluster property here. Without
    re-syncing, a topic property keeps showing the pre-correction value
    forever (confirmed real for log_segment_ms/segment.ms: "2 weeks" vs the
    correct raw integer 1209600000)."""

    def test_resyncs_default_and_type_from_the_now_corrected_cluster_property(self):
        merged = {
            "log_segment_ms": {"name": "log_segment_ms", "default": 1209600000, "type": "integer"},
            "segment.ms": {
                "name": "segment.ms", "config_scope": "topic",
                "corresponding_cluster_property": "log_segment_ms",
                "default": "2 weeks", "type": "integer",
            },
        }
        _resync_topic_properties_inherited_from_cluster(merged)
        self.assertEqual(merged["segment.ms"]["default"], 1209600000)

    def test_resyncs_type_even_when_only_type_is_stale(self):
        merged = {
            "log_retention_ms": {"name": "log_retention_ms", "default": 604800000, "type": "integer"},
            "retention.ms": {
                "name": "retention.ms", "config_scope": "topic",
                "corresponding_cluster_property": "log_retention_ms",
                "default": 604800000, "type": "object",
            },
        }
        _resync_topic_properties_inherited_from_cluster(merged)
        self.assertEqual(merged["retention.ms"]["type"], "integer")

    def test_resyncs_default_human_readable_including_removing_a_stale_one(self):
        merged = {
            "cluster_prop": {"name": "cluster_prop", "default": 5000, "default_human_readable": "5 seconds"},
            "topic_prop": {
                "name": "topic_prop", "config_scope": "topic",
                "corresponding_cluster_property": "cluster_prop",
                "default": 5000, "default_human_readable": "5000 milliseconds",
            },
        }
        _resync_topic_properties_inherited_from_cluster(merged)
        self.assertEqual(merged["topic_prop"]["default_human_readable"], "5 seconds")

        merged["cluster_prop"].pop("default_human_readable")
        _resync_topic_properties_inherited_from_cluster(merged)
        self.assertNotIn("default_human_readable", merged["topic_prop"])

    def test_no_op_for_a_topic_property_with_no_cluster_mapping(self):
        merged = {"standalone_topic_prop": {"name": "standalone_topic_prop", "default": "x"}}
        _resync_topic_properties_inherited_from_cluster(merged)
        self.assertEqual(merged["standalone_topic_prop"]["default"], "x")

    def test_no_op_when_the_mapped_cluster_property_does_not_exist(self):
        merged = {
            "topic_prop": {
                "name": "topic_prop", "corresponding_cluster_property": "nonexistent_cluster_prop",
                "default": "unchanged",
            },
        }
        _resync_topic_properties_inherited_from_cluster(merged)
        self.assertEqual(merged["topic_prop"]["default"], "unchanged")


class TestMergeWithExistingOutput(unittest.TestCase):
    def test_replaces_cluster_and_broker_properties_keeps_topic_untouched(self):
        existing = {
            "properties": {
                "abort_index_segment_size": {
                    "name": "abort_index_segment_size", "config_scope": "cluster", "default": 999,
                },
                "cleanup.policy": {
                    "name": "cleanup.policy", "config_scope": "topic", "is_topic_property": True,
                    "default": "delete",
                },
            },
            "definitions": {"some_def": {"type": "object"}},
        }
        rp_util_schemas = {
            "clusterSchema": {"properties": {
                "abort_index_segment_size": {
                    "description": "d", "type": "integer", "default_value": "50000",
                    "minimum": "0", "maximum": "4294967295", "is_enterprise": False,
                },
            }},
        }

        merged = merge_with_existing_output(existing, rp_util_schemas, overrides={})

        self.assertEqual(merged["properties"]["abort_index_segment_size"]["default"], 50000)
        self.assertEqual(merged["properties"]["abort_index_segment_size"]["config_scope"], "cluster")
        # Topic property, untouched by rp_util, passes through as-is.
        self.assertEqual(merged["properties"]["cleanup.policy"], existing["properties"]["cleanup.policy"])
        # definitions pass through untouched.
        self.assertEqual(merged["definitions"], {"some_def": {"type": "object"}})

    def test_adds_new_rp_util_properties_not_previously_present(self):
        existing = {"properties": {}, "definitions": {}}
        rp_util_schemas = {
            "nodeSchema": {"properties": {
                "developer_mode": {
                    "description": "d", "type": "boolean", "default_value": "false", "is_enterprise": False,
                },
            }},
        }
        merged = merge_with_existing_output(existing, rp_util_schemas, overrides={})
        self.assertIn("developer_mode", merged["properties"])
        self.assertEqual(merged["properties"]["developer_mode"]["config_scope"], "broker")

    def test_applies_overrides_to_rp_util_derived_properties(self):
        existing = {"properties": {}, "definitions": {}}
        rp_util_schemas = {
            "clusterSchema": {"properties": {
                "abort_index_segment_size": {
                    "description": "original description", "type": "integer",
                    "default_value": "50000", "is_enterprise": False,
                },
            }},
        }
        overrides = {"properties": {
            "abort_index_segment_size": {"description": "overridden description"},
        }}

        merged = merge_with_existing_output(existing, rp_util_schemas, overrides)

        self.assertEqual(
            merged["properties"]["abort_index_segment_size"]["description"],
            "overridden description",
        )

    def test_keeps_existing_example_when_rp_util_reports_none(self):
        # Regression guard: pandaproxy_api_tls/scram_username/schema_registry_
        # replication_factor/verbose_logging_timeout_sec_max all have a
        # correct, hand-written example in today's published docs, but no
        # example field in rp_util's own schema -- merging must not silently
        # drop it just because rp_util now covers the property.
        existing = {
            "properties": {
                "scram_username": {
                    "name": "scram_username", "config_scope": "cluster",
                    "example": "`myuser`",
                },
            },
            "definitions": {},
        }
        rp_util_schemas = {
            "clusterSchema": {"properties": {
                "scram_username": {
                    "description": "d", "type": "string",
                    "default_value": "null", "is_enterprise": False,
                },
            }},
        }

        merged = merge_with_existing_output(existing, rp_util_schemas, overrides={})

        self.assertEqual(merged["properties"]["scram_username"]["example"], "`myuser`")

    def test_keeps_existing_cloud_metadata_when_cloud_config_not_given(self):
        # Regression guard: without --cloud-support, add_cloud_support_metadata
        # never runs, so a rp_util-covered property must not lose cloud
        # metadata an earlier --cloud-support run had already recorded for it.
        existing = {
            "properties": {
                "audit_enabled": {
                    "name": "audit_enabled", "config_scope": "cluster",
                    "cloud_editable": True, "cloud_readonly": False,
                    "cloud_supported": True, "cloud_byoc_only": False,
                },
            },
            "definitions": {},
        }
        rp_util_schemas = {
            "clusterSchema": {"properties": {
                "audit_enabled": {
                    "description": "d", "type": "boolean",
                    "default_value": "false", "is_enterprise": False,
                },
            }},
        }

        merged = merge_with_existing_output(existing, rp_util_schemas, overrides={})

        prop = merged["properties"]["audit_enabled"]
        self.assertTrue(prop["cloud_editable"])
        self.assertFalse(prop["cloud_readonly"])
        self.assertTrue(prop["cloud_supported"])
        self.assertFalse(prop["cloud_byoc_only"])

    def test_topic_property_inherits_the_rp_util_corrected_cluster_default(self):
        # Regression guard for a real bug: log_segment_ms's default used to
        # be the human string "2 weeks" from the old Tree-sitter extractor;
        # rp_util reports the correct raw integer. segment.ms (the topic
        # property) had already baked in "2 weeks" at Tree-sitter extraction
        # time, before this merge runs -- it must pick up the corrected
        # value, not keep showing the stale one forever.
        existing = {
            "properties": {
                "log_segment_ms": {
                    "name": "log_segment_ms", "config_scope": "cluster", "default": "2 weeks", "type": "integer",
                },
                "segment.ms": {
                    "name": "segment.ms", "config_scope": "topic",
                    "corresponding_cluster_property": "log_segment_ms",
                    "default": "2 weeks", "type": "integer",
                },
            },
            "definitions": {},
        }
        rp_util_schemas = {
            "clusterSchema": {"properties": {
                "log_segment_ms": {
                    "description": "d", "type": "integer",
                    "default_value": "1209600000", "is_enterprise": False,
                },
            }},
        }

        merged = merge_with_existing_output(existing, rp_util_schemas, overrides={})

        self.assertEqual(merged["properties"]["log_segment_ms"]["default"], 1209600000)
        self.assertEqual(merged["properties"]["segment.ms"]["default"], 1209600000)

    def test_topic_only_overrides_do_not_clobber_the_topic_property(self):
        # Regression: docs-data/property-overrides.json's overrides are
        # mostly topic-scoped, but `raw` here only ever has cluster+broker
        # keys. An unfiltered apply_property_overrides call treats every
        # topic-only key as unmatched and fabricates a phantom stub for it
        # -- which then overwrites the topic property's real entry below.
        existing = {
            "properties": {
                "abort_index_segment_size": {
                    "name": "abort_index_segment_size", "config_scope": "cluster", "default": 999,
                },
                "retention.ms": {
                    "name": "retention.ms", "config_scope": "topic", "is_topic_property": True,
                    "default": 604800000, "description": "real topic description",
                },
            },
            "definitions": {},
        }
        rp_util_schemas = {"clusterSchema": {"properties": {
            "abort_index_segment_size": {
                "description": "d", "type": "integer", "default_value": "50000", "is_enterprise": False,
            },
        }}}
        overrides = {"properties": {
            # A real override key from docs-data/property-overrides.json,
            # topic-scoped, with no corresponding cluster/broker entry.
            "retention.ms": {"description": "overridden topic description"},
        }}

        merged = merge_with_existing_output(existing, rp_util_schemas, overrides)

        self.assertEqual(merged["properties"]["retention.ms"], existing["properties"]["retention.ms"])
        self.assertNotIn("retention.ms", map_rp_util_schemas(rp_util_schemas))

    def test_preserves_baseline_validator_derived_enum_when_rp_util_has_none(self):
        # sasl_mechanisms: a plain property<vector<sstring>> with a runtime
        # validator, not an enum_property<T> -- rp_util structurally cannot
        # produce this enum/x-enum-metadata; it must not be clobbered.
        # Real shape (confirmed against actual baseline output): for an
        # array-typed property this lives under "items", not top-level.
        existing = {
            "properties": {
                "sasl_mechanisms": {
                    "name": "sasl_mechanisms", "config_scope": "cluster",
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": ["GSSAPI", "SCRAM", "OAUTHBEARER", "PLAIN"],
                        "x-enum-metadata": {
                            "GSSAPI": {"is_enterprise": True},
                            "OAUTHBEARER": {"is_enterprise": True},
                        },
                    },
                },
            },
            "definitions": {},
        }
        rp_util_schemas = {"clusterSchema": {"properties": {
            "sasl_mechanisms": {
                "description": "d", "type": "array", "default_value": '["SCRAM"]',
                "items": {"type": "string"}, "is_enterprise": False,
            },
        }}}

        merged = merge_with_existing_output(existing, rp_util_schemas, overrides={})

        self.assertEqual(merged["properties"]["sasl_mechanisms"]["items"]["enum"],
                          ["GSSAPI", "SCRAM", "OAUTHBEARER", "PLAIN"])
        self.assertEqual(merged["properties"]["sasl_mechanisms"]["items"]["x-enum-metadata"],
                          {"GSSAPI": {"is_enterprise": True}, "OAUTHBEARER": {"is_enterprise": True}})

    def test_does_not_override_enum_rp_util_actually_provides(self):
        existing = {
            "properties": {
                "log_cleanup_policy": {
                    "name": "log_cleanup_policy", "config_scope": "cluster",
                    "enum": ["delete", "compact", "compact,delete", "count"],
                },
            },
            "definitions": {},
        }
        rp_util_schemas = {"clusterSchema": {"properties": {
            "log_cleanup_policy": {
                "description": "d", "type": "string", "default_value": '"delete"',
                "enum_values": ["delete", "compact", "compact,delete"], "is_enterprise": False,
            },
        }}}

        merged = merge_with_existing_output(existing, rp_util_schemas, overrides={})

        # rp_util's own (correct) enum wins -- not baseline's fabricated "count".
        self.assertEqual(merged["properties"]["log_cleanup_policy"]["enum"],
                          ["delete", "compact", "compact,delete"])

    def test_carries_forward_gets_restored_from_baseline_when_rp_util_lacks_it(self):
        existing = {
            "properties": {
                "cloud_storage_access_key": {
                    "name": "cloud_storage_access_key", "config_scope": "cluster",
                    "gets_restored": False,
                },
            },
            "definitions": {},
        }
        rp_util_schemas = {"clusterSchema": {"properties": {
            "cloud_storage_access_key": {
                "description": "d", "type": "string", "default_value": "null",
                "is_secret": True, "is_enterprise": False,
                # no "gets_restored" key -- an rp_util build from before it existed.
            },
        }}}

        merged = merge_with_existing_output(existing, rp_util_schemas, overrides={})

        self.assertFalse(merged["properties"]["cloud_storage_access_key"]["gets_restored"])

    def test_uses_rp_utils_own_gets_restored_when_present_not_baselines(self):
        existing = {
            "properties": {
                "cloud_storage_access_key": {
                    "name": "cloud_storage_access_key", "config_scope": "cluster",
                    "gets_restored": True,  # stale/wrong on the baseline side
                },
            },
            "definitions": {},
        }
        rp_util_schemas = {"clusterSchema": {"properties": {
            "cloud_storage_access_key": {
                "description": "d", "type": "string", "default_value": "null",
                "is_secret": True, "gets_restored": False, "is_enterprise": False,
            },
        }}}

        merged = merge_with_existing_output(existing, rp_util_schemas, overrides={})

        self.assertFalse(merged["properties"]["cloud_storage_access_key"]["gets_restored"])

    def test_no_cloud_config_does_not_raise(self):
        existing = {"properties": {}, "definitions": {}}
        rp_util_schemas = {"clusterSchema": {"properties": {
            "x": {"description": "d", "type": "boolean", "default_value": "true", "is_enterprise": False},
        }}}
        # Should not raise even though cloud_config is None (the default).
        merged = merge_with_existing_output(existing, rp_util_schemas, overrides={})
        self.assertIn("x", merged["properties"])


if __name__ == "__main__":
    unittest.main()
