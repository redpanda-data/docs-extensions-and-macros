"""
Tests for C++ constant resolution used to render property defaults.

Regression coverage for defaults that reference member calls on inline
constants (for example, model::schema_registry_internal_tp.topic()), which
previously leaked raw C++ into rendered docs (log_eviction_exempt_topics
in v26.1.14 showed a default of [model::schema_registry_internal_tp.topic()]
instead of ["_schemas"]).
"""

import sys
import tempfile
import unittest
from pathlib import Path

# Add tools/property-extractor to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'tools' / 'property-extractor'))

import property_extractor as pe


class MemberCallResolutionTest(unittest.TestCase):
    """Member calls on inline constants must resolve to the literal the
    constant carries instead of leaking C++ into rendered defaults."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        src = Path(self.tmp.name) / 'src' / 'v' / 'model'
        src.mkdir(parents=True)
        (src / 'namespace.h').write_text(
            'namespace model {\n'
            'inline const model::topic_partition schema_registry_internal_tp{\n'
            '  model::topic{"_schemas"}, model::partition_id{0}};\n'
            '}\n'
        )
        self.cache = pe.ConstexprCache()
        self.cache.build_cache(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_member_call_resolves_qualified(self):
        self.assertEqual(
            self.cache.lookup_function('model::schema_registry_internal_tp.topic'),
            '_schemas'
        )

    def test_member_call_resolves_unqualified(self):
        self.assertEqual(
            self.cache.lookup_function('schema_registry_internal_tp.topic'),
            '_schemas'
        )


class FunctionCallPatternTest(unittest.TestCase):
    """FUNCTION_CALL_PATTERN must admit member calls without breaking
    free-function matching."""

    def test_matches_member_call(self):
        m = pe.FUNCTION_CALL_PATTERN.match('model::schema_registry_internal_tp.topic()')
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), 'model::schema_registry_internal_tp.topic')

    def test_still_matches_free_function(self):
        m = pe.FUNCTION_CALL_PATTERN.match('model::kafka_audit_logging_topic()')
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), 'model::kafka_audit_logging_topic')

    def test_does_not_match_calls_with_arguments(self):
        self.assertIsNone(pe.FUNCTION_CALL_PATTERN.match('std::chrono::milliseconds(30000)'))

    def test_does_not_match_call_with_trailing_expression(self):
        """A call that is only the prefix of a compound expression must not
        match, otherwise the resolver silently discards the rest of the
        expression (for example, `+ "_suffix"`)."""
        self.assertIsNone(pe.FUNCTION_CALL_PATTERN.match(
            'model::schema_registry_internal_tp.topic() + "_suffix"'
        ))
        self.assertIsNone(pe.FUNCTION_CALL_PATTERN.match(
            'model::kafka_audit_logging_topic() + other()'
        ))


if __name__ == '__main__':
    unittest.main()
