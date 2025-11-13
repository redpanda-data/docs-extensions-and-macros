# Property Extractor Unit Tests

## Overview

Comprehensive unit tests for the Redpanda property extraction system. These tests validate the transformer pipeline that processes C++ property declarations into JSON documentation format.

## Test Coverage

### EnterpriseTransformer Tests (5 tests)
- **test_restricted_only_with_enum_vector**: Validates correct classification when a property has restricted values AND an enum definition vector (enum is superset)
- **test_restricted_with_sanctioned_disjoint_values**: Validates classification when restricted and sanctioned values are disjoint sets
- **test_restricted_only_single_vector**: Tests simple restricted_only pattern with a single restriction vector
- **test_non_enterprise_property**: Ensures non-enterprise properties are correctly flagged
- **test_simple_enterprise_property**: Tests simple enterprise properties with lambda validators

### ParamNormalizerTransformer Tests (3 tests)
- **test_normalize_restriction_at_position_0**: Validates normalization when restriction vector is at parameter position 0
- **test_normalize_restriction_at_position_1**: Validates normalization when restriction vector is at parameter position 1
- **test_skip_normalization_for_literals**: Ensures properties starting with literals are not normalized

### TypeTransformer Tests (4 tests)
- **test_extract_type_from_property_declaration**: Extracts inner type from `property<T>` declarations
- **test_extract_type_from_vector**: Extracts type from `std::vector<T>` declarations
- **test_extract_type_from_one_or_many**: Extracts type from `one_or_many_property<T>` declarations
- **test_map_cpp_type_to_json_schema**: Validates C++ to JSON Schema type mappings

### BasicInfoTransformer Tests (3 tests)
- **test_extract_name_and_description**: Validates basic property name and description extraction
- **test_skip_lambda_validators**: Ensures lambda validator parameters are correctly skipped when finding property names
- **test_normalize_file_path**: Validates file path normalization to start with "src/"

### EnumPatternMatching Tests (2 tests)
- **test_enum_pattern_matches_qualified_identifier**: Validates ENUM_PATTERN regex matches qualified identifiers
- **test_enum_pattern_does_not_match_constructors**: Ensures ENUM_PATTERN doesn't match constructor syntax

### Integration Tests (2 placeholders)
- Placeholders for end-to-end pipeline testing

## Running Tests

### Using npm (Recommended)

The tests are integrated into the project's npm workflow and will automatically set up the Python environment:

```bash
# Run Python tests only (auto-creates venv and installs dependencies)
npm run test:python

# Run all tests (Jest + Python)
npm run test:all

# Run Jest tests only
npm test
```

The `test:python` script will:
1. Create a Python virtual environment if it doesn't exist
2. Install dependencies from `requirements.txt`
3. Run all pytest tests with verbose output

**Perfect for CI/CD** - No manual setup required, works in fresh environments.

### Using pytest directly

```bash
# Run all tests
cd __tests__/tools/property-extractor
python3 -m pytest test_transformers.py -v

# Run specific test class
python3 -m pytest test_transformers.py::TestEnterpriseTransformer -v

# Run specific test
python3 -m pytest test_transformers.py::TestEnterpriseTransformer::test_restricted_only_with_enum_vector -v
```

**Note:** Requires manual setup of Python dependencies first:
```bash
cd tools/property-extractor
python3 -m pip install -r requirements.txt
```

## Test Results

All 19 tests passing ✅

```
============================= test session starts ==============================
platform darwin -- Python 3.11.13, pytest-8.4.2, pluggy-1.6.0
collected 19 items

test_transformers.py::TestEnterpriseTransformer::test_non_enterprise_property PASSED
test_transformers.py::TestEnterpriseTransformer::test_restricted_only_single_vector PASSED
test_transformers.py::TestEnterpriseTransformer::test_restricted_only_with_enum_vector PASSED
test_transformers.py::TestEnterpriseTransformer::test_restricted_with_sanctioned_disjoint_values PASSED
test_transformers.py::TestEnterpriseTransformer::test_simple_enterprise_property PASSED
test_transformers.py::TestParamNormalizerTransformer::test_normalize_restriction_at_position_0 PASSED
test_transformers.py::TestParamNormalizerTransformer::test_normalize_restriction_at_position_1 PASSED
test_transformers.py::TestParamNormalizerTransformer::test_skip_normalization_for_literals PASSED
test_transformers.py::TestTypeTransformer::test_extract_type_from_one_or_many PASSED
test_transformers.py::TestTypeTransformer::test_extract_type_from_property_declaration PASSED
test_transformers.py::TestTypeTransformer::test_extract_type_from_vector PASSED
test_transformers.py::TestTypeTransformer::test_map_cpp_type_to_json_schema PASSED
test_transformers.py::TestBasicInfoTransformer::test_extract_name_and_description PASSED
test_transformers.py::TestBasicInfoTransformer::test_normalize_file_path PASSED
test_transformers.py::TestBasicInfoTransformer::test_skip_lambda_validators PASSED
test_transformers.py::TestEnumPatternMatching::test_enum_pattern_does_not_match_constructors PASSED
test_transformers.py::TestEnumPatternMatching::test_enum_pattern_matches_qualified_identifier PASSED
test_transformers.py::TestIntegration::test_enterprise_property_full_pipeline PASSED
test_transformers.py::TestIntegration::test_standard_property_full_pipeline PASSED

============================== 19 passed in 0.13s ==============================
```

## Bug Fix: is_validator_param

During test development, we discovered a bug in the `is_validator_param` function (transformers.py:349). The function was incorrectly classifying string literals as validators because they don't contain `{`, `,`, or `}` characters.

**Fix Applied:**
Added an early return to explicitly exclude string_literal and lambda_expression types:

```python
# String literals and lambda expressions are never validators
if typ in ("string_literal", "lambda_expression"):
    return False
```

This fix ensures that property names (which are string literals) are correctly processed by BasicInfoTransformer.

## Key Test Cases

### Enterprise Property Classification

The most important test validates the fix for `enable_schema_id_validation` enterprise property classification:

```python
def test_restricted_only_with_enum_vector(self):
    """
    Test that properties with restricted values + enum definition are classified as restricted_only.

    Example: enable_schema_id_validation has:
    - First vector: ['compat', 'redpanda'] (restricted, enterprise-only)
    - Last vector: ['none', 'redpanda', 'compat'] (enum definition, superset of first)

    Expected: restricted_only (not restricted_with_sanctioned)
    """
```

This test ensures that when the last vector parameter is a superset of the first (indicating it's the enum definition), the property is classified as `restricted_only` rather than `restricted_with_sanctioned`.

## Future Enhancements

1. **Integration Tests**: Add end-to-end tests that process actual C++ source files
2. **Default Value Tests**: Add tests for complex default value expansion
3. **Edge Case Coverage**: Add tests for malformed or unusual property declarations
4. **Performance Tests**: Add tests to measure extraction performance on large codebases
