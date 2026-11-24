"""
Regression test for TypeDefinitionExtractor's header scan order.

_scan_directory used to iterate Path.rglob("*.h") directly, whose order
follows the filesystem and differs between checkouts. When two headers
produce the same qualified name, the later one overwrote the earlier one,
so the same source tag gave different "definitions" on different runs.
On v26.3.1-rc4, cloud_io::policy_type came out from config/configuration.h,
config/rjson_serialization.h or config/property.h depending on the order.

The fix sorts the scan and keeps the first definition of a name. This test
forces both scan orders and checks they give the same result.
"""

import os
import pathlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../tools/property-extractor'))

from type_definition_extractor import TypeDefinitionExtractor

HEADERS = {
    'config/aaa.h': 'namespace demo {\nenum class mode { first_a, first_b };\n}\n',
    'config/zzz.h': 'namespace demo {\nenum class mode { last_a, last_b, last_c };\n}\n',
}


def _extract(root, reverse):
    original = pathlib.Path.rglob

    def ordered(self, pattern):
        return iter(sorted(original(self, pattern), reverse=reverse))

    with mock.patch.object(pathlib.Path, 'rglob', ordered):
        return TypeDefinitionExtractor(str(root)).extract_all_definitions()


class TestTypeDefinitionsAreDeterministic(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        for rel, text in HEADERS.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

    def tearDown(self):
        self._tmp.cleanup()

    def test_result_does_not_depend_on_filesystem_order(self):
        self.assertEqual(_extract(self.root, reverse=False), _extract(self.root, reverse=True))

    def test_first_header_in_sorted_order_wins(self):
        definition = _extract(self.root, reverse=True)['demo::mode']
        self.assertEqual(definition['defined_in'], 'config/aaa.h')
        self.assertEqual(definition['enum'], ['first_a', 'first_b'])


if __name__ == '__main__':
    unittest.main()
