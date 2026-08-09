/**
 * Tests for the ConstantResolver class, specifically numeric constant resolution.
 * Related to DOC-2137: Property docs should show resolved values instead of constant names.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('ConstantResolver numeric constants', () => {
  const pythonScript = path.join(__dirname, '../../tools/property-extractor/test_constant_resolver.py');

  beforeAll(() => {
    // Create a test Python script that exercises the ConstantResolver
    const testScript = `#!/usr/bin/env python3
"""Test script for ConstantResolver numeric constant resolution."""

import sys
import os
import tempfile
import json

# Add the property-extractor directory to the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

from constant_resolver import ConstantResolver

def test_parse_size_literal():
    """Test _parse_size_literal method."""
    # Create a minimal resolver (source_path doesn't need to exist for this test)
    resolver = ConstantResolver(source_path=tempfile.mkdtemp())

    tests = [
        ("256_MiB", 256 * 1024**2),
        ("20_GiB", 20 * 1024**3),
        ("1_KiB", 1024),
        ("1024", 1024),
        ("1_GB", 1000**3),
        ("1_MB", 1000**2),
        ("1_KB", 1000),
    ]

    results = []
    for input_val, expected in tests:
        actual = resolver._parse_size_literal(input_val)
        results.append({
            "input": input_val,
            "expected": expected,
            "actual": actual,
            "pass": actual == expected
        })

    return results

def test_format_numeric_result():
    """Test _format_numeric_result method."""
    import tempfile
    resolver = ConstantResolver(source_path=tempfile.mkdtemp())

    tests = [
        (268435456, {"raw": 268435456, "friendly": "256 MiB (268435456)"}),
        (21474836480, {"raw": 21474836480, "friendly": "20 GiB (21474836480)"}),
        (1024, {"raw": 1024, "friendly": "1 KiB (1024)"}),
        (1000, {"raw": 1000, "friendly": "1000"}),  # Not a clean binary unit
    ]

    results = []
    for input_val, expected in tests:
        actual = resolver._format_numeric_result(input_val)
        results.append({
            "input": input_val,
            "expected": expected,
            "actual": actual,
            "pass": actual == expected
        })

    return results

def test_resolve_numeric_constant_with_mock_source():
    """Test resolve_numeric_constant with mock source files."""
    import tempfile
    import shutil

    # Create a mock source directory structure
    temp_dir = tempfile.mkdtemp()
    config_dir = os.path.join(temp_dir, 'config')
    os.makedirs(config_dir)

    # Create a mock header file with numeric constants
    mock_header = '''
#pragma once

namespace config {

// Memory per partition constant
constexpr size_t DEFAULT_TOPIC_MEMORY_PER_PARTITION = 268435456;

// Another constant with size literal
inline constexpr uint64_t DEFAULT_BUFFER_SIZE = 20971520;

// Using auto
constexpr auto MAX_MESSAGE_SIZE = 1048576;

} // namespace config
'''

    with open(os.path.join(config_dir, 'configuration.h'), 'w') as f:
        f.write(mock_header)

    try:
        resolver = ConstantResolver(source_path=temp_dir)

        results = []

        # Test 1: Basic numeric constant
        result = resolver.resolve_numeric_constant('DEFAULT_TOPIC_MEMORY_PER_PARTITION')
        results.append({
            "test": "DEFAULT_TOPIC_MEMORY_PER_PARTITION",
            "expected_raw": 268435456,
            "actual": result,
            "pass": result is not None and result.get('raw') == 268435456
        })

        # Test 2: Another numeric constant
        result = resolver.resolve_numeric_constant('DEFAULT_BUFFER_SIZE')
        results.append({
            "test": "DEFAULT_BUFFER_SIZE",
            "expected_raw": 20971520,
            "actual": result,
            "pass": result is not None and result.get('raw') == 20971520
        })

        # Test 3: Constant with auto type
        result = resolver.resolve_numeric_constant('MAX_MESSAGE_SIZE')
        results.append({
            "test": "MAX_MESSAGE_SIZE",
            "expected_raw": 1048576,
            "actual": result,
            "pass": result is not None and result.get('raw') == 1048576
        })

        # Test 4: Non-existent constant
        result = resolver.resolve_numeric_constant('NON_EXISTENT_CONSTANT')
        results.append({
            "test": "NON_EXISTENT_CONSTANT",
            "expected": None,
            "actual": result,
            "pass": result is None
        })

        return results
    finally:
        shutil.rmtree(temp_dir)

if __name__ == '__main__':
    all_results = {
        "parse_size_literal": test_parse_size_literal(),
        "format_numeric_result": test_format_numeric_result(),
        "resolve_numeric_constant": test_resolve_numeric_constant_with_mock_source(),
    }

    print(json.dumps(all_results, indent=2))

    # Exit with error if any test failed
    for test_name, results in all_results.items():
        for r in results:
            if not r.get('pass'):
                sys.exit(1)
    sys.exit(0)
`;

    fs.writeFileSync(pythonScript, testScript);
  });

  afterAll(() => {
    // Clean up the test script
    if (fs.existsSync(pythonScript)) {
      fs.unlinkSync(pythonScript);
    }
  });

  test('_parse_size_literal parses size literals correctly', () => {
    const output = execSync(`python3 ${pythonScript}`, { encoding: 'utf-8' });
    const results = JSON.parse(output);

    for (const r of results.parse_size_literal) {
      expect(r.pass).toBe(true);
    }
  });

  test('_format_numeric_result formats bytes with friendly representation', () => {
    const output = execSync(`python3 ${pythonScript}`, { encoding: 'utf-8' });
    const results = JSON.parse(output);

    for (const r of results.format_numeric_result) {
      expect(r.pass).toBe(true);
    }
  });

  test('resolve_numeric_constant finds constants in mock source files', () => {
    const output = execSync(`python3 ${pythonScript}`, { encoding: 'utf-8' });
    const results = JSON.parse(output);

    for (const r of results.resolve_numeric_constant) {
      expect(r.pass).toBe(true);
    }
  });
});
