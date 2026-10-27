"""
Regression test for get_file_pairs' file-discovery order.

get_file_pairs used to iterate Path.rglob("*.h") directly, whose order
reflects the filesystem's own directory-entry order -- not guaranteed
stable across clones or machines. A property name registered in more than
one file hits transform_files_with_properties' "different defined_in"
branch, which keeps whichever file was processed last, so an unstable scan
order means a non-deterministic result: two regenerations of the exact same
source tag, six minutes apart in CI, produced two different defined_in
values for api_doc_dir, which src/v/pandaproxy/rest/configuration.cc and
src/v/pandaproxy/schema_registry/configuration.cc both register.

This asserts the fix (sorted(file_iter)) rather than trying to reproduce
the filesystem's own non-determinism, which a unit test cannot reliably
force either way: get_file_pairs' output must equal the sorted order of
its input, regardless of what order the filesystem happened to yield it in.
"""

import os
import sys
import tempfile
import unittest
from argparse import Namespace
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../tools/property-extractor'))

from property_extractor import get_file_pairs


class TestGetFilePairsIsSorted(unittest.TestCase):
    def test_pairs_come_back_in_sorted_path_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Names deliberately not in the order a directory would list them
            # alphabetically, and split across two subdirectories the way
            # pandaproxy/rest and pandaproxy/schema_registry are two real
            # sibling directories that each register api_doc_dir.
            pairs = [
                ('schema_registry/configuration', 'schema_registry_config'),
                ('rest/configuration', 'rest_config'),
                ('zzz/last', 'zzz_marker'),
                ('aaa/first', 'aaa_marker'),
            ]
            for rel, marker in pairs:
                h = root / f'{rel}.h'
                cc = root / f'{rel}.cc'
                h.parent.mkdir(parents=True, exist_ok=True)
                h.write_text(f'// {marker}\n')
                cc.write_text(f'// {marker}\n')

            options = Namespace(path=str(root), recursive=True)
            file_pairs = get_file_pairs(options)

            actual = [str(fp.implementation) for fp in file_pairs]
            self.assertEqual(actual, sorted(actual))

    def test_pairs_are_stable_across_repeated_calls(self):
        # The property this regression is about is registered identically in
        # two files; what must not vary is WHICH of the two calls wins, i.e.
        # the order get_file_pairs returns them in, run after run.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for rel in ['pandaproxy/rest/configuration', 'pandaproxy/schema_registry/configuration']:
                h = root / f'{rel}.h'
                cc = root / f'{rel}.cc'
                h.parent.mkdir(parents=True, exist_ok=True)
                h.write_text('// stub\n')
                cc.write_text('// stub\n')

            options = Namespace(path=str(root), recursive=True)
            first = [str(fp.implementation) for fp in get_file_pairs(options)]
            second = [str(fp.implementation) for fp in get_file_pairs(options)]
            self.assertEqual(first, second)


if __name__ == '__main__':
    unittest.main()
