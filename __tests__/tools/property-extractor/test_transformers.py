"""
Unit tests for property extractor transformers.

Tests cover:
- Enterprise property classification (restricted_only, restricted_with_sanctioned)
- Parameter normalization for enterprise properties
- Type extraction and resolution
- Enum pattern matching
- Default value processing
"""

import unittest
import sys
import os
from unittest.mock import MagicMock

# Add property-extractor directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../tools/property-extractor'))

from transformers import (
    EnterpriseTransformer,
    ParamNormalizerTransformer,
    TypeTransformer,
    BasicInfoTransformer
)
from property_bag import PropertyBag


class TestEnterpriseTransformer(unittest.TestCase):
    """Test enterprise property classification and value extraction."""

    def setUp(self):
        self.transformer = EnterpriseTransformer()
        self.file_pair = MagicMock()

    def test_restricted_only_with_enum_vector(self):
        """
        Test that properties with restricted values + enum definition are classified as restricted_only.

        Example: enable_schema_id_validation has:
        - First vector: ['compat', 'redpanda'] (restricted, enterprise-only)
        - Last vector: ['none', 'redpanda', 'compat'] (enum definition, superset of first)

        Expected: restricted_only (not restricted_with_sanctioned)
        """
        info = {
            "is_enterprise": True,
            "params": [
                {"value": "std::vector<...>{compat, redpanda}", "type": "initializer_list"},
                {"value": "enable_schema_id_validation", "type": "string_literal"},
                {"value": "Mode to enable...", "type": "string_literal"},
                {"value": "meta{...}", "type": "initializer_list"},
                {"value": "none", "type": "qualified_identifier"},
                {"value": "std::vector<...>{none, redpanda, compat}", "type": "initializer_list"}
            ]
        }

        property = PropertyBag()
        result = self.transformer.parse(property, info, self.file_pair)

        # Should be classified as restricted_only (enum is superset)
        self.assertEqual(result["enterprise_constructor"], "restricted_only")
        self.assertEqual(result["enterprise_restricted_value"], ["compat", "redpanda"])
        self.assertIsNone(result.get("enterprise_sanctioned_value"))
        self.assertTrue(result["is_enterprise"])

    def test_restricted_with_sanctioned_disjoint_values(self):
        """
        Test that properties with disjoint restricted and sanctioned values
        are classified as restricted_with_sanctioned.

        Example: partition_autobalancing_mode has:
        - Restricted: 'continuous' (enterprise-only)
        - Sanctioned: 'node_add' (community allowed)

        These are disjoint sets, so this is true restricted_with_sanctioned.
        """
        info = {
            "is_enterprise": True,
            "params": [
                {"value": "continuous", "type": "qualified_identifier"},
                {"value": "node_add", "type": "qualified_identifier"},
                {"value": "partition_autobalancing_mode", "type": "string_literal"},
                {"value": "Mode of partition balancing...", "type": "string_literal"},
                {"value": "meta{...}", "type": "initializer_list"},
                {"value": "node_add", "type": "qualified_identifier"}
            ]
        }

        property = PropertyBag()
        result = self.transformer.parse(property, info, self.file_pair)

        # Should be classified as restricted_with_sanctioned (disjoint sets)
        self.assertEqual(result["enterprise_constructor"], "restricted_with_sanctioned")
        self.assertEqual(result["enterprise_restricted_value"], ["continuous"])
        self.assertEqual(result["enterprise_sanctioned_value"], ["node_add"])
        self.assertTrue(result["is_enterprise"])

    def test_restricted_only_single_vector(self):
        """Test restricted_only pattern with single vector (no enum vector)."""
        info = {
            "is_enterprise": True,
            "params": [
                {"value": "std::vector<...>{true}", "type": "initializer_list"},
                {"value": "audit_enabled", "type": "string_literal"},
                {"value": "Enable auditing", "type": "string_literal"},
                {"value": "meta{...}", "type": "initializer_list"},
                {"value": "false", "type": "false"}
            ]
        }

        property = PropertyBag()
        result = self.transformer.parse(property, info, self.file_pair)

        self.assertEqual(result["enterprise_constructor"], "restricted_only")
        self.assertEqual(result["enterprise_restricted_value"], ["true"])
        self.assertIsNone(result.get("enterprise_sanctioned_value"))

    def test_non_enterprise_property(self):
        """Test that non-enterprise properties get is_enterprise=False."""
        info = {
            "is_enterprise": False,
            "params": [
                {"value": "kafka_api", "type": "string_literal"},
                {"value": "Kafka API endpoint", "type": "string_literal"},
                {"value": "meta{...}", "type": "initializer_list"},
                {"value": "localhost:9092", "type": "string_literal"}
            ]
        }

        property = PropertyBag()
        result = self.transformer.parse(property, info, self.file_pair)

        self.assertFalse(result["is_enterprise"])
        self.assertIsNone(result.get("enterprise_constructor"))
        self.assertIsNone(result.get("enterprise_restricted_value"))

    def test_simple_enterprise_property(self):
        """Test simple enterprise property with lambda validator."""
        info = {
            "is_enterprise": True,
            "params": [
                {"value": "[](const auto& v) { return true; }", "type": "lambda_expression"},
                {"value": "default_leaders_preference", "type": "string_literal"},
                {"value": "Default leaders preference", "type": "string_literal"},
                {"value": "meta{...}", "type": "initializer_list"},
                {"value": "none", "type": "qualified_identifier"}
            ]
        }

        property = PropertyBag()
        result = self.transformer.parse(property, info, self.file_pair)

        self.assertEqual(result["enterprise_constructor"], "simple")
        self.assertTrue(result["is_enterprise"])
        # Lambda should be removed from params
        self.assertEqual(len(info["params"]), 4)  # Lambda removed


