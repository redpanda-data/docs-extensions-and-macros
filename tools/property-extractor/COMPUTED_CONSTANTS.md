# Computed C++ Constants Resolution

## Overview

Some C++ constants in Redpanda are defined with complex compile-time expressions that cannot be easily parsed by the property-extractor. These constants need to be pre-computed and mapped to their actual values.

## Problem Statement

Properties like `log_message_timestamp_before_max_ms` use constants like `max_serializable_ms` as their default values. These constants are defined with complex expressions:

```cpp
// From src/v/serde/rw/chrono.h:20
inline constexpr auto max_serializable_ms
  = std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::nanoseconds::max());
```

Without resolution, the extracted schema would show:
```json
{
  "log_message_timestamp_before_max_ms": {
    "default": "max_serializable_ms"  // ❌ String instead of numeric value
  }
}
```

## Solution

### 1. COMPUTED_CONSTANTS Dictionary

Added a dictionary in `transformers.py` that maps constant names to their computed values:

```python
COMPUTED_CONSTANTS = {
    # From src/v/serde/rw/chrono.h:20
    # inline constexpr auto max_serializable_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::nanoseconds::max());
    # Calculation: std::numeric_limits<int64_t>::max() / 1,000,000 = 9223372036854775807 / 1000000 = 9223372036854 ms
    "max_serializable_ms": 9223372036854,  # ~292 years in milliseconds
}
```

### 2. FriendlyDefaultTransformer Enhancement

Updated the `FriendlyDefaultTransformer` to check the `COMPUTED_CONSTANTS` dictionary before falling back to string normalization:

```python
# ------------------------------------------------------------------
# Computed C++ constants (max_serializable_ms, etc.)
# ------------------------------------------------------------------
if d in COMPUTED_CONSTANTS:
    property["default"] = COMPUTED_CONSTANTS[d]
    return property
```

### 3. Test Coverage

Added comprehensive test in `tests/test_known_values.py`:

```python
def test_max_serializable_ms_constant_resolution(self):
    """Test that max_serializable_ms constant is resolved to actual numeric value"""
    info = create_complete_property_info(
        name="log_message_timestamp_before_max_ms",
        description="Maximum timestamp difference for record validation",
        declaration="property<std::chrono::milliseconds> log_message_timestamp_before_max_ms;",
        metadata="meta{.needs_restart = needs_restart::no, .visibility = visibility::user}",
        default_value="max_serializable_ms"
    )

    property = apply_transformer_pipeline(info)

    self.assertEqual(property["name"], "log_message_timestamp_before_max_ms")
    self.assertEqual(property["type"], "integer")
    # max_serializable_ms = std::numeric_limits<int64_t>::max() / 1,000,000 = 9223372036854 ms
    self.assertEqual(property["default"], 9223372036854)
    self.assertFalse(property["needs_restart"])
    self.assertEqual(property["visibility"], "user")
```

## Calculation Details

### max_serializable_ms

**Definition Location:** `src/v/serde/rw/chrono.h:20`

**C++ Expression:**
```cpp
std::chrono::duration_cast<std::chrono::milliseconds>(
  std::chrono::nanoseconds::max()
)
```

**Calculation:**
1. `std::chrono::nanoseconds::max()` = `std::numeric_limits<int64_t>::max()` = `9223372036854775807` nanoseconds
2. Convert to milliseconds (truncating division): `9223372036854775807 / 1000000` = `9223372036854` milliseconds
3. This is approximately **292.47 years**

**Verification:**
```python
import sys

# std::chrono::nanoseconds uses int64_t for rep
max_int64 = 9223372036854775807

# Convert nanoseconds to milliseconds (duration_cast truncates)
max_ms = max_int64 // 1000000

print(f'max_serializable_ms = {max_ms} ms')
print(f'Which is approximately {max_ms / (1000 * 60 * 60 * 24 * 365):.2f} years')
```

Output:
```
max_serializable_ms = 9223372036854 ms
Which is approximately 292.47 years
```

## Result

After the fix, the extracted schema correctly shows:
```json
{
  "log_message_timestamp_before_max_ms": {
    "default": 9223372036854,  // ✅ Correct numeric value
    "type": "integer"
  }
}
```

## Adding New Computed Constants

To add support for new computed constants:

1. **Find the definition** in the Redpanda source code
2. **Compute the value** - either manually or with a Python/C++ test
3. **Add to COMPUTED_CONSTANTS** dictionary in `transformers.py`:
   ```python
   COMPUTED_CONSTANTS = {
       "existing_constant": 12345,
       "new_constant_name": computed_value,  # Add comment with source location
   }
   ```
4. **Add a test** in `tests/test_known_values.py` to verify resolution
5. **Document the calculation** with comments including:
   - Source file location
   - C++ expression
   - Calculation steps
   - Human-readable interpretation

## Test Coverage

All 53 tests pass, including the new test for `max_serializable_ms` resolution:

```bash
cd tools/property-extractor
python -m pytest tests/ -v --tb=short
# ================================================= 53 passed =================================================
```

## Benefits

✅ **Accurate defaults** - Properties show actual numeric values instead of symbolic names
✅ **Type safety** - Numeric properties have numeric defaults, not strings
✅ **Documentation quality** - Users see real values they can use
✅ **Maintainability** - Centralized mapping makes updates easy
✅ **Test coverage** - Ensures constants resolve correctly

## Related Files

- `tools/property-extractor/transformers.py` - COMPUTED_CONSTANTS dictionary and resolution logic
- `tools/property-extractor/tests/test_known_values.py` - Test for constant resolution
- `src/v/serde/rw/chrono.h` - Source definition of max_serializable_ms
- `tools/property-extractor/CI_INTEGRATION.md` - Updated test count documentation
