"""
Comprehensive tests for enterprise property detection.

These tests validate that the EnterpriseTransformer correctly identifies and handles
all three types of enterprise properties:
- restricted_with_sanctioned: Properties with both Enterprise (restricted) and Community (sanctioned) values
- restricted_only: Properties with only Enterprise (restricted) values
- simple: Simple enterprise validation without specific value restrictions

The tests also ensure that defaults are correctly extracted:
- For restricted_with_sanctioned: Default is the Enterprise (restricted) value
- For restricted_only: Default is the Community value
- No enterprise_default_description fields should be generated

These tests help prevent regressions in enterprise property detection logic.
"""

import unittest
import json
from pathlib import Path


class EnterprisePropertyDetectionTest(unittest.TestCase):
    """Test enterprise property detection against actual generated output"""

    @classmethod
    def setUpClass(cls):
        """Load the generated properties JSON once for all tests"""
        json_path = Path(__file__).parent.parent.parent.parent / "tools" / "property-extractor" / "gen" / "dev-properties.json"
        with open(json_path, "r") as f:
            data = json.load(f)
            cls.properties = data.get("properties", {})

    def get_enterprise_properties_by_type(self, constructor_type):
        """Helper to get all enterprise properties of a specific type"""
        return {
            name: prop
            for name, prop in self.properties.items()
            if prop.get("enterprise_constructor") == constructor_type
        }


class RestrictedOnlyTest(EnterprisePropertyDetectionTest):
    """Test restricted_only properties (Enterprise-only values, Community default)"""

    def test_restricted_only_properties_exist(self):
        """Test that restricted_only properties are detected"""
        restricted_only = self.get_enterprise_properties_by_type("restricted_only")
        self.assertGreaterEqual(
            len(restricted_only),
            3,
            f"Expected at least 3 restricted_only properties, found {len(restricted_only)}",
        )

    def test_enable_schema_id_validation_classification(self):
        """Test enable_schema_id_validation is correctly classified as restricted_only"""
        prop = self.properties.get("enable_schema_id_validation")
        self.assertIsNotNone(prop, "enable_schema_id_validation property not found")
        self.assertEqual(
            prop.get("enterprise_constructor"),
            "restricted_only",
            "enable_schema_id_validation should be restricted_only",
        )

    def test_enable_schema_id_validation_restricted_values(self):
        """Test enable_schema_id_validation has correct restricted (Enterprise) values"""
        prop = self.properties.get("enable_schema_id_validation")
        self.assertIsNotNone(prop)
        restricted = prop.get("enterprise_restricted_value", [])
        self.assertIn("compat", restricted)
        self.assertIn("redpanda", restricted)

    def test_enable_schema_id_validation_community_default(self):
        """Test enable_schema_id_validation default is the Community value (none)"""
        prop = self.properties.get("enable_schema_id_validation")
        self.assertIsNotNone(prop)
        self.assertEqual(
            prop.get("default"),
            "none",
            "enable_schema_id_validation default should be 'none' (Community value), not 'compat' or 'redpanda'",
        )

    def test_enable_schema_id_validation_no_sanctioned_value(self):
        """Test enable_schema_id_validation has no sanctioned value (restricted_only pattern)"""
        prop = self.properties.get("enable_schema_id_validation")
        self.assertIsNotNone(prop)
        self.assertIsNone(
            prop.get("enterprise_sanctioned_value"),
            "restricted_only properties should not have enterprise_sanctioned_value",
        )

    def test_http_authentication_classification(self):
        """Test http_authentication is correctly classified as restricted_only"""
        prop = self.properties.get("http_authentication")
        self.assertIsNotNone(prop, "http_authentication property not found")
        self.assertEqual(
            prop.get("enterprise_constructor"),
            "restricted_only",
            "http_authentication should be restricted_only, not restricted_with_sanctioned",
        )

    def test_http_authentication_restricted_value(self):
        """Test http_authentication has correct restricted (Enterprise) value"""
        prop = self.properties.get("http_authentication")
        self.assertIsNotNone(prop)
        self.assertEqual(
            prop.get("enterprise_restricted_value"),
            ["OIDC"],
            "http_authentication restricted value should be ['OIDC']",
        )

    def test_http_authentication_community_default(self):
        """Test http_authentication default is the Community value (BASIC)"""
        prop = self.properties.get("http_authentication")
        self.assertIsNotNone(prop)
        self.assertEqual(
            prop.get("default"),
            ["BASIC"],
            "http_authentication default should be ['BASIC'] (Community value), not ['OIDC']",
        )

    def test_sasl_mechanisms_classification(self):
        """Test sasl_mechanisms is correctly classified as restricted_only"""
        prop = self.properties.get("sasl_mechanisms")
        self.assertIsNotNone(prop, "sasl_mechanisms property not found")
        self.assertEqual(
            prop.get("enterprise_constructor"),
            "restricted_only",
            "sasl_mechanisms should be restricted_only",
        )

    def test_sasl_mechanisms_restricted_values(self):
        """Test sasl_mechanisms has correct restricted (Enterprise) values"""
        prop = self.properties.get("sasl_mechanisms")
        self.assertIsNotNone(prop)
        restricted = prop.get("enterprise_restricted_value", [])
        self.assertIn("GSSAPI", restricted)
        self.assertIn("OAUTHBEARER", restricted)

    def test_sasl_mechanisms_community_default(self):
        """Test sasl_mechanisms default is the Community value (SCRAM)"""
        prop = self.properties.get("sasl_mechanisms")
        self.assertIsNotNone(prop)
        self.assertEqual(
            prop.get("default"),
            ["SCRAM"],
            "sasl_mechanisms default should be ['SCRAM'] (Community value), not ['GSSAPI', 'OAUTHBEARER']",
        )


