"""
Comprehensive integration tests with known values for property extraction.

These tests use complete, real-world property examples with known expected outputs
to ensure the entire transformation pipeline produces correct results. Each test
verifies the full property output rather than individual transformer behavior.

This helps catch regressions as the codebase scales and makes it harder to miss
mistakes in the complex transformation logic.
"""

import unittest
import sys
from pathlib import Path

# Add tools/property-extractor to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'tools' / 'property-extractor'))

from property_bag import PropertyBag
from file_pair import FilePair
from transformers import (
    BasicInfoTransformer,
    ParamNormalizerTransformer,
    IsNullableTransformer,
    IsArrayTransformer,
    NeedsRestartTransformer,
    GetsRestoredTransformer,
    IsSecretTransformer,
    VisibilityTransformer,
    TypeTransformer,
    DeprecatedTransformer,
    NumericBoundsTransformer,
    DurationBoundsTransformer,
    SimpleDefaultValuesTransformer,
    FriendlyDefaultTransformer,
    ExperimentalTransformer,
    AliasTransformer,
    EnterpriseTransformer,
    MetaParamTransformer,
    ExampleTransformer,
)


def create_complete_property_info(
    name,
    description,
    declaration=None,
    metadata=None,
    default_value="{}",
    property_type="property",
):
    """Helper to create a complete property info structure"""
    info = PropertyBag()
    info["name_in_file"] = name
    info["declaration"] = declaration
    info["type"] = property_type
    info["params"] = []

    # Add property name param
    info["params"].append(PropertyBag(value=name, type="string_literal"))

    # Add description param
    info["params"].append(PropertyBag(value=description, type="string_literal"))

    # Add metadata param if provided
    if metadata is not None:
        if isinstance(metadata, str):
            # String metadata (will be parsed by MetaParamTransformer)
            info["params"].append(PropertyBag(value=metadata, type="initializer_list"))
        else:
            # Already parsed metadata dict
            info["params"].append(PropertyBag(value=metadata, type="initializer_list"))

    # Add default value param
    info["params"].append(PropertyBag(value=default_value, type="number_literal" if isinstance(default_value, (int, float)) else "string_literal"))

    return info


def apply_transformer_pipeline(info, file_pair=None):
    """Apply the standard transformer pipeline to a property info"""
    if file_pair is None:
        file_pair = FilePair("test.h", "test.cc")

    property = PropertyBag()

    # Create type transformer instance (needed by several other transformers)
    type_transformer = TypeTransformer()

    # Apply transformers in standard order
    transformers = [
        ParamNormalizerTransformer(),
        BasicInfoTransformer(),
        MetaParamTransformer(),
        NeedsRestartTransformer(),
        GetsRestoredTransformer(),
        IsSecretTransformer(),
        VisibilityTransformer(),
        IsNullableTransformer(),
        IsArrayTransformer(type_transformer),
        type_transformer,
        DeprecatedTransformer(),
        NumericBoundsTransformer(type_transformer),
        DurationBoundsTransformer(type_transformer),
        SimpleDefaultValuesTransformer(),
        FriendlyDefaultTransformer(),
        ExperimentalTransformer(),
        AliasTransformer(),
        EnterpriseTransformer(),
        ExampleTransformer(),
    ]

    for transformer in transformers:
        if transformer.accepts(info, file_pair):
            transformer.parse(property, info, file_pair)

    return property


class SimpleIntegerPropertyTest(unittest.TestCase):
    """Test a simple integer property with known values"""

    def test_kafka_qdc_depth_alpha(self):
        """Test kafka_qdc_depth_alpha property extraction"""
        info = create_complete_property_info(
            name="kafka_qdc_depth_alpha",
            description="Smoothing parameter for Kafka queue depth control",
            declaration="property<double> kafka_qdc_depth_alpha;",
            metadata="meta{.needs_restart = needs_restart::no, .visibility = visibility::tunable}",
            default_value="0.8"
        )

        property = apply_transformer_pipeline(info)

        # Verify all expected fields
        self.assertEqual(property["name"], "kafka_qdc_depth_alpha")
        self.assertEqual(property["description"], "Smoothing parameter for Kafka queue depth control")
        self.assertEqual(property["type"], "number")
        self.assertEqual(property["default"], 0.8)
        self.assertFalse(property["needs_restart"])
        self.assertEqual(property["visibility"], "tunable")
        self.assertEqual(property["defined_in"], "test.cc")


