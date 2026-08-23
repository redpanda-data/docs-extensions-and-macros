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
                                     "src/v/config/configuration.cc")
        self.assertEqual(prop["name"], "abort_index_segment_size")
        self.assertEqual(prop["config_scope"], "cluster")
        self.assertEqual(prop["defined_in"], "src/v/config/configuration.cc")
        self.assertEqual(prop["default"], 50000)
        self.assertEqual(prop["minimum"], 0)
        self.assertEqual(prop["maximum"], 4294967295)
        self.assertFalse(prop["is_enterprise"])
        self.assertFalse(prop["is_deprecated"])

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
        prop = map_rp_util_property("admin", meta, "broker", "src/v/config/node_config.cc")
        self.assertEqual(prop["default"], {"address": "127.0.0.1", "port": 9644})
        self.assertEqual(prop["config_scope"], "broker")

    def test_enum_values_maps_to_enum_key(self):
        meta = {
            "description": "d", "type": "string", "default_value": '"delete"',
            "enum_values": ["none", "delete", "compact"], "is_enterprise": False,
        }
        prop = map_rp_util_property("log_cleanup_policy", meta, "cluster",
                                     "src/v/config/configuration.cc")
        self.assertEqual(prop["enum"], ["none", "delete", "compact"])
        self.assertNotIn("enum_values", prop)

    def test_omits_optional_fields_when_absent(self):
        meta = {"description": "d", "type": "boolean", "default_value": "false", "is_enterprise": False}
        prop = map_rp_util_property("x", meta, "cluster", "src/v/config/configuration.cc")
        for key in ("enum", "items", "example", "units", "aliases", "minimum", "maximum"):
            self.assertNotIn(key, prop)


class TestMapSchema(unittest.TestCase):
    def test_tags_config_scope_and_defined_in_per_schema_key(self):
        schema = {"properties": {
            "foo": {"description": "d", "type": "boolean", "default_value": "true", "is_enterprise": False},
        }}
        mapped = map_schema(schema, "nodeSchema")
        self.assertEqual(mapped["foo"]["config_scope"], "broker")
        self.assertEqual(mapped["foo"]["defined_in"], "src/v/config/node_config.cc")

    def test_empty_schema_maps_to_empty_dict(self):
        self.assertEqual(map_schema({"properties": {}}, "clusterSchema"), {})
        self.assertEqual(map_schema(None, "clusterSchema"), {})


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
