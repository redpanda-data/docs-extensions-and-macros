"""
Unit tests for the category fallback added to apply_property_overrides.

Both property.hbs and topic-property.hbs wrap a property's generated content
in `tag::category-{{category}}[]` / `end::category-{{category}}[]` only when
`category` is truthy. A property with no category at all gets no tag region,
so any page that assembles its content from specific category-tag includes
(topic-property-mappings.adoc, broker-properties.adoc) silently excludes it --
present in the raw generated partial, invisible everywhere it's actually read
from. This covers two real, independently-discovered instances of that gap:
an override-created topic property stub with no category override (the
cloud_topics_* family), and a normally-extracted broker property with no
category at all (cloud_storage_inventory_hash_path_directory, which has no
per-name categorization fallback for its scope in the first place).
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../tools/property-extractor'))

from property_extractor import (
    apply_property_overrides,
    infer_topic_property_category,
    _ensure_category_fallback,
)


class TestInferTopicPropertyCategory(unittest.TestCase):
    def test_known_name_maps_to_its_real_category(self):
        self.assertEqual(infer_topic_property_category("cleanup.policy"), "retention-compaction")
        self.assertEqual(infer_topic_property_category("redpanda.iceberg.mode"), "iceberg-integration")

    def test_unknown_name_falls_back_to_other(self):
        self.assertEqual(infer_topic_property_category("cloud_topics_l1_indexing_interval"), "other")


class TestEnsureCategoryFallback(unittest.TestCase):
    def test_override_created_topic_stub_gets_a_category(self):
        """The exact cloud_topics_* shape: an override-only stub, config_scope
        defaulted to topic, whose underscore-separated name matches nothing
        in the dotted-name category lists."""
        properties = {}
        overrides = {"properties": {"cloud_topics_l1_indexing_interval": {"version": "v26.1.1"}}}

        result = apply_property_overrides(properties, overrides)

        self.assertEqual(result["cloud_topics_l1_indexing_interval"].get("category"), "other")

    def test_extracted_broker_property_with_no_category_gets_other(self):
        """The exact cloud_storage_inventory_hash_path_directory shape: a real
        extracted property already in `properties` before overrides run, with
        no category and no override touching it at all."""
        properties = {
            "cloud_storage_inventory_hash_path_directory": {
                "name": "cloud_storage_inventory_hash_path_directory",
                "config_scope": "broker",
                "defined_in": "src/v/config/node_config.cc",
            }
        }

        result = apply_property_overrides(properties, {"properties": {}})

        self.assertEqual(
            result["cloud_storage_inventory_hash_path_directory"].get("category"), "other"
        )

    def test_existing_category_is_not_overwritten(self):
        properties = {
            "some_property": {"name": "some_property", "config_scope": "cluster", "category": "redpanda"}
        }

        _ensure_category_fallback(properties)

        self.assertEqual(properties["some_property"]["category"], "redpanda")

    def test_override_created_topic_stub_with_a_known_name_gets_its_real_category(self):
        properties = {}
        overrides = {"properties": {"cleanup.policy": {"version": "v26.0.0"}}}

        result = apply_property_overrides(properties, overrides)

        self.assertEqual(result["cleanup.policy"].get("category"), "retention-compaction")

    def test_override_created_cluster_stub_gets_other(self):
        properties = {}
        overrides = {"properties": {"some_new_cluster_flag": {"config_scope": "cluster"}}}

        result = apply_property_overrides(properties, overrides)

        self.assertEqual(result["some_new_cluster_flag"].get("category"), "other")


if __name__ == "__main__":
    unittest.main()