class ChronoPropertyTest(unittest.TestCase):
    """Test chrono duration properties with known values"""

    def test_log_segment_ms_weeks(self):
        """Test log_segment_ms with std::chrono::weeks{2}"""
        info = create_complete_property_info(
            name="log_segment_ms",
            description="How long to keep a log segment before rolling",
            declaration="property<std::chrono::milliseconds> log_segment_ms;",
            metadata="meta{.needs_restart = needs_restart::no, .visibility = visibility::user}",
            default_value="std::chrono::weeks{2}"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "log_segment_ms")
        self.assertEqual(property["type"], "integer")
        self.assertEqual(property["default"], "2 weeks")
        self.assertFalse(property["needs_restart"])
        self.assertEqual(property["visibility"], "user")

    def test_raft_heartbeat_interval_with_literal(self):
        """Test chrono property with inner literal: chrono::milliseconds{150ms}"""
        info = create_complete_property_info(
            name="raft_heartbeat_interval_ms",
            description="Raft heartbeat interval",
            declaration="property<std::chrono::milliseconds> raft_heartbeat_interval_ms;",
            metadata="meta{.needs_restart = needs_restart::no}",
            default_value="std::chrono::milliseconds{150ms}"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "raft_heartbeat_interval_ms")
        self.assertEqual(property["type"], "integer")
        self.assertEqual(property["default"], "150 milliseconds")
        self.assertFalse(property["needs_restart"])


class ArrayPropertyTest(unittest.TestCase):
    """Test array/vector properties with known values"""

    def test_vector_string_property(self):
        """Test std::vector<ss::sstring> property"""
        info = create_complete_property_info(
            name="seed_servers",
            description="List of seed servers",
            declaration="property<std::vector<ss::sstring>> seed_servers;",
            metadata="meta{.needs_restart = needs_restart::yes}",
            default_value='std::vector<ss::sstring>{"localhost:9092"}'
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "seed_servers")
        self.assertEqual(property["type"], "array")
        self.assertEqual(property["items"]["type"], "string")
        self.assertEqual(property["default"], ["localhost:9092"])
        self.assertTrue(property["needs_restart"])

    def test_braced_list_default(self):
        """Test array property with braced list default"""
        info = create_complete_property_info(
            name="advertised_kafka_api",
            description="Advertised Kafka API addresses",
            declaration="property<std::vector<ss::sstring>> advertised_kafka_api;",
            metadata="meta{.needs_restart = needs_restart::yes}",
            default_value='{"127.0.0.1:9092", "localhost:9092"}'
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "advertised_kafka_api")
        self.assertEqual(property["type"], "array")
        self.assertEqual(property["default"], ["127.0.0.1:9092", "localhost:9092"])


class NullablePropertyTest(unittest.TestCase):
    """Test nullable/optional properties with known values"""

    def test_optional_int_with_nullopt(self):
        """Test std::optional<int> with std::nullopt default"""
        info = create_complete_property_info(
            name="target_quota_byte_rate",
            description="Target quota in bytes per second",
            declaration="property<std::optional<int64_t>> target_quota_byte_rate;",
            metadata="meta{.needs_restart = needs_restart::no}",
            default_value="std::nullopt"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "target_quota_byte_rate")
        self.assertEqual(property["type"], "integer")
        self.assertIsNone(property["default"])
        self.assertTrue(property.get("nullable", False))