class TestParamNormalizerTransformer(unittest.TestCase):
    """Test parameter normalization for consistent extraction."""

    def setUp(self):
        self.transformer = ParamNormalizerTransformer()
        self.file_pair = MagicMock()

    def test_normalize_restriction_at_position_0(self):
        """Test normalization when restriction vector is at position 0."""
        info = {
            "type": "enterprise_property",
            "params": [
                {"value": "std::vector<...>{...}", "type": "initializer_list"},
                {"value": "property_name", "type": "string_literal"},
                {"value": "Description", "type": "string_literal"},
                {"value": "meta{...}", "type": "initializer_list"},
                {"value": "default_value", "type": "string_literal"}
            ]
        }

        property = PropertyBag()
        self.transformer.parse(property, info, self.file_pair)

        # Should shift params by 1 (skip restriction vector)
        self.assertEqual(len(info["params"]), 4)
        self.assertEqual(info["params"][0]["value"], "property_name")

    def test_normalize_restriction_at_position_1(self):
        """Test normalization when restriction vector is at position 1."""
        info = {
            "type": "enterprise_property",
            "params": [
                {"value": "property_name", "type": "string_literal"},
                {"value": "std::vector<...>{...}", "type": "initializer_list"},
                {"value": "Description", "type": "string_literal"},
                {"value": "meta{...}", "type": "initializer_list"},
                {"value": "default_value", "type": "string_literal"}
            ]
        }

        property = PropertyBag()
        self.transformer.parse(property, info, self.file_pair)

        # Should shift params by 2 (skip name and restriction vector, then add name back)
        self.assertEqual(len(info["params"]), 3)
        self.assertEqual(info["params"][0]["value"], "Description")

    def test_skip_normalization_for_literals(self):
        """Test that properties starting with literals are not normalized."""
        info = {
            "type": "enterprise_property",
            "params": [
                {"value": "true", "type": "true"},
                {"value": "property_name", "type": "string_literal"},
                {"value": "Description", "type": "string_literal"}
            ]
        }

        property = PropertyBag()
        original_len = len(info["params"])
        self.transformer.parse(property, info, self.file_pair)

        # Should not normalize
        self.assertEqual(len(info["params"]), original_len)


class TestTypeTransformer(unittest.TestCase):
    """Test C++ type extraction and JSON Schema type mapping."""

    def setUp(self):
        self.transformer = TypeTransformer()
        self.file_pair = MagicMock()

    def test_extract_type_from_property_declaration(self):
        """Test extracting inner type from property<T> declaration."""
        info = {
            "declaration": "property<int>",
            "params": []
        }

        property = PropertyBag()
        result = self.transformer.parse(property, info, self.file_pair)

        self.assertEqual(result["type"], "integer")

    def test_extract_type_from_vector(self):
        """Test extracting type from std::vector<T>."""
        info = {
            "declaration": "property<std::vector<std::string>>",
            "params": []
        }

        property = PropertyBag()
        result = self.transformer.parse(property, info, self.file_pair)

        # TypeTransformer extracts inner type from template
        # IsArrayTransformer (runs later) converts vector types to array
        self.assertEqual(result["type"], "string")

    def test_extract_type_from_one_or_many(self):
        """Test extracting type from one_or_many_property<T>."""
        info = {
            "declaration": "one_or_many_property<broker_endpoint>",
            "params": []
        }

        property = PropertyBag()
        result = self.transformer.parse(property, info, self.file_pair)

        # TypeTransformer extracts inner type
        # IsArrayTransformer handles one_or_many conversion to array
        self.assertEqual(result["type"], "broker_endpoint")

    def test_map_cpp_type_to_json_schema(self):
        """Test mapping C++ types to JSON Schema types."""
        type_mappings = [
            ("int", "integer"),
            ("std::string", "string"),
            ("bool", "boolean"),
            ("double", "number"),
            ("uint32_t", "integer"),
            ("int64_t", "integer")
        ]

        for cpp_type, expected_json_type in type_mappings:
            info = {"declaration": f"property<{cpp_type}>", "params": []}
            property = PropertyBag()
            result = self.transformer.parse(property, info, self.file_pair)
            self.assertEqual(result["type"], expected_json_type,
                           f"Failed to map {cpp_type} to {expected_json_type}")


