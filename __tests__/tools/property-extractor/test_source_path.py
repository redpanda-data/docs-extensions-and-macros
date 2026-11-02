"""
find_redpanda_source must honor the --path argument.

Before this, the ConstantResolver initialization and the constexpr fallback
search hunted hardcoded cwd-relative locations (tmp/redpanda, ...). Running
the extractor with the source anywhere else silently disabled validator enum
extraction and enterprise enum metadata: sasl_mechanisms shipped without
items.enum or x-enum-metadata and only a debug log hinted why.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(
    0,
    str(Path(__file__).parent.parent.parent.parent / "tools" / "property-extractor"),
)

import property_extractor


class FindRedpandaSourceTest(unittest.TestCase):
    def tearDown(self):
        property_extractor.set_redpanda_source(None)

    def test_explicit_path_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            property_extractor.set_redpanda_source(tmp)
            self.assertEqual(property_extractor.find_redpanda_source(), tmp)

    def test_missing_explicit_path_falls_back(self):
        property_extractor.set_redpanda_source("/nonexistent/redpanda")
        result = property_extractor.find_redpanda_source()
        self.assertNotEqual(result, "/nonexistent/redpanda")

    def test_no_override_uses_search(self):
        property_extractor.set_redpanda_source(None)
        # Whatever the search finds, it must not raise
        property_extractor.find_redpanda_source()


if __name__ == "__main__":
    unittest.main()
