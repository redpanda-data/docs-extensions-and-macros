"""
Unit tests for override application in property_extractor.

Covers phantom stub tracking: an override key that matches no extracted
property fabricates a placeholder doc entry, and the run must record every
such stub so the end-of-run summary can flag them loudly.
"""

import logging
import unittest
import sys
import os

# Add property-extractor directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../tools/property-extractor'))

import property_extractor
from property_extractor import apply_property_overrides, report_phantom_stubs


class TestPhantomStubTracking(unittest.TestCase):
    """Test that phantom stubs created from overrides are tracked and reported."""

    def test_phantom_stub_recorded_for_unmatched_override_key(self):
        """An override key with no matching property creates a stub and records it."""
        properties = {}
        overrides = {"properties": {"ghost_property": {"description": "Docs for a removed property"}}}

        result = apply_property_overrides(properties, overrides)

        self.assertIn("ghost_property", result)
        self.assertEqual(result["ghost_property"]["defined_in"], "override")
        self.assertEqual(len(property_extractor.phantom_stub_entries), 1)
        entry = property_extractor.phantom_stub_entries[0]
        self.assertEqual(entry["name"], "ghost_property")
        self.assertEqual(entry["config_scope"], "topic")

    def test_phantom_stub_records_override_scope(self):
        """The recorded scope reflects the override's config_scope, not just the default."""
        overrides = {"properties": {"ghost_cluster_property": {"config_scope": "cluster"}}}

        apply_property_overrides({}, overrides)

        self.assertEqual(len(property_extractor.phantom_stub_entries), 1)
        self.assertEqual(property_extractor.phantom_stub_entries[0]["config_scope"], "cluster")

    def test_no_phantom_stub_when_override_matches_property_key(self):
        """Overrides applied to an existing property key are not phantom stubs."""
        properties = {"real_property": {"name": "real_property", "description": "old"}}
        overrides = {"properties": {"real_property": {"description": "new"}}}

        result = apply_property_overrides(properties, overrides)

        self.assertEqual(result["real_property"]["description"], "new")
        self.assertEqual(property_extractor.phantom_stub_entries, [])

    def test_no_phantom_stub_when_override_matches_name_field(self):
        """The name-field fallback match is not a phantom stub either."""
        properties = {"some_key": {"name": "renamed_property", "description": "old"}}
        overrides = {"properties": {"renamed_property": {"description": "new"}}}

        result = apply_property_overrides(properties, overrides)

        self.assertEqual(result["some_key"]["description"], "new")
        self.assertNotIn("renamed_property", result)
        self.assertEqual(property_extractor.phantom_stub_entries, [])

    def test_tracking_resets_between_runs(self):
        """A later run does not report phantom stubs from an earlier run."""
        apply_property_overrides({}, {"properties": {"ghost_one": {}}})
        self.assertEqual(len(property_extractor.phantom_stub_entries), 1)

        apply_property_overrides({"kept": {"name": "kept"}}, {"properties": {"kept": {"description": "x"}}})

        self.assertEqual(property_extractor.phantom_stub_entries, [])

    def test_multiple_phantom_stubs_are_all_collected(self):
        """Every unmatched override key is collected, not just the first."""
        overrides = {"properties": {
            "ghost_one": {},
            "ghost_two": {"config_scope": "broker"},
        }}

        apply_property_overrides({}, overrides)

        names = [entry["name"] for entry in property_extractor.phantom_stub_entries]
        self.assertEqual(sorted(names), ["ghost_one", "ghost_two"])

    def test_report_logs_prominent_warning_block(self):
        """report_phantom_stubs logs a warning naming the stub, its scope, and the fix."""
        apply_property_overrides({}, {"properties": {"ghost_property": {}}})

        with self.assertLogs("viewer", level="WARNING") as captured:
            report_phantom_stubs()

        output = "\n".join(captured.output)
        self.assertIn("matched no extracted property", output)
        self.assertIn("ghost_property", output)
        self.assertIn("config_scope 'topic'", output)
        self.assertIn("property-overrides.json", output)

    def test_report_logs_nothing_when_no_phantom_stubs(self):
        """report_phantom_stubs stays silent when every override matched."""
        properties = {"real_property": {"name": "real_property"}}
        apply_property_overrides(properties, {"properties": {"real_property": {"description": "x"}}})

        # assertNoLogs requires Python 3.10, and CI also runs 3.9. Log a
        # sentinel inside assertLogs and assert it is the only record.
        with self.assertLogs("viewer", level="WARNING") as captured:
            logging.getLogger("viewer").warning("sentinel")
            report_phantom_stubs()
        self.assertEqual(captured.output, ["WARNING:viewer:sentinel"])


if __name__ == "__main__":
    unittest.main()
