"""
Unit tests for the see_also override field in property_extractor.

see_also replaces related_topics' free-text 'cloud-only:'/'self-managed-only:'
prefix convention with structured data (a plain string, or an object naming
exactly one of cloud_only/self_hosted_only), validated by
docs-data/property-overrides.schema.json via `doc-tools validate
property-overrides`. property_extractor.py's job is just to pass the field
through unchanged onto the property record — normalizing and rendering it
happens in seeAlsoView.js at generation time.
"""

import unittest
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../tools/property-extractor'))

from property_extractor import apply_property_overrides


class TestSeeAlsoOverride(unittest.TestCase):
    def test_see_also_applied_to_existing_property(self):
        properties = {"audit_enabled": {"name": "audit_enabled", "description": "old"}}
        overrides = {"properties": {"audit_enabled": {
            "see_also": [
                "xref:reference:properties/cluster-properties.adoc#audit_enabled_event_types[]",
                {"content": "xref:manage:cluster-maintenance/config-cluster.adoc[]", "cloud_only": True},
            ]
        }}}

        result = apply_property_overrides(properties, overrides)

        self.assertEqual(result["audit_enabled"]["see_also"], overrides["properties"]["audit_enabled"]["see_also"])

    def test_see_also_applied_to_override_created_property(self):
        overrides = {"properties": {"ghost_property": {
            "see_also": [{"content": "xref:a.adoc[]", "self_hosted_only": True}]
        }}}

        result = apply_property_overrides({}, overrides)

        self.assertEqual(
            result["ghost_property"]["see_also"],
            [{"content": "xref:a.adoc[]", "self_hosted_only": True}],
        )

    def test_non_list_see_also_is_rejected_with_a_warning_not_a_crash(self):
        properties = {"audit_enabled": {"name": "audit_enabled"}}
        overrides = {"properties": {"audit_enabled": {"see_also": "not a list"}}}

        with self.assertLogs("viewer", level="WARNING") as captured:
            result = apply_property_overrides(properties, overrides)

        self.assertNotIn("see_also", result["audit_enabled"])
        self.assertTrue(any("see_also" in line for line in captured.output))

    def test_related_topics_still_works_alongside_see_also(self):
        """The deprecated field keeps working — see_also is additive, not a breaking rename."""
        properties = {"audit_enabled": {"name": "audit_enabled"}}
        overrides = {"properties": {"audit_enabled": {
            "related_topics": ["cloud-only: xref:a.adoc[]"]
        }}}

        result = apply_property_overrides(properties, overrides)

        self.assertEqual(result["audit_enabled"]["related_topics"], ["cloud-only: xref:a.adoc[]"])


if __name__ == "__main__":
    unittest.main()