class EnterprisePropertyTest(unittest.TestCase):
    """Test enterprise properties with known values"""

    def test_enterprise_property_with_restrictions(self):
        """Test enterprise property with restricted and sanctioned values"""
        # Simulate enterprise_property with both restricted and sanctioned values
        # Pattern: enterprise_property<string>(restricted_value, sanctioned_value, name, description, meta, default)
        # This matches core_balancing_continuous and partition_autobalancing_mode
        info = PropertyBag()
        info["name_in_file"] = "partition_autobalancing_mode"
        info["declaration"] = "enterprise_property<ss::sstring> partition_autobalancing_mode;"
        info["type"] = "enterprise_property"
        info["is_enterprise"] = True
        info["params"] = [
            PropertyBag(value="continuous", type="qualified_identifier"),  # Restricted enterprise value
            PropertyBag(value="node_add", type="qualified_identifier"),    # Sanctioned community value
            PropertyBag(value="partition_autobalancing_mode", type="string_literal"),  # Property name
            PropertyBag(value="Partition autobalancing mode", type="string_literal"),
            PropertyBag(value="meta{.needs_restart = needs_restart::no}", type="initializer_list"),
            PropertyBag(value="continuous", type="qualified_identifier"),  # Default value
        ]

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "partition_autobalancing_mode")
        self.assertEqual(property["type"], "string")
        self.assertTrue(property.get("is_enterprise", False))
        self.assertEqual(property.get("enterprise_constructor"), "restricted_with_sanctioned")
        self.assertIn("continuous", property.get("enterprise_restricted_value", []))
        self.assertIn("node_add", property.get("enterprise_sanctioned_value", []))

    def test_simple_enterprise_property_without_restrictions(self):
        """Test that simple enterprise properties without restrictions are not marked as enterprise

        This test documents current behavior: enterprise properties without explicit
        restriction/sanction patterns are not detected as enterprise by the transformer.
        This may be a limitation to address in future work.
        """
        info = create_complete_property_info(
            name="audit_enabled",
            description="Enable audit logging",
            declaration="enterprise_property<bool> audit_enabled;",
            metadata="meta{.needs_restart = needs_restart::no, .visibility = visibility::user}",
            default_value="false",
            property_type="enterprise_property"
        )
        # Mark as enterprise property (normally set by parser)
        info["is_enterprise"] = True

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "audit_enabled")
        self.assertEqual(property["type"], "boolean")
        self.assertFalse(property["default"])
        # Current behavior: simple enterprise properties without restrictions are not detected
        self.assertFalse(property.get("is_enterprise", False))
        self.assertEqual(property["visibility"], "user")


class NumericBoundsTest(unittest.TestCase):
    """Test numeric properties with bounds"""

    def test_int32_bounds(self):
        """Test int32_t property has correct bounds"""
        info = create_complete_property_info(
            name="kafka_connection_rate_limit",
            description="Connection rate limit per broker",
            declaration="property<int32_t> kafka_connection_rate_limit;",
            metadata="meta{.needs_restart = needs_restart::no}",
            default_value="1000"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "kafka_connection_rate_limit")
        self.assertEqual(property["type"], "integer")
        self.assertEqual(property["default"], 1000)
        self.assertEqual(property["minimum"], -(2**31))
        self.assertEqual(property["maximum"], 2**31 - 1)

    def test_int64_bounds(self):
        """Test int64_t property has correct bounds"""
        info = create_complete_property_info(
            name="log_segment_size",
            description="Log segment size in bytes",
            declaration="property<int64_t> log_segment_size;",
            metadata="meta{.needs_restart = needs_restart::no}",
            default_value="1073741824"  # 1 GiB
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "log_segment_size")
        self.assertEqual(property["type"], "integer")
        self.assertEqual(property["default"], 1073741824)
        self.assertEqual(property["minimum"], -(2**63))
        self.assertEqual(property["maximum"], 2**63 - 1)


class DeprecatedPropertyTest(unittest.TestCase):
    """Test deprecated properties"""

    def test_deprecated_visibility(self):
        """Test property with deprecated visibility and metadata"""
        info = create_complete_property_info(
            name="old_config_option",
            description="Deprecated configuration option",
            declaration="property<bool> old_config_option;",
            metadata="meta{.visibility = visibility::deprecated, .deprecated = yes}",
            default_value="false"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "old_config_option")
        self.assertTrue(property.get("is_deprecated", False))
        self.assertEqual(property["visibility"], "deprecated")