class SimpleEnterpriseTest(EnterprisePropertyDetectionTest):
    """Test simple enterprise properties (no specific value restrictions)"""

    def test_simple_enterprise_properties_exist(self):
        """Test that simple enterprise properties are detected"""
        simple = self.get_enterprise_properties_by_type("simple")
        self.assertGreater(
            len(simple),
            0,
            "Expected at least 1 simple enterprise property to exist",
        )

    def test_default_leaders_preference_classification(self):
        """Test default_leaders_preference is classified as simple enterprise"""
        prop = self.properties.get("default_leaders_preference")
        if prop:  # Only test if property exists
            self.assertEqual(
                prop.get("enterprise_constructor"),
                "simple",
                "default_leaders_preference should be simple enterprise",
            )

    def test_simple_properties_have_no_restricted_values(self):
        """Test simple enterprise properties don't have restricted/sanctioned values"""
        simple = self.get_enterprise_properties_by_type("simple")
        for name, prop in simple.items():
            self.assertIsNone(
                prop.get("enterprise_restricted_value"),
                f"Simple enterprise property '{name}' should not have enterprise_restricted_value",
            )
            self.assertIsNone(
                prop.get("enterprise_sanctioned_value"),
                f"Simple enterprise property '{name}' should not have enterprise_sanctioned_value",
            )


class EnterpriseDefaultDescriptionTest(EnterprisePropertyDetectionTest):
    """Test that no enterprise_default_description fields are generated"""

    def test_no_enterprise_default_description_in_restricted_with_sanctioned(self):
        """Test restricted_with_sanctioned properties don't have enterprise_default_description"""
        restricted_with_sanctioned = self.get_enterprise_properties_by_type(
            "restricted_with_sanctioned"
        )
        for name, prop in restricted_with_sanctioned.items():
            self.assertNotIn(
                "enterprise_default_description",
                prop,
                f"Property '{name}' should not have enterprise_default_description field",
            )

    def test_no_enterprise_default_description_in_restricted_only(self):
        """Test restricted_only properties don't have enterprise_default_description"""
        restricted_only = self.get_enterprise_properties_by_type("restricted_only")
        for name, prop in restricted_only.items():
            self.assertNotIn(
                "enterprise_default_description",
                prop,
                f"Property '{name}' should not have enterprise_default_description field",
            )

    def test_no_enterprise_default_description_in_simple(self):
        """Test simple enterprise properties don't have enterprise_default_description"""
        simple = self.get_enterprise_properties_by_type("simple")
        for name, prop in simple.items():
            self.assertNotIn(
                "enterprise_default_description",
                prop,
                f"Property '{name}' should not have enterprise_default_description field",
            )

    def test_no_enterprise_default_description_anywhere(self):
        """Test that no property in the entire output has enterprise_default_description"""
        props_with_desc = [
            name
            for name, prop in self.properties.items()
            if "enterprise_default_description" in prop
        ]
        self.assertEqual(
            len(props_with_desc),
            0,
            f"No properties should have enterprise_default_description, but found in: {props_with_desc}",
        )


