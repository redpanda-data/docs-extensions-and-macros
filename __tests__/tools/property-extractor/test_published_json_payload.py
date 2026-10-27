"""
The published properties JSON must not carry tooling-only span fields.

parser.py records line_start/line_end so lint-strings and preview-string can
anchor a finding to its full declaration. Those fields are additive to the raw
--output, which is the file those tools consume - but the ENHANCED output is
copied verbatim into modules/reference/attachments and downloaded by every
browser that hovers a prop: macro. Measured on the fixture pair, the spans cost
about 58 bytes per property, which is roughly 81KB across the real
~1400-property file, for data no reader consumes.

So the split has to hold in both directions: spans present in the raw output,
absent from the enhanced one.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

TOOL_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "../../../tools/property-extractor")
)
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../.."))
FIXTURES = os.path.join(REPO_ROOT, "tools/lint-strings/fixtures/properties")
VENV_PYTHON = os.path.join(
    TOOL_ROOT, "tmp/redpanda-property-extractor-venv/bin/python"
)

sys.path.insert(0, TOOL_ROOT)

from property_extractor import (  # noqa: E402
    TOOLING_ONLY_PROPERTY_FIELDS,
    strip_tooling_only_fields,
)


class TestStripToolingOnlyFields(unittest.TestCase):
    """Unit: the stripper removes exactly the span fields and nothing else."""

    def test_removes_spans_and_leaves_everything_else(self):
        props = {
            "a": {
                "name": "a",
                "description": "Does a thing.",
                "default": 30,
                "line_start": 100,
                "line_end": 104,
            },
            "b": {"name": "b", "description": "Does another thing."},
        }
        out = strip_tooling_only_fields(props)
        self.assertEqual(
            out["a"], {"name": "a", "description": "Does a thing.", "default": 30}
        )
        self.assertEqual(out["b"], {"name": "b", "description": "Does another thing."})

    def test_covers_both_span_fields(self):
        # Guard the guard: a shrunken field tuple would make this vacuous.
        self.assertEqual(
            sorted(TOOLING_ONLY_PROPERTY_FIELDS), ["line_end", "line_start"]
        )

    def test_tolerates_non_dict_entries(self):
        props = {"a": None, "b": "not a property"}
        self.assertEqual(strip_tooling_only_fields(props), props)


@unittest.skipUnless(
    os.path.exists(VENV_PYTHON),
    "property-extractor venv not built; run make -C tools/property-extractor venv treesitter",
)
class TestRawKeepsSpansPublishedDoesNot(unittest.TestCase):
    """End to end over the real extractor: the two outputs must differ."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="published-json-payload-")
        config_dir = os.path.join(cls.tmp, "repo", "src", "v", "config")
        os.makedirs(config_dir)
        shutil.copyfile(
            os.path.join(FIXTURES, "lint_fixture.h"),
            os.path.join(config_dir, "configuration.h"),
        )
        shutil.copyfile(
            os.path.join(FIXTURES, "lint_fixture.cc"),
            os.path.join(config_dir, "configuration.cc"),
        )
        cls.raw_path = os.path.join(cls.tmp, "raw.json")
        cls.enhanced_path = os.path.join(cls.tmp, "enhanced.json")
        subprocess.run(
            [
                VENV_PYTHON,
                "-W",
                "ignore",
                "property_extractor.py",
                "--recursive",
                "--path",
                os.path.join(cls.tmp, "repo"),
                "--output",
                cls.raw_path,
                "--enhanced-output",
                cls.enhanced_path,
            ],
            cwd=TOOL_ROOT,
            check=True,
            capture_output=True,
        )
        with open(cls.raw_path) as handle:
            cls.raw = json.load(handle)["properties"]
        with open(cls.enhanced_path) as handle:
            cls.enhanced = json.load(handle)["properties"]

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_the_fixture_actually_produced_properties(self):
        # Guard the guard: zero properties would make every assertion below
        # trivially true.
        self.assertGreater(len(self.raw), 0)
        self.assertEqual(sorted(self.raw), sorted(self.enhanced))

    def test_raw_output_keeps_every_span(self):
        # This is what lint-strings and preview-string read.
        for name, prop in self.raw.items():
            self.assertIn("line_start", prop, f"{name} lost its declaration span")
            self.assertIn("line_end", prop, f"{name} lost its declaration span")

    def test_published_output_carries_no_span(self):
        for name, prop in self.enhanced.items():
            for field in TOOLING_ONLY_PROPERTY_FIELDS:
                self.assertNotIn(
                    field, prop, f"{name} would ship {field} to every reader"
                )

    def test_nothing_else_changed_between_the_two_outputs(self):
        for name, raw_prop in self.raw.items():
            expected = {
                key: value
                for key, value in raw_prop.items()
                if key not in TOOLING_ONLY_PROPERTY_FIELDS
            }
            enhanced_prop = self.enhanced[name]
            # _ensure_category_fallback (property_extractor.py) stamps a
            # category onto every property in the enhanced/published output,
            # so none silently vanish from the category-tag pages that
            # assemble docs from tag::category-X[] regions -- the raw output,
            # read only by lint-strings/preview-string, is left exactly as
            # extracted. A property with no category in the raw output is
            # the one intentional divergence; everything else must still
            # match exactly.
            if "category" not in expected:
                self.assertIn(
                    "category", enhanced_prop, f"{name} has no category in the published output"
                )
                expected["category"] = enhanced_prop["category"]
            self.assertEqual(expected, enhanced_prop)

    def test_the_published_file_is_smaller(self):
        self.assertLess(
            os.path.getsize(self.enhanced_path), os.path.getsize(self.raw_path)
        )


if __name__ == "__main__":
    unittest.main()