class TestBasicInfoTransformer(unittest.TestCase):
    """Test basic property information extraction."""

    def setUp(self):
        self.transformer = BasicInfoTransformer()
        self.file_pair = MagicMock()
        self.file_pair.implementation = "/some/path/src/v/config/configuration.cc"

    def test_extract_name_and_description(self):
        """Test extracting property name and description from params."""
        info = {
            "params": [
                {"value": "kafka_api", "type": "string_literal"},
                {"value": "IP address and port of the Kafka API endpoint", "type": "string_literal"}
            ]
        }

        property = PropertyBag()
        result = self.transformer.parse(property, info, self.file_pair)

        self.assertEqual(result["name"], "kafka_api")
        self.assertEqual(result["description"], "IP address and port of the Kafka API endpoint")

    def test_skip_lambda_validators(self):
        """Test that lambda validators are skipped when finding name."""
        info = {
            "params": [
                {"value": "[](const auto& v) { return v > 0; }", "type": "lambda_expression"},
                {"value": '"timeout_ms"', "type": "string_literal"},
                {"value": '"Timeout in milliseconds"', "type": "string_literal"}
            ]
        }

        property = PropertyBag()
        result = self.transformer.parse(property, info, self.file_pair)

        # BasicInfoTransformer should skip lambda and find first string literal
        self.assertEqual(result["name"], "timeout_ms")

    def test_normalize_file_path(self):
        """Test that file paths are normalized to start with src/."""
        info = {"params": [
            {"value": '"property_name"', "type": "string_literal"}
        ]}

        property = PropertyBag()
        result = self.transformer.parse(property, info, self.file_pair)

        # PropertyBag stores string directly, not wrapped
        defined_in = str(result["defined_in"])
        self.assertTrue(defined_in.startswith("src/"))
        self.assertIn("configuration.cc", defined_in)


class TestEnumPatternMatching(unittest.TestCase):
    """Test ENUM_PATTERN regex for extracting enum values."""

    def test_enum_pattern_matches_qualified_identifier(self):
        """Test that ENUM_PATTERN matches namespace::type::value patterns."""
        from property_extractor import ENUM_PATTERN

        test_cases = [
            ("model::compression::gzip", "gzip"),
            ("pandaproxy::schema_registry::schema_id_validation_mode::none", "none"),
            ("model::partition_autobalancing_mode::continuous", "continuous"),
        ]

        for input_str, expected_value in test_cases:
            match = ENUM_PATTERN.match(input_str)
            self.assertIsNotNone(match, f"Failed to match {input_str}")
            self.assertEqual(match.group(1), expected_value)

    def test_enum_pattern_does_not_match_constructors(self):
        """Test that ENUM_PATTERN does not match constructor syntax."""
        from property_extractor import ENUM_PATTERN

        # These should NOT match because they have constructor syntax
        non_matching_cases = [
            "config::leaders_preference{}",
            "std::chrono::seconds{30}",
            "net::unresolved_address(\"127.0.0.1\", 9092)",
        ]

        for input_str in non_matching_cases:
            match = ENUM_PATTERN.match(input_str)
            self.assertIsNone(match, f"Should not match constructor: {input_str}")


class TestIntegration(unittest.TestCase):
    """Integration tests for end-to-end property extraction."""

    def test_enterprise_property_full_pipeline(self):
        """Test complete processing of an enterprise property through transformers."""
        # This is an integration test that would need actual file parsing
        # For now, just test that the major components work together
        pass

    def test_standard_property_full_pipeline(self):
        """Test complete processing of a standard property through transformers."""
        # Integration test placeholder
        pass


if __name__ == '__main__':
    unittest.main()
