"""
Tests for the gets_restored extraction default.

`src/v/config/base_property.h` declares `gets_restored{gets_restored::yes}`, so
a property carrying no `restored`/`gets_restored` annotation is restored on
Whole Cluster Restore. Leaving the key absent for those made "the declared
default applies" indistinguishable from "the data never reached us", and for a
release whose rp_util schema can never be published the templates read it as the
second: 626 rows rendered "Unknown (rp_util merge unavailable this build)" in
redpanda-data/docs#2036, and every topic-property row disappeared.

At v26.2.2 all 17 annotated properties say `no`, so the default is what the
other 674 rely on.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../tools/property-extractor'))

from transformers import GetsRestoredTransformer, MetaParamTransformer, get_meta_value


def info_with(meta=None):
    """The shape the C++ parser hands transformers for a property."""
    return {"params": [{"value": meta}] if meta else []}


class TestGetsRestoredDefault(unittest.TestCase):
    def setUp(self):
        self.transformer = GetsRestoredTransformer()

    def parse(self, meta=None):
        info = info_with(meta)
        self.assertTrue(
            self.transformer.accepts(info, None),
            "every source-parsed property must be accepted, annotated or not",
        )
        prop = {}
        self.transformer.parse(prop, info, None)
        return prop

    def test_no_meta_block_uses_the_declared_default(self):
        self.assertIs(self.parse().get("gets_restored"), True)

    def test_meta_block_without_the_key_uses_the_declared_default(self):
        prop = self.parse("meta{ .visibility = visibility::user }")
        self.assertIs(prop.get("gets_restored"), True)

    def test_explicit_no_is_respected(self):
        self.assertIs(self.parse("meta{ .gets_restored = gets_restored::no }")["gets_restored"], False)

    def test_legacy_restored_spelling_is_respected(self):
        self.assertIs(self.parse("meta{ .restored = restored::no }")["gets_restored"], False)

    def test_explicit_yes_is_respected(self):
        self.assertIs(self.parse("meta{ .gets_restored = gets_restored::yes }")["gets_restored"], True)

    def test_key_is_never_left_absent(self):
        for meta in (None,
                     "meta{ .visibility = visibility::user }",
                     "meta{ .gets_restored = gets_restored::no }",
                     "{.needs_restart = needs_restart::no, .restored = restored::no}"):
            with self.subTest(meta=meta):
                self.assertIn("gets_restored", self.parse(meta))


class TestPipelineOrder(unittest.TestCase):
    """property_extractor.py runs MetaParamTransformer before
    GetsRestoredTransformer against the same info dict, and the first one
    replaces the raw meta string with a parsed dict (`p["value"] = meta_dict`).

    That ordering is the whole hazard: defaulting unconditionally in the second
    transformer overwrote a `no` the first had already parsed correctly. It only
    bit a meta block holding nothing but gets_restored/restored, because
    find_meta_dict's parsed-dict branch did not list those keys, so the lookup
    returned None and looked like "no annotation". Running each transformer
    against its own fresh dict cannot see it.
    """

    def run_pipeline(self, meta):
        info = info_with(meta)
        prop = {}
        for transformer in (MetaParamTransformer(), GetsRestoredTransformer()):
            if transformer.accepts(info, None):
                transformer.parse(prop, info, None)
        return prop

    def test_a_gets_restored_only_block_is_not_inverted(self):
        for meta in ("meta{ .gets_restored = gets_restored::no }",
                     "meta{ .restored = restored::no }"):
            with self.subTest(meta=meta):
                self.assertIs(self.run_pipeline(meta)["gets_restored"], False)

    def test_an_annotation_alongside_other_meta_keys_still_holds(self):
        for meta in ("meta{ .needs_restart = needs_restart::no, .gets_restored = gets_restored::no }",
                     "meta{ .visibility = visibility::user, .restored = restored::no }"):
            with self.subTest(meta=meta):
                self.assertIs(self.run_pipeline(meta)["gets_restored"], False)

    def test_the_default_still_applies_through_the_pipeline(self):
        self.assertIs(self.run_pipeline("meta{ .visibility = visibility::user }")["gets_restored"], True)

    def test_explicit_yes_survives_the_pipeline(self):
        self.assertIs(self.run_pipeline("meta{ .gets_restored = gets_restored::yes }")["gets_restored"], True)

    def test_find_meta_dict_recognizes_a_restored_only_parsed_dict(self):
        info = info_with("meta{ .gets_restored = gets_restored::no }")
        MetaParamTransformer().parse({}, info, None)
        self.assertIsInstance(info["params"][0]["value"], dict, "MetaParamTransformer should have replaced the string")
        self.assertEqual(get_meta_value(info, "gets_restored"), "no")


if __name__ == "__main__":
    unittest.main()