class SecretPropertyTest(unittest.TestCase):
    """Test secret/sensitive properties"""

    def test_secret_string_property(self):
        """Test property marked as secret"""
        info = create_complete_property_info(
            name="cloud_storage_secret_key",
            description="Secret key for cloud storage",
            declaration="property<ss::sstring> cloud_storage_secret_key;",
            metadata="meta{.needs_restart = needs_restart::no, .secret = is_secret::yes}",
            default_value='""'
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "cloud_storage_secret_key")
        self.assertEqual(property["type"], "string")
        self.assertTrue(property.get("is_secret", False))


class SizeLiteralTest(unittest.TestCase):
    """Test size literal conversion (for example, 20_GiB)"""

    def test_gib_size_literal(self):
        """Test conversion of _GiB size literal"""
        info = create_complete_property_info(
            name="compacted_log_segment_size",
            description="Compacted log segment size",
            declaration="property<int64_t> compacted_log_segment_size;",
            metadata="meta{.needs_restart = needs_restart::no}",
            default_value="256_MiB"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "compacted_log_segment_size")
        self.assertEqual(property["type"], "integer")
        # 256 * 1024^2 = 268435456
        self.assertEqual(property["default"], 268435456)


class UnresolvedAddressTest(unittest.TestCase):
    """Test net::unresolved_address defaults"""

    def test_unresolved_address_default(self):
        """Test net::unresolved_address parsing"""
        info = create_complete_property_info(
            name="kafka_api_bind_address",
            description="Kafka API bind address",
            declaration="property<net::unresolved_address> kafka_api_bind_address;",
            metadata="meta{.needs_restart = needs_restart::yes}",
            default_value='net::unresolved_address("0.0.0.0", 9092)'
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "kafka_api_bind_address")
        self.assertEqual(property["type"], "object")
        self.assertEqual(property["$ref"], "#/definitions/net::unresolved_address")
        self.assertIsInstance(property["default"], dict)
        self.assertEqual(property["default"]["address"], "0.0.0.0")
        self.assertEqual(property["default"]["port"], 9092)


class BooleanPropertyTest(unittest.TestCase):
    """Test boolean properties"""

    def test_true_default(self):
        """Test boolean property with true default"""
        info = create_complete_property_info(
            name="enable_idempotence",
            description="Enable idempotent producer",
            declaration="property<bool> enable_idempotence;",
            metadata="meta{.needs_restart = needs_restart::no}",
            default_value="true"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "enable_idempotence")
        self.assertEqual(property["type"], "boolean")
        self.assertTrue(property["default"])

    def test_false_default(self):
        """Test boolean property with false default"""
        info = create_complete_property_info(
            name="enable_legacy_mode",
            description="Enable legacy compatibility mode",
            declaration="property<bool> enable_legacy_mode;",
            metadata="meta{.needs_restart = needs_restart::yes}",
            default_value="false"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "enable_legacy_mode")
        self.assertEqual(property["type"], "boolean")
        self.assertFalse(property["default"])
        self.assertTrue(property["needs_restart"])


class ExampleMetadataTest(unittest.TestCase):
    """Test example metadata extraction"""

    def test_example_in_meta(self):
        """Test extraction of example value from meta"""
        info = create_complete_property_info(
            name="log_cleanup_policy",
            description="Log cleanup policy",
            declaration="property<ss::sstring> log_cleanup_policy;",
            metadata='meta{.needs_restart = needs_restart::no, .example = "delete", .visibility = visibility::user}',
            default_value='"compact"'
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "log_cleanup_policy")
        self.assertEqual(property.get("example"), "`delete`")
        self.assertEqual(property["default"], "compact")