class EnterpriseValueConsistencyTest(EnterprisePropertyDetectionTest):
    """Test consistency between enterprise values and defaults"""

    def test_restricted_with_sanctioned_default_matches_restricted(self):
        """Test that restricted_with_sanctioned properties have defaults matching restricted values"""
        restricted_with_sanctioned = self.get_enterprise_properties_by_type(
            "restricted_with_sanctioned"
        )
        for name, prop in restricted_with_sanctioned.items():
            default = prop.get("default")
            restricted = prop.get("enterprise_restricted_value", [])
            sanctioned = prop.get("enterprise_sanctioned_value", [])

            # Convert boolean default to string for comparison
            default_str = str(default).lower() if isinstance(default, bool) else default

            self.assertIn(
                default_str,
                [str(v).lower() for v in restricted],
                f"Property '{name}' default '{default}' should match one of restricted values {restricted}, not sanctioned values {sanctioned}",
            )

    def test_restricted_only_default_not_in_restricted(self):
        """Test that restricted_only properties have defaults NOT in restricted values"""
        restricted_only = self.get_enterprise_properties_by_type("restricted_only")
        for name, prop in restricted_only.items():
            default = prop.get("default")
            restricted = prop.get("enterprise_restricted_value", [])

            # Handle array defaults (like http_authentication)
            if isinstance(default, list) and len(default) > 0:
                default = default[0]

            # Convert to string for comparison
            default_str = str(default).lower() if default is not None else ""

            self.assertNotIn(
                default_str,
                [str(v).lower() for v in restricted],
                f"Property '{name}' default '{default}' should be a Community value, not a restricted (Enterprise) value {restricted}",
            )

    def test_restricted_with_sanctioned_have_both_values(self):
        """Test that restricted_with_sanctioned properties have both restricted and sanctioned values"""
        restricted_with_sanctioned = self.get_enterprise_properties_by_type(
            "restricted_with_sanctioned"
        )
        for name, prop in restricted_with_sanctioned.items():
            restricted = prop.get("enterprise_restricted_value")
            sanctioned = prop.get("enterprise_sanctioned_value")

            self.assertIsNotNone(
                restricted,
                f"Property '{name}' should have enterprise_restricted_value",
            )
            self.assertIsNotNone(
                sanctioned,
                f"Property '{name}' should have enterprise_sanctioned_value",
            )
            self.assertGreater(
                len(restricted),
                0,
                f"Property '{name}' should have at least one restricted value",
            )
            self.assertGreater(
                len(sanctioned),
                0,
                f"Property '{name}' should have at least one sanctioned value",
            )

    def test_restricted_only_have_only_restricted_values(self):
        """Test that restricted_only properties have only restricted values, no sanctioned"""
        restricted_only = self.get_enterprise_properties_by_type("restricted_only")
        for name, prop in restricted_only.items():
            restricted = prop.get("enterprise_restricted_value")
            sanctioned = prop.get("enterprise_sanctioned_value")

            self.assertIsNotNone(
                restricted,
                f"Property '{name}' should have enterprise_restricted_value",
            )
            self.assertIsNone(
                sanctioned,
                f"Property '{name}' should NOT have enterprise_sanctioned_value (restricted_only pattern)",
            )
            self.assertGreater(
                len(restricted),
                0,
                f"Property '{name}' should have at least one restricted value",
            )


class RegressionTest(EnterprisePropertyDetectionTest):
    """Regression tests for specific bugs that were fixed"""

    def test_http_authentication_not_restricted_with_sanctioned(self):
        """
        Regression test: http_authentication was incorrectly classified as
        restricted_with_sanctioned when it should be restricted_only.

        Bug: Pattern detection was checking params[4] vs params[0] which incorrectly
        matched http_authentication because of the validator parameter.

        Fix: Use property name position to determine pattern and check for specific
        properties by name.
        """
        prop = self.properties.get("http_authentication")
        self.assertIsNotNone(prop)
        self.assertEqual(
            prop.get("enterprise_constructor"),
            "restricted_only",
            "http_authentication should be restricted_only, not restricted_with_sanctioned",
        )



if __name__ == "__main__":
    unittest.main()
