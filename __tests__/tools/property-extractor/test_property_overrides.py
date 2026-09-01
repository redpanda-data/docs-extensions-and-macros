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
from property_extractor import apply_property_overrides, report_phantom_stubs, _normalize_admonitions


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


class TestAdmonitionsOverride(unittest.TestCase):
    """Structured NOTE/TIP/IMPORTANT/WARNING/CAUTION callouts, applied as an
    override field instead of markup embedded in the description text."""

    def test_normalizes_type_to_uppercase(self):
        result = _normalize_admonitions([{"type": "note", "text": "Be careful."}])
        self.assertEqual(result, [{"type": "NOTE", "text": "Be careful."}])

    def test_preserves_optional_title(self):
        result = _normalize_admonitions([{"type": "warning", "title": "Don't do this.", "text": "x"}])
        self.assertEqual(result, [{"type": "WARNING", "title": "Don't do this.", "text": "x"}])

    def test_omits_title_key_when_not_given(self):
        result = _normalize_admonitions([{"type": "note", "text": "x"}])
        self.assertNotIn("title", result[0])

    def test_accepts_every_admonition_type(self):
        entries = [{"type": t, "text": "x"} for t in
                   ("note", "tip", "important", "warning", "caution")]
        result = _normalize_admonitions(entries)
        self.assertEqual([e["type"] for e in result],
                          ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"])

    def test_drops_entry_with_unknown_type(self):
        with self.assertLogs("viewer", level="WARNING") as captured:
            result = _normalize_admonitions([
                {"type": "note", "text": "kept"},
                {"type": "danger", "text": "dropped, not a real AsciiDoc admonition type"},
            ])
        self.assertEqual(result, [{"type": "NOTE", "text": "kept"}])
        self.assertIn("unknown type", "\n".join(captured.output))

    def test_drops_entry_missing_text_or_type(self):
        with self.assertLogs("viewer", level="WARNING"):
            result = _normalize_admonitions([{"type": "note"}, {"text": "no type"}])
        self.assertEqual(result, [])

    def test_drops_entry_with_non_string_text(self):
        with self.assertLogs("viewer", level="WARNING") as captured:
            result = _normalize_admonitions([{"type": "note", "text": ["not", "a", "string"]}])
        self.assertEqual(result, [])
        self.assertIn("string type and text", "\n".join(captured.output))

    def test_drops_entry_with_non_string_title(self):
        with self.assertLogs("viewer", level="WARNING") as captured:
            result = _normalize_admonitions([{"type": "note", "text": "x", "title": 123}])
        self.assertEqual(result, [])
        self.assertIn("title must be a string", "\n".join(captured.output))

    def test_returns_none_for_non_list_input(self):
        with self.assertLogs("viewer", level="WARNING") as captured:
            result = _normalize_admonitions("not a list")
        self.assertIsNone(result)
        self.assertIn("must be an array", "\n".join(captured.output))

    def test_applies_to_existing_property_via_override(self):
        properties = {"seed_servers": {"name": "seed_servers", "description": "d"}}
        overrides = {"properties": {"seed_servers": {
            "admonitions": [{"type": "important", "text": "Only one broker should have an empty seed_servers list."}],
        }}}

        result = apply_property_overrides(properties, overrides)

        self.assertEqual(result["seed_servers"]["admonitions"],
                          [{"type": "IMPORTANT", "text": "Only one broker should have an empty seed_servers list."}])

    def test_malformed_admonitions_override_does_not_set_field(self):
        properties = {"x": {"name": "x", "description": "d"}}
        overrides = {"properties": {"x": {"admonitions": "not a list"}}}

        with self.assertLogs("viewer", level="WARNING"):
            result = apply_property_overrides(properties, overrides)

        self.assertNotIn("admonitions", result["x"])

    def test_phantom_stub_normalizes_admonitions_type(self):
        """A new property created from an unmatched override key must go
        through the same normalization as an existing property, not a raw
        passthrough -- otherwise it ships with a lowercase `type` that
        AsciiDoc won't render as a real admonition block."""
        overrides = {"properties": {"ghost_property": {
            "admonitions": [{"type": "warning", "text": "x"}],
        }}}

        result = apply_property_overrides({}, overrides)

        self.assertEqual(result["ghost_property"]["admonitions"],
                          [{"type": "WARNING", "text": "x"}])

    def test_phantom_stub_malformed_admonitions_does_not_set_field(self):
        """A malformed admonitions value on a phantom stub is dropped with a
        warning, not passed through unvalidated."""
        overrides = {"properties": {"ghost_property": {"admonitions": "not a list"}}}

        with self.assertLogs("viewer", level="WARNING"):
            result = apply_property_overrides({}, overrides)

        self.assertNotIn("admonitions", result["ghost_property"])


if __name__ == "__main__":
    unittest.main()
