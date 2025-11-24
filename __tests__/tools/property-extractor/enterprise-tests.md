# Enterprise Property Tests

This document describes the comprehensive test suite for enterprise property detection in `test_enterprise_properties.py`.

## Overview

The test suite validates that the `EnterpriseTransformer` correctly identifies and processes all three types of enterprise properties:

1. **restricted_with_sanctioned**: Properties with both Enterprise (restricted) and Community (sanctioned) values
2. **restricted_only**: Properties with only Enterprise (restricted) values
3. **simple**: Simple enterprise validation without specific value restrictions

## Test Coverage (35 tests)

### RestrictedWithSanctionedTest (9 tests)

Tests for properties that have both Enterprise and Community values. These properties should:
- Default to the **Enterprise (restricted)** value
- Have both `enterprise_restricted_value` and `enterprise_sanctioned_value` fields

**Specific tests:**
- `test_exactly_two_restricted_with_sanctioned_properties`: Verifies only 2 properties are classified this way
- `test_core_balancing_continuous_*`: 4 tests for core_balancing_continuous
  - Classification as restricted_with_sanctioned
  - Restricted value is `["true"]`
  - Sanctioned value is `["false"]`
  - **Default is `true` (Enterprise value)**
- `test_partition_autobalancing_mode_*`: 4 tests for partition_autobalancing_mode
  - Classification as restricted_with_sanctioned
  - Restricted value is `["continuous"]`
  - Sanctioned values are `["off", "node_add"]`
  - **Default is `"continuous"` (Enterprise value)**

### RestrictedOnlyTest (11 tests)

Tests for properties that have only Enterprise values. These properties should:
- Default to the **Community value** (not in restricted values)
- Have `enterprise_restricted_value` but NO `enterprise_sanctioned_value`

**Specific tests:**
- `test_restricted_only_properties_exist`: At least 3 such properties exist
- `test_enable_schema_id_validation_*`: 4 tests
  - Classification as restricted_only
  - Restricted values are `["compat", "redpanda"]`
  - Default is `"none"` (Community value)
  - No sanctioned value field
- `test_http_authentication_*`: 3 tests
  - Classification as restricted_only (not restricted_with_sanctioned)
  - Restricted value is `["OIDC"]`
  - Default is `["BASIC"]` (Community value)
- `test_sasl_mechanisms_*`: 3 tests
  - Classification as restricted_only
  - Restricted values are `["GSSAPI", "OAUTHBEARER"]`
  - Default is `["SCRAM"]` (Community value)

### SimpleEnterpriseTest (3 tests)

Tests for simple enterprise properties without value restrictions:
- `test_simple_enterprise_properties_exist`: At least 1 such property exists
- `test_default_leaders_preference_classification`: Example property is classified as "simple"
- `test_simple_properties_have_no_restricted_values`: No restricted/sanctioned value fields

### EnterpriseDefaultDescriptionTest (4 tests)

Tests that NO properties have the removed `enterprise_default_description` field:
- `test_no_enterprise_default_description_in_restricted_with_sanctioned`
- `test_no_enterprise_default_description_in_restricted_only`
- `test_no_enterprise_default_description_in_simple`
- `test_no_enterprise_default_description_anywhere`: Comprehensive check across all properties

### EnterpriseValueConsistencyTest (4 tests)

Tests for logical consistency between values and defaults:
- `test_restricted_with_sanctioned_default_matches_restricted`: Default is in restricted values
- `test_restricted_only_default_not_in_restricted`: Default is NOT in restricted values
- `test_restricted_with_sanctioned_have_both_values`: Both restricted and sanctioned exist
- `test_restricted_only_have_only_restricted_values`: Only restricted exists, no sanctioned

### RegressionTest (4 tests)

Tests for specific bugs that were fixed during development:

1. **`test_http_authentication_not_restricted_with_sanctioned`**
   - **Bug**: http_authentication was incorrectly classified as restricted_with_sanctioned
   - **Cause**: Pattern detection checked params[4] vs params[0], incorrectly matching due to validator param
   - **Fix**: Use property name position and check specific properties by name

2. **`test_only_two_restricted_with_sanctioned_not_six`**
   - **Bug**: 6 properties detected as restricted_with_sanctioned instead of 2
   - **Cause**: Generic pattern matching (params[4] != params[0]) caught too many
   - **Fix**: Property-name-based detection for the two specific properties

3. **`test_core_balancing_continuous_default_not_dict`**
   - **Bug**: Default was overwritten to dict like `{'needs_restart': 'needs_restart::no', ...}`
   - **Cause**: SimpleDefaultValuesTransformer and FriendlyDefaultTransformer overwriting Enterprise default
   - **Fix**: Added skip conditions in those transformers for restricted_with_sanctioned

4. **`test_partition_autobalancing_mode_default_not_node_add`**
   - **Bug**: Default was 'node_add' (Community) instead of 'continuous' (Enterprise)
   - **Cause**: EnterpriseTransformer wasn't setting default, downstream transformers used C++ default
   - **Fix**: EnterpriseTransformer explicitly sets property["default"] to restricted value

## Running the Tests

```bash
# Run only enterprise property tests
python -m pytest tests/test_enterprise_properties.py -v

# Run all tests
python -m pytest tests/ -v
```

## Expected Results

All tests validate against `gen/dev-properties.json`. The current expected state:

- **2 restricted_with_sanctioned properties**:
  - `core_balancing_continuous`: restricted=[true], sanctioned=[false], default=true
  - `partition_autobalancing_mode`: restricted=[continuous], sanctioned=[off, node_add], default=continuous

- **3 restricted_only properties**:
  - `enable_schema_id_validation`: restricted=[compat, redpanda], default=none
  - `http_authentication`: restricted=[OIDC], default=[BASIC]
  - `sasl_mechanisms`: restricted=[GSSAPI, OAUTHBEARER], default=[SCRAM]

- **1+ simple properties**:
  - `default_leaders_preference`: no restricted/sanctioned values

- **0 properties with `enterprise_default_description` field**

## Maintenance

When modifying enterprise property detection logic:
1. Run these tests first to establish baseline
2. Make your changes
3. Run tests again - all should still pass
4. If tests fail, either:
   - Fix the code to match expected behavior, OR
   - Update tests if requirements changed (document why)

## Key Implementation Details

The tests verify several critical aspects of the transformer pipeline:

1. **EnterpriseTransformer runs FIRST** in the pipeline
2. **For restricted_with_sanctioned**: Default is set to restricted (Enterprise) value
3. **For restricted_only**: Default comes from C++ source (Community value)
4. **Downstream transformers skip restricted_with_sanctioned**: Prevents default overwriting
5. **Property name position matters**: Tree-sitter always captures property name at params[1]