class NumericSuffixStrippingTest(unittest.TestCase):
    """Test C++ numeric suffix stripping"""

    def test_unsigned_suffix(self):
        """Test stripping 'u' suffix from unsigned integers"""
        info = create_complete_property_info(
            name="buffer_size",
            description="Buffer size",
            declaration="property<uint32_t> buffer_size;",
            metadata="meta{.needs_restart = needs_restart::no}",
            default_value="1024u"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "buffer_size")
        self.assertEqual(property["default"], 1024)

    def test_long_suffix(self):
        """Test stripping 'L' suffix from long integers"""
        info = create_complete_property_info(
            name="max_value",
            description="Maximum value",
            declaration="property<int64_t> max_value;",
            metadata="meta{.needs_restart = needs_restart::no}",
            default_value="9999999L"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "max_value")
        self.assertEqual(property["default"], 9999999)

    def test_unsigned_long_long_suffix(self):
        """Test stripping 'ULL' suffix"""
        info = create_complete_property_info(
            name="max_offset",
            description="Maximum offset",
            declaration="property<uint64_t> max_offset;",
            metadata="meta{.needs_restart = needs_restart::no}",
            default_value="18446744073709551615ULL"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "max_offset")
        self.assertEqual(property["default"], 18446744073709551615)

    def test_float_suffix(self):
        """Test stripping 'f' suffix from floats"""
        info = create_complete_property_info(
            name="ratio",
            description="Compression ratio",
            declaration="property<float> ratio;",
            metadata="meta{.needs_restart = needs_restart::no}",
            default_value="0.75f"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "ratio")
        self.assertAlmostEqual(property["default"], 0.75, places=2)


class ComplexPropertyTest(unittest.TestCase):
    """Test complex real-world property examples"""

    def test_retention_bytes_with_nullopt(self):
        """Test retention.bytes with std::nullopt (unlimited)"""
        info = create_complete_property_info(
            name="retention_bytes",
            description="Max bytes per partition",
            declaration="property<std::optional<int64_t>> retention_bytes;",
            metadata="meta{.needs_restart = needs_restart::no, .visibility = visibility::user}",
            default_value="std::nullopt"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "retention_bytes")
        self.assertEqual(property["type"], "integer")
        self.assertIsNone(property["default"])
        self.assertTrue(property.get("nullable", False))
        self.assertFalse(property["needs_restart"])
        self.assertEqual(property["visibility"], "user")

    def test_log_segment_ms_evaluated_default(self):
        """Test that chrono defaults are human-readable (not raw milliseconds)"""
        info = create_complete_property_info(
            name="delete_retention_ms",
            description="Retention time for delete records",
            declaration="property<std::chrono::milliseconds> delete_retention_ms;",
            metadata="meta{.needs_restart = needs_restart::no}",
            default_value="std::chrono::hours{24}"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "delete_retention_ms")
        self.assertEqual(property["type"], "integer")
        # Should be "24 hours", not 86400000
        self.assertEqual(property["default"], "24 hours")

    def test_max_serializable_ms_constant_resolution(self):
        """Test that max_serializable_ms constant is resolved to actual numeric value"""
        info = create_complete_property_info(
            name="log_message_timestamp_before_max_ms",
            description="Maximum timestamp difference for record validation",
            declaration="property<std::chrono::milliseconds> log_message_timestamp_before_max_ms;",
            metadata="meta{.needs_restart = needs_restart::no, .visibility = visibility::user}",
            default_value="max_serializable_ms"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "log_message_timestamp_before_max_ms")
        self.assertEqual(property["type"], "integer")
        # max_serializable_ms = std::numeric_limits<int64_t>::max() / 1,000,000 = 9223372036854 ms
        self.assertEqual(property["default"], 9223372036854)
        self.assertFalse(property["needs_restart"])
        self.assertEqual(property["visibility"], "user")

    def test_max_serializable_ms_with_namespace(self):
        """Test that serde::max_serializable_ms (namespace-qualified) is resolved correctly"""
        info = create_complete_property_info(
            name="log_message_timestamp_before_max_ms",
            description="Maximum timestamp difference for record validation",
            declaration="property<std::chrono::milliseconds> log_message_timestamp_before_max_ms;",
            metadata="meta{.needs_restart = needs_restart::no, .visibility = visibility::user}",
            default_value="serde::max_serializable_ms"
        )

        property = apply_transformer_pipeline(info)

        self.assertEqual(property["name"], "log_message_timestamp_before_max_ms")
        self.assertEqual(property["type"], "integer")
        # serde::max_serializable_ms = 9223372036854 ms (same as max_serializable_ms)
        self.assertEqual(property["default"], 9223372036854)
        self.assertFalse(property["needs_restart"])
        self.assertEqual(property["visibility"], "user")


if __name__ == "__main__":
    unittest.main()
