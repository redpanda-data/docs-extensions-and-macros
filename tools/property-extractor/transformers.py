#!/usr/bin/env python3
"""
Redpanda Property Transformers - Configuration Property Processing Pipeline

This module contains a comprehensive set of transformers that process C++ configuration property
declarations extracted from Redpanda's source code and convert them into structured JSON schema
definitions suitable for documentation generation.

================================================================================
OVERVIEW & ARCHITECTURE
================================================================================

The transformation pipeline converts raw C++ property declarations into standardized JSON objects
that can be consumed by documentation generators, validation systems, and other downstream tools.

TRANSFORMATION PIPELINE FLOW:
1. Tree-sitter parses C++ source → Raw AST nodes
2. Parser extracts property declarations → Structured info dicts  
3. Transformers process info dicts → Normalized PropertyBag objects
4. PropertyBags serialized → Final JSON schema output

INPUT FORMAT (from parser):
- info["declaration"]: Full C++ type declaration
- info["params"]: List of parsed constructor parameters
- info["name_in_file"]: C++ variable name
- info["type"]: Property template type (e.g., "property", "enterprise_property")

OUTPUT FORMAT (PropertyBag):
- Complete JSON schema-compatible property definition
- Normalized types, defaults, bounds, metadata
- Ready for handlebars template consumption

================================================================================
TRANSFORMER EXECUTION ORDER & DEPENDENCIES
================================================================================

Transformers are applied in a specific order to ensure dependencies are resolved correctly:

1. ParamNormalizerTransformer    - Standardizes parameter ordering for enterprise properties
2. BasicInfoTransformer          - Extracts basic name, description, file location
3. MetaParamTransformer         - Parses C++ meta{} initializers into structured data
4. NeedsRestartTransformer      - Extracts restart requirements from meta
5. GetsRestoredTransformer      - Extracts backup/restore flags from meta  
6. IsSecretTransformer          - Identifies secret/sensitive properties from meta
7. VisibilityTransformer        - Determines property visibility (user/tunable/deprecated) from meta
8. IsNullableTransformer        - Determines if property can be null/unset
9. IsArrayTransformer           - Identifies array types (std::vector, one_or_many_property)
10. TypeTransformer             - Maps C++ types to JSON Schema types
11. DeprecatedTransformer       - Marks deprecated properties from meta
12. NumericBoundsTransformer    - Calculates min/max bounds for integer types
13. DurationBoundsTransformer   - Calculates bounds for std::chrono duration types
14. SimpleDefaultValuesTransformer - Extracts simple default values
15. FriendlyDefaultTransformer  - Converts C++ defaults to human-readable format
16. ExperimentalTransformer     - Marks experimental features from meta
17. AliasTransformer           - Extracts property aliases from meta
18. EnterpriseTransformer      - Handles enterprise-only feature restrictions

================================================================================
KEY CONCEPTS & DATA STRUCTURES
================================================================================

PROPERTY TYPES HANDLED:
- property<T>                   - Standard Redpanda config property
- enterprise_property<T>        - Enterprise edition only property
- deprecated_property<T>        - Deprecated property (generates warnings)
- one_or_many_property<T>      - Accepts single value OR array of values

SPECIAL C++ PATTERNS PROCESSED:
- std::optional<T>             - Nullable properties
- std::vector<T>               - Array properties
- std::chrono::duration types  - Time duration properties with bounds
- Integer types (int32_t, etc.) - Numeric properties with automatic bounds
- meta{.key = value, ...}      - Redpanda metadata initializers

================================================================================
PROPERTY ARITIES - UNDERSTANDING CONSTRUCTOR PARAMETER PATTERNS
================================================================================

Redpanda configuration properties are C++ objects with constructor signatures that vary
based on feature requirements. Understanding these "arities" (parameter counts) is crucial
for correctly extracting property metadata.

BASIC PROPERTY PATTERNS:
┌─────────────────────────────────────────────────────────────────────────────
│ 2-PARAMETER: property<T>(name, description)
│ Example: property<bool>(*this, "enable_feature", "Enable the feature")
│ Used for: Simple properties with no metadata or custom defaults
│ Extraction: [0] = name, [1] = description
└─────────────────────────────────────────────────────────────────────────────
┌─────────────────────────────────────────────────────────────────────────────
│ 3-PARAMETER: property<T>(name, description, default)
│ Example: property<int>(*this, "port", "Server port", 9092)
│ Used for: Properties with simple custom default values
│ Extraction: [0] = name, [1] = description, [2] = default
└─────────────────────────────────────────────────────────────────────────────
┌─────────────────────────────────────────────────────────────────────────────
│ 4-PARAMETER: property<T>(name, description, meta, default)
│ Example: property<bool>(*this, "flag", "Description", meta{.needs_restart=yes}, true)
│ Used for: Properties with metadata (restart requirements, visibility, etc.)
│ Extraction: [0] = name, [1] = description, [2] = meta{}, [3] = default
└─────────────────────────────────────────────────────────────────────────────

ENTERPRISE PROPERTY PATTERNS (More Complex):
┌─────────────────────────────────────────────────────────────────────────────
│ 3-PARAMETER ENTERPRISE: enterprise_property<T>(name, description, default)
│ Example: enterprise_property<bool>(*this, "audit_enabled", "Enable auditing", false)
│ Used for: Enterprise features with simple restriction (all enterprise values)
│ Extraction: [0] = name, [1] = description, [2] = default
│ Note: No explicit restriction vector means "any enterprise value"
└─────────────────────────────────────────────────────────────────────────────
┌─────────────────────────────────────────────────────────────────────────────
│ 4-PARAMETER ENTERPRISE: enterprise_property<T>(name, description, meta, default)
│ Example: enterprise_property<int>(*this, "limit", "Limit", meta{.secret=yes}, 100)
│ Used for: Enterprise features with metadata but no specific value restrictions
│ Extraction: [0] = name, [1] = description, [2] = meta{}, [3] = default
└─────────────────────────────────────────────────────────────────────────────
┌─────────────────────────────────────────────────────────────────────────────
│ 5-PARAMETER ENTERPRISE WITH RESTRICTIONS:
│ Pattern A: enterprise_property<T>(restrictions, name, description, meta, default)
│ Pattern B: enterprise_property<T>(name, restrictions, description, meta, default)
│
│ Example A: enterprise_property<string>(
│              std::vector<ss::sstring>{"value1", "value2"},
│              *this, "feature_mode", "Operating mode", meta{}, "value1"
│            )
│
│ Example B: enterprise_property<string>(
│              *this, "feature_mode",
│              std::vector<ss::sstring>{"value1", "value2"},
│              "Operating mode", meta{}, "value1"
│            )
│
│ Used for: Enterprise features with specific allowed values per license tier
│ Extraction: ParamNormalizerTransformer detects and skips restriction vectors
│            After normalization: [0] = name, [1] = description, [2] = meta{}, [3] = default
│
│ Detection: Check for "std::vector" in params[0] or params[1] value string
│ Processing: EnterpriseTransformer extracts restriction vector to populate enterprise_value
└─────────────────────────────────────────────────────────────────────────────

PARAMETER POSITION VARIATIONS - WHY NORMALIZATION IS NEEDED:
The same semantic information appears at different parameter indices depending on:
1. Whether property is standard vs enterprise (affects parameter count)
2. Whether enterprise restrictions are present (shifts all subsequent parameters)
3. Whether metadata is included (adds meta{} parameter)
4. Constructor pattern evolution (C++ codebase changes over time)

EXAMPLE OF POSITION VARIATION:
┌─────────────────────────────────────────────────────────────────────────────
│ Standard property:          params[0]=name, params[1]=desc, params[2]=meta, params[3]=default
│ Enterprise (no restrict):   params[0]=name, params[1]=desc, params[2]=meta, params[3]=default
│ Enterprise (restrict@0):    params[0]=RESTRICTIONS, params[1]=name, params[2]=desc, params[3]=meta, params[4]=default
│ Enterprise (restrict@1):    params[0]=name, params[1]=RESTRICTIONS, params[2]=desc, params[3]=meta, params[4]=default
│
│ Solution: ParamNormalizerTransformer shifts params to create consistent layout
│           After normalization, ALL properties have: [0]=name, [1]=desc, [2]=meta, [3]=default
└─────────────────────────────────────────────────────────────────────────────

VALIDATORS AND SKIPPED PARAMETERS:
Some properties include validator lambdas or callable parameters that must be skipped:
┌─────────────────────────────────────────────────────────────────────────────
│ property<T>([](const T& v) { return v > 0; }, name, description, default)
│             └──────────────────────────────┘
│                  Lambda validator
│
│ BasicInfoTransformer skips these to find the first string literal (the name)
│ Detection: params with type "lambda_expression" or validator-like structure
└─────────────────────────────────────────────────────────────────────────────

HOW TO ADD SUPPORT FOR NEW PARAMETER PATTERNS:
1. Identify the parameter count and positions of name/description/meta/default
2. Update ParamNormalizerTransformer if new enterprise patterns are added
3. Update BasicInfoTransformer if name/description extraction needs adjustment
4. Update EnterpriseTransformer if new restriction patterns are introduced
5. Test with properties following the new pattern to verify extraction
6. Document the new pattern in this section for future maintainers

DOWNSTREAM CONSUMPTION:
The transformed PropertyBag objects are consumed by:
- generate-handlebars-docs.js   - Documentation generation
- property_extractor.py        - Final JSON schema assembly

================================================================================
DEBUGGING & MAINTENANCE
================================================================================

DEBUG SYSTEM:
- @debug_transformer decorator logs before/after state for each transformer
- DEBUG_TRANSFORMERS flag enables/disables debugging globally  
- DEBUG_FILTER narrows logging to specific property names
- Full parameter and property state logged for troubleshooting

ADDING NEW TRANSFORMERS:
1. Inherit from transformer pattern (accepts() + parse() methods)
2. Add @debug_transformer decorator for debugging support
3. Insert in proper execution order in main pipeline
4. Document expected inputs/outputs and downstream dependencies
5. Add comprehensive docstrings following this module's patterns

MAINTENANCE NOTES:
- Transformers depend on Tree-sitter AST structure - changes to parser may require updates
- C++ code patterns change over time - watch for new constructor patterns
- JSON Schema evolution may require type mapping updates
- Enterprise feature detection logic may need updates for new licensing models

================================================================================
"""

import re
import logging
from property_bag import PropertyBag
from parser import normalize_string
import pprint

# Compiled regex patterns for performance optimization
DOT_ASSIGNMENT_PATTERN = re.compile(r"\.([A-Za-z_]+)\s*=\s*([A-Za-z0-9_:]+)")
NAMESPACE_STRIP_PATTERN = re.compile(r"^.*::")
NUMERIC_PATTERN = re.compile(r"^-?\d+(\.\d+)?$")
PROPERTY_TEMPLATE_PATTERN = re.compile(r"^.*property<(.+)>.*")
OPTIONAL_TEMPLATE_PATTERN = re.compile(r".*std::optional<(.+)>.*")
VECTOR_TEMPLATE_PATTERN = re.compile(r".*std::vector<(.+)>.*")
ONE_OR_MANY_PATTERN = re.compile(r".*one_or_many_property<(.+)>.*")
DEPRECATED_PROPERTY_PATTERN = re.compile(r".*deprecated_property<(.+)>.*")
NUMERIC_TYPE_PATTERN = re.compile(r"^(unsigned|u?int(8|16|32|64)?(_t)?)")
CHRONO_DECLARATION_PATTERN = re.compile(r"std::chrono::")
LEGACY_DEFAULT_PATTERN = re.compile(r"legacy_default<[^>]+>\(([^,]+)")
BRACED_CONTENT_PATTERN = re.compile(r"^\{.*\}$")
BRACED_EXTRACT_PATTERN = re.compile(r"^\{(.*)\}$")
FLOAT_PATTERN = re.compile(r"^-?\d+\.\d+$")
INT_PATTERN = re.compile(r"^-?\d+$")
SIZE_SUFFIX_PATTERN = re.compile(r"(\d+)_([KMGTP])iB")

# Computed C++ constant definitions that require evaluation
# These are constants defined with complex expressions that can't be easily parsed
# Values are computed from the C++ definitions
COMPUTED_CONSTANTS = {
    # From src/v/serde/rw/chrono.h:20
    # inline constexpr auto max_serializable_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::nanoseconds::max());
    # Calculation: std::numeric_limits<int64_t>::max() / 1,000,000 = 9223372036854775807 / 1000000 = 9223372036854 ms
    "max_serializable_ms": 9223372036854,  # ~292 years in milliseconds
    "serde::max_serializable_ms": 9223372036854,  # Namespace-qualified version
}

# Debug configuration - useful for development and troubleshooting
DEBUG_TRANSFORMERS = False  # Master switch for transformer debugging
DEBUG_FILTER = None                               # Filter to specific property name (or None for all)

def debug_transformer(cls):
    """
    Decorator that wraps transformer parse() methods to provide detailed debugging information.
    
    This decorator is essential for debugging the transformation pipeline. It logs the complete
    state of parameters and properties before and after each transformer executes, making it
    easy to trace how properties are being processed and identify issues.
    
    DEBUGGING OUTPUT INCLUDES:
    - Transformer class name being executed
    - Property name being processed  
    - Full parameter list before transformation
    - Full parameter list after transformation
    - Updated property keys after transformation
    - Error details if transformation fails
    
    USAGE:
    Apply @debug_transformer decorator to any transformer class:
    
    @debug_transformer  
    class MyTransformer:
        def accepts(self, info, file_pair): ...
        def parse(self, property, info, file_pair): ...
    
    FILTERING:
    Use DEBUG_FILTER to narrow logging to specific properties:
    DEBUG_FILTER = "kafka_api"  # Only log kafka_api property transformations
    DEBUG_FILTER = None         # Log all property transformations
    
    Args:
        cls: The transformer class to wrap with debugging capabilities
        
    Returns:
        The wrapped transformer class with debug logging in parse() method
    """
    orig_parse = cls.parse

    def wrapped_parse(self, property, info, file_pair):
        if not DEBUG_TRANSFORMERS:
            return orig_parse(self, property, info, file_pair)

        name = property.get("name") or info.get("name_in_file") or "?"
        if DEBUG_FILTER and DEBUG_FILTER not in str(name):
            return orig_parse(self, property, info, file_pair)

        print("\n" + "=" * 80)
        print(f"🔍 Transformer: {cls.__name__}")
        print(f"Property: {name}")
        print(f"Params BEFORE ({len(info.get('params', []))}):")
        pprint.pp(info.get("params", []))

        try:
            result = orig_parse(self, property, info, file_pair)
        except Exception as e:
            print(f"❌ ERROR in {cls.__name__}: {e}")
            raise

        print(f"Params AFTER ({len(info.get('params', []))}):")
        pprint.pp(info.get("params", []))
        print(f"Updated property keys: {list(property.keys())}")
        print("=" * 80 + "\n")

        return result

    cls.parse = wrapped_parse
    return cls


# Get logger for this module
logger = logging.getLogger(__name__)

# Import the process_enterprise_value function from property_extractor
# Note: We import at function level to avoid circular imports since property_extractor
# imports transformers.py. This pattern allows the EnterpriseTransformer to access
# the centralized enterprise value processing logic without creating import cycles.
def get_process_enterprise_value():
    """
    Lazily import the centralized enterprise value processing function to avoid circular imports.
    
    The property_extractor module imports transformers.py, so we cannot import property_extractor
    at module level. This lazy loading pattern allows EnterpriseTransformer to access the
    centralized enterprise value processing logic without creating circular dependencies.
    
    ENTERPRISE VALUE PROCESSING:
    The process_enterprise_value function converts enterprise-specific C++ expressions into
    JSON-compatible values for restricted feature handling. Examples include:
    - Converting enterprise feature flags to boolean values
    - Processing enterprise license restriction lists
    - Normalizing enterprise property default values
    
    CIRCULAR IMPORT AVOIDANCE:
    - property_extractor.py imports transformers.py (needs transformer classes)
    - transformers.py needs process_enterprise_value from property_extractor.py  
    - Solution: Lazy import at function call time, not at module import time
    
    Returns:
        callable or None: The process_enterprise_value function if successfully imported,
                         None if import fails (with error logged)
                         
    Raises:
        Does not raise - logs ImportError and returns None on failure
    """
    try:
        from property_extractor import process_enterprise_value
        return process_enterprise_value
    except ImportError as e:
        logger.error("Cannot import process_enterprise_value from property_extractor: %s", e)
        return None


def is_validator_param(p):
    """
    Determine if a parameter represents a validator function or callable.

    Redpanda properties often include validator functions to ensure configuration values
    are valid. These validators are C++ callables that are not relevant for documentation
    but need to be identified and filtered out during parameter processing.

    VALIDATOR DETECTION CRITERIA:
    1. Contains validator-related keywords ("validator", "validate_", "checker")
    2. Has type indicating it's a function identifier ("qualified_identifier", "unresolved_identifier")
    3. Appears to be a simple identifier without complex syntax (no braces/commas)

    EXAMPLES OF VALIDATOR PARAMETERS:
    - validate_memory_size       (function name)
    - config::memory_validator   (qualified validator)
    - cluster_size_checker       (validation callable)

    NON-VALIDATOR PARAMETERS:
    - {.needs_restart = no}      (meta initializer)
    - "default_value"            (string literal)
    - 42                         (numeric literal)

    Args:
        p (dict): Parameter dictionary with 'value' and 'type' keys

    Returns:
        bool: True if parameter appears to be a validator function, False otherwise
    """
    if not isinstance(p, dict):
        return False
    val = str(p.get("value", "")).strip()
    typ = p.get("type", "")

    # String literals and lambda expressions are never validators
    if typ in ("string_literal", "lambda_expression"):
        return False

    # Check for validator-related keywords
    if any(x in val for x in ("validator", "validate_", "checker")):
        return True

    # Check for identifier types that typically represent functions
    if typ in ("qualified_identifier", "unresolved_identifier"):
        return True

    # Simple identifiers without complex syntax are often validators
    if not ("{" in val or "," in val or "}" in val):
        return True

    return False


def find_meta_dict(info):
    """
    Locate and extract Redpanda property metadata from C++ meta initializers.
    
    Redpanda uses a special C++ pattern for specifying property metadata through
    meta{} initializers. This function finds and parses these metadata blocks
    from the raw parameter data extracted by the Tree-sitter parser.
    
    SUPPORTED META SYNTAX PATTERNS:
    1. Explicit meta wrapper:
       meta{ .needs_restart = needs_restart::no, .visibility = visibility::user }
       
    2. Bare initializer (detected by presence of metadata keys):
       {.needs_restart = needs_restart::no, .visibility = visibility::tunable}
    
    METADATA KEYS RECOGNIZED:
    - needs_restart: Whether changing this property requires broker restart  
    - visibility: Property visibility level (user, tunable, deprecated)
    - deprecated: Deprecation status and reason
    - secret: Whether property contains sensitive data
    - experimental: Experimental feature flag
    - gets_restored: Whether property is included in backup/restore
    - example: Example values for documentation
    
    PROCESSING STATES:
    1. Raw string form: Before MetaParamTransformer processes initializers
    2. Parsed dict form: After MetaParamTransformer converts to structured data
    
    This function handles both states to support early metadata access before
    the full transformation pipeline completes.
    
    Args:
        info (dict): Property info dictionary containing 'params' list
        
    Returns:
        dict or None: Parsed metadata dictionary with normalized keys,
                     None if no metadata found
                     
    Examples:
        Raw input: "meta{ .visibility = visibility::user }"
        Output: {"visibility": "user"}
        
        Parsed input: {"needs_restart": "needs_restart::no", "type": "initializer_list"}  
        Output: {"needs_restart": "needs_restart::no"}
    """
    for p in info.get("params", []):
        val = p.get("value")

        # Case 1: Already parsed dict
        if isinstance(val, dict) and any(
            k in val for k in ("needs_restart", "visibility", "deprecated", "secret", "experimental")
        ):
            return val

        # Case 2: Raw string form (early lookup before MetaParamTransformer)
        if isinstance(val, str) and ("meta{" in val or val.strip().startswith("{")):
            # Minimal regex extraction for .key = value pairs
            matches = DOT_ASSIGNMENT_PATTERN.findall(val)
            if matches:
                return {k: v for k, v in matches}
    return None

def get_meta_value(info, key, default=None):
    """
    Extract and normalize a specific metadata value from property metadata.
    
    This is a convenience function that combines metadata discovery with value
    normalization. It handles the common pattern of extracting metadata values
    and stripping C++ namespace qualifiers to get clean, usable values.
    
    VALUE NORMALIZATION:
    C++ metadata often uses qualified identifiers like "needs_restart::no" or 
    "visibility::user". This function strips the namespace portion (everything
    before "::") to get the clean value ("no", "user").
    
    COMMON USAGE PATTERNS:
    - get_meta_value(info, "needs_restart", "no") → "no" or "yes"
    - get_meta_value(info, "visibility", "user") → "user", "tunable", "deprecated"
    - get_meta_value(info, "deprecated") → None or deprecation reason
    
    Args:
        info (dict): Property info dictionary to search for metadata
        key (str): Metadata key to extract (e.g., "needs_restart", "visibility")
        default (any): Default value if key not found or metadata missing
        
    Returns:
        any: Normalized metadata value with C++ qualifiers stripped,
             or default if key not found
             
    Examples:
        Input meta: {"needs_restart": "needs_restart::yes"}
        get_meta_value(info, "needs_restart") → "yes"
        
        Input meta: {"visibility": "visibility::tunable"}  
        get_meta_value(info, "visibility") → "tunable"
        
        Missing key:
        get_meta_value(info, "nonexistent", "default") → "default"
    """
    meta = find_meta_dict(info)
    if not meta or key not in meta:
        return default
    val = meta[key]
    # Strip C++ namespace qualifiers like "needs_restart::no" → "no"
    if isinstance(val, str):
        return NAMESPACE_STRIP_PATTERN.sub("", val)
    return val


def get_resolve_constexpr_identifier():
    """
    Lazily import constexpr identifier resolution function to avoid circular imports.
    
    This function provides access to the constexpr identifier resolution logic from
    property_extractor.py while avoiding circular import issues. The constexpr resolver
    looks up C++ constexpr variable definitions in source code to get their literal values.
    
    CONSTEXPR RESOLUTION PROCESS:
    1. C++ property defaults often reference constexpr variables by name
    2. The resolver searches Redpanda source files for constexpr definitions
    3. It extracts the literal value assigned to the constexpr variable  
    4. The literal value is used as the actual property default
    
    EXAMPLES OF CONSTEXPR RESOLUTION:
    - C++ default: "default_client_id" → Searches for: constexpr auto default_client_id = "redpanda";
    - Resolved to: "redpanda"
    
    - C++ default: "kafka_group_topic" → Searches for: constexpr string_view kafka_group_topic = "__consumer_offsets"; 
    - Resolved to: "__consumer_offsets"
    
    CIRCULAR IMPORT HANDLING:
    - property_extractor.py imports transformers.py for transformer classes
    - FriendlyDefaultTransformer needs resolve_constexpr_identifier from property_extractor.py
    - Solution: Lazy import at call time prevents circular dependency
    
    Returns:
        callable or None: The resolve_constexpr_identifier function if import succeeds,
                         None if import fails (with exception logged)
                         
    Raises:
        Does not raise - logs exceptions and returns None on import failure
    """
    try:
        from property_extractor import resolve_constexpr_identifier
        return resolve_constexpr_identifier
    except ImportError as e:
        logger.exception("Cannot import resolve_constexpr_identifier from property_extractor: %s", e)
        return None

@debug_transformer
class BasicInfoTransformer:
    """
    Extract fundamental property information: name, description, and source file location.
    
    This is typically the first transformer in the pipeline and establishes the basic
    property identity that other transformers build upon. It handles the core property
    metadata that appears in virtually all property declarations.
    
    PROCESSING RESPONSIBILITIES:
    1. Property name resolution with robust fallback logic
    2. Source file path normalization  
    3. Description extraction from constructor parameters
    
    NAME RESOLUTION PRIORITY:
    1. Pre-existing property["name"] (from previous processing)
    2. info["name_in_file"] (C++ variable name from Tree-sitter)  
    3. First parameter value if it looks like an identifier
    
    DESCRIPTION EXTRACTION LOGIC:
    1. If first parameter is a string and differs from name → use as description
    2. Otherwise, try second parameter if it's a string
    3. Handles both quoted and unquoted string values
    
    SOURCE FILE NORMALIZATION:
    Converts absolute paths to relative paths starting with "src/" for consistent
    documentation references regardless of build environment.
    
    EXPECTED FINAL RESULT:
    {
        "name": "property_name",           # Clean identifier for JSON keys
        "description": "Human readable...", # Description for documentation  
        "defined_in": "src/v/config/..."   # Normalized file path
    }
    
    DOWNSTREAM USAGE:
    - generate-handlebars-docs.js uses "name" for property identification
    - Documentation templates use "description" for user-facing text
    - Source links use "defined_in" for GitHub integration
    """

    def accepts(self, info, file_pair):
        return True

    def parse(self, property, info, file_pair):
        params = info.get("params") or []
        if not params:
            return property

        # --- Step 1: find the "real" start of the property definition ---
        # Skip lambdas, validators, and non-string literals at the start
        start_idx = 0
        for i, p in enumerate(params):
            val = str(p.get("value", ""))
            typ = p.get("type", "")
            if is_validator_param(p):
                continue
            if typ in ("lambda_expression", "qualified_identifier", "unresolved_identifier"):
                continue
            if not (val.startswith('"') and val.endswith('"')):
                continue
            # First string literal we hit is the name
            start_idx = i
            break

        # --- Step 2: extract name and description robustly ---
        name = property.get("name") or info.get("name_in_file")
        if not name and len(params) > start_idx:
            name = params[start_idx].get("value", "").strip('"')
        property["name"] = name

        desc = None
        if len(params) > start_idx + 1:
            v0 = params[start_idx].get("value")
            v1 = params[start_idx + 1].get("value")
            if isinstance(v1, str) and len(v1) > 10 and " " in v1:
                desc = v1
            elif isinstance(v0, str) and len(v0) > 10 and " " in v0:
                desc = v0
        property["description"] = desc

        # --- Step 3: defined_in ---
        property["defined_in"] = re.sub(
            r"^.*src/", "src/", str(file_pair.implementation)
        )
        return property

@debug_transformer
class ParamNormalizerTransformer:
    """
    Normalize parameter ordering for enterprise properties to enable consistent downstream parsing.
    
    Enterprise properties in Redpanda have more complex constructor signatures than regular
    properties because they include license restriction information. This transformer
    standardizes the parameter ordering so other transformers can rely on predictable
    parameter positions.
    
    ENTERPRISE PROPERTY CONSTRUCTOR PATTERNS:
    1. enterprise_property<T>(restricted_values, name, description, meta, default)
    2. enterprise_property<T>(name, restricted_values, description, meta, default)  
    3. enterprise_property<T>(name, description, meta, default) [no restrictions]
    
    TARGET STANDARDIZED LAYOUT AFTER NORMALIZATION:
    [0] name         - Property identifier
    [1] description  - Human-readable description
    [2] meta         - Metadata initializer (meta{...})
    [3] default      - Default value
    
    NORMALIZATION LOGIC:
    1. Detect presence of std::vector restricted values parameter
    2. Shift parameter array to skip restriction parameters
    3. Result: consistent [name, description, meta, default] layout
    
    RESTRICTION PARAMETER DETECTION:
    Enterprise properties may have std::vector<T> parameters containing lists of 
    allowed values for license-restricted features. These parameters contain
    "std::vector" in their string representation and need to be skipped.
    
    SKIP CONDITIONS:
    - Properties starting with simple literals (true/false/numbers) are not normalized
    - These typically represent different constructor patterns that don't need adjustment
    
    EXPECTED FINAL RESULT:
    Consistent parameter ordering that allows other transformers to find:
    - params[0]: Property name
    - params[1]: Property description  
    - params[2]: Meta information
    - params[3]: Default value
    
    DOWNSTREAM DEPENDENCIES:
    - BasicInfoTransformer relies on predictable name/description positions
    - SimpleDefaultValuesTransformer expects defaults in consistent locations
    - EnterpriseTransformer needs to find restriction parameters
    """
    
    def accepts(self, info, file_pair):
        """
        Only process enterprise property declarations.
        
        Args:
            info (dict): Property declaration info with 'type' field
            file_pair (FilePair): Source file pair (unused)
            
        Returns:
            bool: True if this is an enterprise property needing normalization
        """
        return bool(info.get("type") and "enterprise" in info["type"])

    def parse(self, property, info, file_pair):
        """
        Normalize enterprise property parameter ordering by skipping restriction parameters.
        
        Args:
            property (PropertyBag): Property object (returned unchanged)
            info (dict): Property declaration info to normalize in-place
            file_pair (FilePair): Source file pair (unused)
            
        Returns:
            PropertyBag: Unchanged property object (normalization modifies info dict)
        """
        params = info.get("params", [])
        if not params:
            return property

        first_val = str(params[0].get("value", ""))
        second_val = str(params[1].get("value", "")) if len(params) > 1 else ""

        # Skip normalization for simple literal values - different constructor pattern
        if first_val in ("true", "false") or NUMERIC_PATTERN.match(first_val):
            return property

        # Pattern 1: Restriction vector in position 0
        # enterprise_property<T>(restricted_values, name, description, meta, default)
        if len(params) >= 4 and "std::vector" in first_val:
            info["params"] = params[1:]
            logger.debug("[ParamNormalizerTransformer] Shifted enterprise params by 1 (restrictions in pos 0)")

        # Pattern 2: Restriction vector in position 1  
        # enterprise_property<T>(name, restricted_values, description, meta, default)
        elif len(params) >= 5 and "std::vector" in second_val:
            info["params"] = params[2:]
            logger.debug("[ParamNormalizerTransformer] Shifted enterprise params by 2 (restrictions in pos 1)")

        return property


@debug_transformer
class IsNullableTransformer:
    """
    Determine if a property can have null/unset values based on C++ type and metadata.
    
    Nullability is a critical JSON schema property that affects validation and documentation.
    This transformer analyzes both the C++ type system and explicit metadata to determine
    if a property can be null or must always have a value.
    
    NULLABILITY DETECTION METHODS:
    1. Explicit "required" metadata in meta{} block (highest priority)
    2. std::optional<T> wrapper type detection (automatic nullability)
    3. Default assumption: non-nullable unless evidence suggests otherwise
    
    C++ OPTIONAL TYPE HANDLING:
    Properties declared as std::optional<T> are automatically nullable since the
    C++ optional type explicitly models the concept of "value or no value".
    
    EXPLICIT REQUIRED METADATA:
    Properties can specify required = required::yes/no in their meta block:
    meta{ .required = required::no }  → nullable = true
    meta{ .required = required::yes } → nullable = false
    
    DOWNSTREAM IMPACT:
    - JSON Schema validation: nullable=false properties cannot be null/undefined
    - Documentation: nullable properties show "optional" indicators  
    - Configuration validation: nullable properties allow omission from config files
    
    EXPECTED FINAL RESULT:
    {
        "nullable": true   # Property can be null/unset
    }
    OR
    {
        "nullable": false  # Property must have a value
    }
    
    USAGE IN GENERATED DOCS:
    - Nullable properties show "(optional)" in parameter lists
    - Non-nullable properties show validation requirements
    - Schema validators use nullable flag for validation rules
    """
    
    def accepts(self, info, file_pair):
        """
        Process all properties - nullability determination is universal.
        
        Returns:
            bool: Always True - all properties need nullability determination
        """
        return True

    def parse(self, property, info, file_pair):
        """
        Analyze property declaration to determine nullability.
        
        Args:
            property (PropertyBag): Property to set nullable flag on
            info (dict): Property declaration info with params and declaration
            file_pair (FilePair): Source file pair (unused)
            
        Returns:
            PropertyBag: Property with nullable field set
        """
        # Method 1: Check explicit "required" metadata (highest priority)
        if len(info["params"]) > 2 and "required" in info["params"][2]["value"]:
            is_required = (
                re.sub(r"^.*::", "", info["params"][2]["value"]["required"]) == "yes"
            )
            property["nullable"] = not is_required
            
        # Method 2: Detect std::optional<T> wrapper type  
        elif "std::optional" in info["declaration"]:
            property["nullable"] = True
            
        # Method 3: Default to non-nullable
        else:
            property["nullable"] = False

        return property

@debug_transformer
class IsArrayTransformer:
    """
    Detects properties that should be treated as arrays based on their C++ type declarations.
    
    This transformer identifies two types of array properties:
    1. std::vector<T> - Standard C++ vectors
    2. one_or_many_property<T> - Redpanda's custom type that accepts either a single value or an array
    
    The one_or_many_property type is used in Redpanda configuration for properties like 'admin' 
    and 'admin_api_tls' where users can specify either:
    - A single object: admin: {address: "127.0.0.1", port: 9644}
    - An array of objects: admin: [{address: "127.0.0.1", port: 9644}, {address: "0.0.0.0", port: 9645}]
    
    When detected, these properties are marked with:
    - type: "array"
    - items: {type: <inner_type>} where <inner_type> is extracted from T
    """
    
    # Class-level constants for array type patterns
    ARRAY_PATTERN_STD_VECTOR = "std::vector"
    ARRAY_PATTERN_ONE_OR_MANY = "one_or_many_property"
    
    def __init__(self, type_transformer):
        self.type_transformer = type_transformer

    def accepts(self, info, file_pair):
        """
        Check if this property declaration represents an array type.
        
        Returns True for:
        - std::vector<T> declarations (standard C++ vectors)
        - one_or_many_property<T> declarations (Redpanda's flexible array type)
        """
        return (self.ARRAY_PATTERN_STD_VECTOR in info["declaration"] or 
                self.ARRAY_PATTERN_ONE_OR_MANY in info["declaration"])

    def parse(self, property, info, file_pair):
        """
        Transform the property to indicate it's an array type.
        
        Sets:
        - property["type"] = "array"
        - property["items"]["type"] = <extracted_inner_type>
        
        The inner type is extracted by the type_transformer, which handles
        removing the wrapper (std::vector<> or one_or_many_property<>) to get T.
        """
        property["type"] = "array"
        property["items"] = PropertyBag()
        property["items"]["type"] = self.type_transformer.get_type_from_declaration(
            info["declaration"]
        )

@debug_transformer
class NeedsRestartTransformer:
    """
    Extract restart requirements from property metadata for operational documentation.
    
    This transformer identifies properties that require a broker restart when modified.
    Restart requirements are crucial operational information that must be prominently
    displayed in documentation to prevent accidental service disruptions.
    
    RESTART REQUIREMENT SOURCES:
    Properties specify restart needs via meta{} blocks:
    meta{ .needs_restart = needs_restart::yes }  → requires restart
    meta{ .needs_restart = needs_restart::no }   → live reconfiguration
    MISSING meta .needs_restart                  → defaults to requires restart (true)
    
    OPERATIONAL SIGNIFICANCE:
    - Properties requiring restart cannot be changed without downtime
    - Live-configurable properties allow zero-downtime configuration updates
    - Critical for production change management and deployment planning
    - Default to requiring restart for safety when metadata is missing
    
    EXPECTED FINAL RESULT:
    {
        "needs_restart": true   # Restart required for changes (default if missing)
    }
    OR
    {
        "needs_restart": false  # Live reconfiguration supported (explicitly set)
    }
    
    DOWNSTREAM USAGE:
    - Documentation shows restart warnings for affected properties
    - Configuration management tools use this for change validation
    - Operations teams use this for maintenance planning
    """
    
    def accepts(self, info, file_pair):
        """Process all properties - assign default restart requirement if missing."""
        return True

    def parse(self, property, info, file_pair):
        """Extract restart requirement, defaulting based on property type if not specified."""
        val = get_meta_value(info, "needs_restart")
        if val is None:
            # Check if this is a topic property
            is_topic_property = (
                property.get("is_topic_property", False) or 
                property.get("config_scope") == "topic"
            )
            
            if is_topic_property:
                # Topic properties default to not requiring restart
                property["needs_restart"] = False
            else:
                # Cluster and broker properties default to requiring restart for safety
                property["needs_restart"] = True
        else:
            property["needs_restart"] = (val != "no")
        return property

@debug_transformer
class GetsRestoredTransformer:
    """
    Extract backup/restore inclusion flags for disaster recovery documentation.
    
    This transformer identifies properties that are included in or excluded from
    Redpanda's backup and restore operations. This information is essential for
    disaster recovery planning and data migration procedures.
    
    RESTORATION METADATA PATTERNS:
    Properties can use either naming convention:
    meta{ .gets_restored = restored::yes }  → included in backups
    meta{ .restored = restored::no }        → excluded from backups
    
    BACKUP/RESTORE BEHAVIOR:
    - gets_restored = true: Property value saved in backups and restored
    - gets_restored = false: Property reset to default during restore
    
    TYPICAL EXCLUSIONS:
    - Temporary operational state (cache sizes, connection limits)
    - Environment-specific settings (hostnames, paths)
    - Credentials and secrets (handled separately for security)
    
    EXPECTED FINAL RESULT:
    {
        "gets_restored": true   # Included in backup/restore operations
    }
    OR
    {
        "gets_restored": false  # Excluded from backup/restore
    }
    
    DOWNSTREAM USAGE:
    - Disaster recovery documentation lists which settings persist
    - Backup tools use this for selective property restoration
    - Migration guides indicate what needs manual reconfiguration
    """
    
    def accepts(self, info, file_pair):
        """Process properties with backup/restore metadata."""
        return (get_meta_value(info, "gets_restored") is not None or 
                get_meta_value(info, "restored") is not None)

    def parse(self, property, info, file_pair):
        """Extract restoration flag from either naming convention."""
        val = get_meta_value(info, "gets_restored") or get_meta_value(info, "restored", "no")
        property["gets_restored"] = (val != "no")
        return property


@debug_transformer
class IsSecretTransformer:
    """
    Identify properties containing sensitive data for security documentation.
    
    This transformer marks properties that contain sensitive information such as
    passwords, API keys, certificates, or other confidential data. This enables
    appropriate security warnings and handling in documentation.
    
    SECRET DETECTION:
    Properties explicitly mark sensitive data:
    meta{ .secret = secret::yes }  → contains sensitive data
    meta{ .secret = secret::no }   → safe to display
    
    SECURITY IMPLICATIONS:
    - Secret properties should never appear in logs or debug output
    - Documentation must warn about secure storage requirements
    - Configuration examples use placeholder values
    - Backup/restore may require special handling
    
    EXPECTED FINAL RESULT:
    {
        "is_secret": true   # Contains sensitive data - handle with care
    }
    OR
    {
        "is_secret": false  # Safe to display (default)
    }
    
    DOWNSTREAM USAGE:
    - Documentation generators hide or mask secret property values
    - Configuration validators warn about insecure secret storage
    - Logging systems exclude secret properties from output
    """
    
    def accepts(self, info, file_pair):
        """Process properties with secret metadata."""
        return get_meta_value(info, "secret") is not None

    def parse(self, property, info, file_pair):
        """Extract and normalize secret flag."""
        val = get_meta_value(info, "secret", "no")
        property["is_secret"] = (val == "yes")
        return property


@debug_transformer
class VisibilityTransformer:
    """
    Classify property visibility levels for appropriate documentation targeting.
    
    This transformer categorizes properties by their intended audience and usage
    complexity. Visibility levels determine where properties appear in documentation
    and how prominently they are featured.
    
    VISIBILITY LEVELS:
    - user: End-user configurable properties (appear in user guides)
    - tunable: Advanced/performance tuning properties (expert documentation)
    - deprecated: Legacy properties (migration guides only)
    
    VISIBILITY METADATA:
    Properties specify their visibility:
    meta{ .visibility = visibility::user }     → user-facing documentation
    meta{ .visibility = visibility::tunable }  → advanced/tuning guides  
    meta{ .visibility = visibility::deprecated} → migration documentation only
    
    DOCUMENTATION IMPACT:
    - 'user' properties: Featured in getting-started and configuration guides
    - 'tunable' properties: Advanced sections, performance documentation
    - 'deprecated' properties: Migration guides with replacement information
    
    EXPECTED FINAL RESULT:
    {
        "visibility": "user"       # Primary user documentation
    }
    OR  
    {
        "visibility": "tunable"    # Advanced/expert documentation
    }
    OR
    {
        "visibility": "deprecated" # Migration documentation only
    }
    
    DOWNSTREAM USAGE:
    - generate-handlebars-docs.js filters properties by visibility
    - Documentation templates show user properties prominently
    - Advanced guides include tunable properties for optimization
    """
    
    def accepts(self, info, file_pair):
        """Process properties with visibility metadata."""
        return get_meta_value(info, "visibility") is not None

    def parse(self, property, info, file_pair):
        """Extract visibility level with user as default."""
        vis = get_meta_value(info, "visibility", "user")
        property["visibility"] = vis

        # Mark as deprecated if visibility is deprecated
        if vis == "deprecated":
            property["is_deprecated"] = True

        return property

@debug_transformer
class TypeTransformer:
    """
    Map C++ property types to JSON Schema types for documentation and validation.
    
    This is one of the most critical transformers in the pipeline. It bridges the gap
    between C++ type system and JSON Schema by analyzing complex C++ template 
    declarations and converting them to standardized JSON types that can be consumed
    by documentation generators and validation systems.
    
    TYPE MAPPING RESPONSIBILITIES:
    1. Parse complex nested C++ template declarations
    2. Extract inner types from wrappers (property<T>, std::optional<T>, etc.)
    3. Map C++ types to JSON Schema primitives (string, integer, boolean, object, array)
    4. Handle deprecated property type detection and mapping
    5. Support Redpanda-specific type patterns (one_or_many_property, enterprise types)
    
    C++ TO JSON SCHEMA TYPE MAPPINGS:
    - std::string, string_view           → "string"
    - int32_t, uint64_t, size_t         → "integer"  
    - bool                              → "boolean"
    - double, float                     → "number"
    - std::chrono::* durations          → "integer" (with bounds from DurationBoundsTransformer)
    - Custom model/config classes       → "object" (with $ref to definitions)
    - enum classes                      → "string" (with enum constraints)
    
    COMPLEX TYPE UNWRAPPING:
    Handles nested template patterns like:
    - property<std::vector<model::broker_endpoint>>           → array of objects
    - enterprise_property<std::optional<std::string>>        → nullable string
    - one_or_many_property<config::endpoint_tls_config>      → array of objects
    - deprecated_property<size_t>                           → deprecated integer
    
    TEMPLATE PARSING ALGORITHM:
    Uses sophisticated bracket counting to handle arbitrarily nested templates:
    1. Find template name position in declaration
    2. Track opening/closing angle brackets with proper nesting
    3. Extract content between matching brackets
    4. Recursively process nested templates
    
    EXPECTED FINAL RESULT:
    {
        "type": "string"           # JSON Schema primitive type
    }
    OR
    {
        "type": "object"           # Complex type referencing definitions
    }
    OR  
    {
        "type": "array",           # Array type with items specification
        "items": {"type": "object"}
    }
    
    DOWNSTREAM DEPENDENCIES:
    - IsArrayTransformer: Depends on type extraction for array item types
    - NumericBoundsTransformer: Uses C++ type info for bounds calculation
    - resolve_type_and_default(): Uses type info for default value processing
    - JSON Schema validators: Use type info for validation rules
    """
    
    # Class-level constants for type pattern matching
    # Shared with IsArrayTransformer for consistency
    ARRAY_PATTERN_STD_VECTOR = "std::vector"
    ARRAY_PATTERN_ONE_OR_MANY = "one_or_many_property" 
    OPTIONAL_PATTERN = "std::optional"
    
    def accepts(self, info, file_pair):
        """
        Process all properties - type mapping is universally required.
        
        Returns:
            bool: Always True - every property needs type information
        """
        return True

    def get_cpp_type_from_declaration(self, declaration):
        """
        Extract the inner C++ type from wrapped declarations like `property<T>`, `std::optional<T>`, `std::vector<T>`, or `one_or_many_property<T>`.
        
        Parses common wrapper templates and returns the unwrapped type name (for example, returns `model::broker_endpoint` from `one_or_many_property<model::broker_endpoint>`). The returned type is intended for downstream mapping to JSON schema types and default value resolution.
        
        Returns:
            raw_type (str): The extracted inner C++ type as a string, or a best-effort fragment of the declaration if a precise extraction cannot be performed.
        """
        one_line_declaration = declaration.replace("\n", "").strip()
        
        # Extract property template content with proper nesting handling
        # This handles cases like property<std::vector<config::sasl_mechanisms_override>>
        def extract_template_content(text, template_name):
            """
            Extracts the inner contents of the first occurrence of a template with the given name, correctly handling nested angle brackets.
            
            Parameters:
                text (str): The string to search for the template.
                template_name (str): The template name (e.g., "std::vector" or "property").
            
            Returns:
                str or None: The substring inside the outermost angle brackets for the matched template (excluding the brackets),
                or `None` if the template is not found or angle brackets are unbalanced.
            """
            start_idx = text.find(f'{template_name}<')
            if start_idx == -1:
                return None
            
            start_idx += len(f'{template_name}<')
            bracket_count = 1
            i = start_idx
            
            while i < len(text) and bracket_count > 0:
                if text[i] == '<':
                    bracket_count += 1
                elif text[i] == '>':
                    bracket_count -= 1
                i += 1
            
            if bracket_count == 0:
                return text[start_idx:i-1]
            return None
        
        # Extract the content from property<...>
        property_content = extract_template_content(one_line_declaration, 'property')
        if property_content:
            raw_type = property_content.split()[0].replace(",", "")
        else:
            # Fallback to original regex for simpler cases
            raw_type = (
                PROPERTY_TEMPLATE_PATTERN.sub(r"\1", one_line_declaration)
                .split()[0]
                .replace(",", "")
            )

        if self.OPTIONAL_PATTERN in raw_type:
            raw_type = OPTIONAL_TEMPLATE_PATTERN.sub(r"\1", raw_type)

        if self.ARRAY_PATTERN_STD_VECTOR in raw_type:
            raw_type = VECTOR_TEMPLATE_PATTERN.sub(r"\1", raw_type)
        
        # Handle one_or_many_property<T> - extract the inner type T
        # This is essential for Redpanda's flexible configuration properties
        # that can accept either single values or arrays
        # Check and extract from raw_type for consistency with other type extractors
        if self.ARRAY_PATTERN_ONE_OR_MANY in raw_type:
            raw_type = ONE_OR_MANY_PATTERN.sub(r"\1", raw_type)
            raw_type = raw_type.split()[0].replace(",", "")

        return raw_type

    def get_type_from_declaration(self, declaration):
        """
        Map a C++ type declaration string to a simplified, user-facing type name.
        
        Parameters:
            declaration (str): C++ type declaration or template expression from which the effective type will be derived.
        
        Returns:
            str: A JSON-schema-friendly type name such as "integer", "number", "string", "string[]", or "boolean". If no mapping matches, returns the normalized/raw extracted C++ type.
        """
        raw_type = self.get_cpp_type_from_declaration(declaration)
        type_mapping = [  # (regex, type)
            ("^u(nsigned|int)", "integer"),
            ("^(int|(std::)?size_t)", "integer"),
            ("data_directory_path", "string"),
            ("filesystem::path", "string"),
            ("(double|float)", "number"),
            ("string", "string"),
            ("bool", "boolean"),
            ("vector<[^>]+string>", "string[]"),
            ("std::chrono", "integer"),
        ]

        for m in type_mapping:
            if re.search(m[0], raw_type):
                return m[1]

        # Handle specific user-unfriendly C++ types with descriptive alternatives
        # Map complex C++ config types to user-friendly JSON schema types
        user_friendly_types = {
            "config::sasl_mechanisms_override": "object",
        }
        
        if raw_type in user_friendly_types:
            return user_friendly_types[raw_type]

        return raw_type

    def parse(self, property, info, file_pair):
        """
        Set the property's 'type' field to the JSON schema type derived from the C++ declaration.
        Always sets is_deprecated explicitly.
        Keeps the inner (real) type even for deprecated_property<T>.
        Also captures the original C++ type in c_type field for debugging and type lookup.
        """
        declaration = info.get("declaration", "") or ""

        # --- detect deprecation from declaration ---
        is_deprecated = "deprecated_property" in declaration
        property["is_deprecated"] = is_deprecated

        # --- unwrap deprecated_property<T> to extract real base type ---
        if is_deprecated:
            inner_decl = re.sub(r".*deprecated_property<(.+)>.*", r"\1", declaration)
        else:
            inner_decl = declaration

        # --- capture the original C++ type for debugging and definition lookup ---
        cpp_type = self.get_cpp_type_from_declaration(inner_decl)
        if cpp_type:
            property["c_type"] = cpp_type

        # --- derive the JSON schema type from the inner declaration ---
        derived_type = self.get_type_from_declaration(inner_decl)
        property["type"] = derived_type

        return property

@debug_transformer
class DeprecatedTransformer:
    """
    Marks the property as deprecated if 'deprecated' appears in meta.
    """
    def accepts(self, info, file_pair):
        return get_meta_value(info, "deprecated") is not None

    def parse(self, property, info, file_pair):
        val = get_meta_value(info, "deprecated")
        property["is_deprecated"] = True
        if val and val not in ("yes", "true"):
            property["deprecated_reason"] = val
        return property


@debug_transformer
class NumericBoundsTransformer:
    def __init__(self, type_transformer):
        self.type_transformer = type_transformer

    def accepts(self, info, file_pair):
        type_str = self.type_transformer.get_cpp_type_from_declaration(info["declaration"])
        return re.search("^(unsigned|u?int(8|16|32|64)?(_t)?)", type_str)

    def parse(self, property, info, file_pair):
        type_mapping = dict(
            unsigned=(0, 2**32 - 1),
            uint8_t=(0, 2**8 - 1),
            uint16_t=(0, 2**16 - 1),
            uint32_t=(0, 2**32 - 1),
            uint64_t=(0, 2**64 - 1),
            int=(-(2**31), 2**31 - 1),
            int8_t=(-(2**7), 2**7 - 1),
            int16_t=(-(2**15), 2**15 - 1),
            int32_t=(-(2**31), 2**31 - 1),
            int64_t=(-(2**63), 2**63 - 1),
        )
        type_str = self.type_transformer.get_cpp_type_from_declaration(info["declaration"])
        if type_str in type_mapping:
            property["minimum"] = type_mapping[type_str][0]
            property["maximum"] = type_mapping[type_str][1]

@debug_transformer
class DurationBoundsTransformer:
    def __init__(self, type_transformer):
        self.type_transformer = type_transformer

    def accepts(self, info, file_pair):
        return re.search("std::chrono::", info["declaration"])

    def parse(self, property, info, file_pair):
        # Sizes based on: https://en.cppreference.com/w/cpp/chrono/duration
        type_mapping = dict(
            nanoseconds=(-(2**63), 2**63 - 1),  # int 64
            microseconds=(-(2**54), 2**54 - 1),  # int 55
            milliseconds=(-(2**44), 2**44 - 1),  # int 45
            seconds=(-(2**34), 2**34 - 1),       # int 35
            minutes=(-(2**28), 2**28 - 1),       # int 29
            hours=(-(2**22), 2**22 - 1),         # int 23
            days=(-(2**24), 2**24 - 1),          # int 25
            weeks=(-(2**21), 2**21 - 1),         # int 22
            months=(-(2**19), 2**19 - 1),        # int 20
            years=(-(2**16), 2**16 - 1),         # int 17
        )
        type_str = self.type_transformer.get_cpp_type_from_declaration(info["declaration"])
        duration_type = type_str.replace("std::chrono::", "")
        if duration_type in type_mapping:
            property["minimum"] = type_mapping[duration_type][0]
            property["maximum"] = type_mapping[duration_type][1]

@debug_transformer
class SimpleDefaultValuesTransformer:
    def accepts(self, info, file_pair):
        return bool(info.get("params") and len(info["params"]) > 3)

    def parse(self, property, info, file_pair):
        params = info.get("params", [])
        if not params:
            return property

        # Find where the meta{} param is
        meta_index = next(
            (i for i, p in enumerate(params)
             if isinstance(p.get("value"), (dict, str))
             and ("meta{" in str(p["value"]) or
                  (isinstance(p["value"], dict) and "needs_restart" in p["value"]))),
            None,
        )

        # Default comes immediately after meta
        if meta_index is None:
            default_index = 3 if len(params) > 3 else None
        else:
            default_index = meta_index + 1 if len(params) > meta_index + 1 else None

        if default_index is None or default_index >= len(params):
            return property

        # Candidate default param
        default_param = params[default_index]
        default = default_param.get("value")

        # Skip obvious validator params
        if is_validator_param(default_param):
            return property

        # std::nullopt means "no default"
        if isinstance(default, str) and "std::nullopt" in default:
            property["default"] = None
            return property

        # legacy_default<T>(value, legacy_version{N})
        if isinstance(default, str) and "legacy_default" in default:
            match = re.search(r"legacy_default<[^>]+>\(([^,]+)", default)
            if match:
                default = match.group(1).strip()

        # {a, b, c} initializer → list
        if isinstance(default, str) and re.match(r"^\{.*\}$", default):
            inner = re.sub(r"^\{(.*)\}$", r"\1", default).strip()
            if inner:
                items = [normalize_string(x.strip().strip('"')) for x in inner.split(",")]
                property["default"] = items
            else:
                property["default"] = []
            return property

        # Simple booleans, numerics, or size literals
        if isinstance(default, str):
            if default in ("true", "false"):
                property["default"] = (default == "true")
                return property
            if re.match(r"^-?\d+\.\d+$", default):
                property["default"] = float(default)
                return property
            if re.match(r"^-?\d+$", default):
                property["default"] = int(default)
                return property
            # e.g. 20_GiB, 256_MiB
            size_match = re.match(r"(\d+)_([KMGTP])iB", default)
            if size_match:
                num, unit = int(size_match.group(1)), size_match.group(2)
                mult = {"K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4, "P": 1024**5}[unit]
                property["default"] = num * mult
                return property

        # Fallback — plain string
        default_value = normalize_string(str(default)).replace("std::", "")

        # Handle known type constructors that tree-sitter extracted
        # These are C++ default constructors where we know the resulting value
        if default_value in ["leaders_preference", "config::leaders_preference", "leaders_preference{}", "config::leaders_preference{}"]:
            default_value = "none"  # config::leaders_preference{} defaults to "none"
        elif default_value in ["data_directory_path", "config::data_directory_path", "data_directory_path{}", "config::data_directory_path{}"]:
            default_value = ""  # config::data_directory_path{} defaults to empty string

        property["default"] = default_value
        return property


@debug_transformer
class FriendlyDefaultTransformer:
    """
    Transforms complex C++ default expressions into human-readable JSON-friendly values.
    Handles patterns such as:
      - std::chrono::<unit>{<value>}
      - chrono::<unit>{<value>}
      - net::unresolved_address("127.0.0.1", 9092)
      - ss::sstring{CONSTEXPR}
      - { "a", "b" } and std::vector<...>{...}
      - std::nullopt and legacy_default<...>
      - Computed C++ constants (max_serializable_ms, etc.)
      - Complex symbolic constants

    COMPUTED CONSTANTS:
    Some C++ constants involve complex compile-time expressions that cannot be easily parsed.
    These are pre-computed and stored in the COMPUTED_CONSTANTS dictionary. For example:
      - max_serializable_ms: std::chrono::duration_cast<std::chrono::milliseconds>(
                             std::chrono::nanoseconds::max()) = 9223372036854 ms
    """

    ARRAY_PATTERN_STD_VECTOR = r"std::vector<[^>]+>\s*\{(.*)\}$"
    CHRONO_PATTERN = r"(?:std::)?chrono::(\w+)\s*\{\s*([^}]+)\s*\}"
    UNRESOLVED_ADDRESS_PATTERN = r'net::unresolved_address\s*\(\s*"?([^",]+)"?\s*,\s*([^)]+)\)'
    SSTRING_PATTERN = r'ss::sstring\s*\{\s*([^}]+)\s*\}'
    NUMERIC_LIMITS_PATTERN = r"std::numeric_limits<[^>]+>::max\(\)"
    LEGACY_DEFAULT_PATTERN = r"legacy_default<[^>]+>\(([^,]+)"
    BRACED_LIST_PATTERN = r"^\{(.*)\}$"

    def __init__(self):
        self._resolver = None

    def accepts(self, info, file_pair):
        return bool(info.get("params") and len(info["params"]) > 2)

    def _get_resolver(self):
        if self._resolver is None:
            resolver = get_resolve_constexpr_identifier()
            self._resolver = resolver if resolver else False
        return self._resolver if self._resolver is not False else None

    def _resolve_identifier(self, identifier):
        resolver = self._get_resolver()
        if resolver:
            try:
                return resolver(identifier)
            except Exception:
                return identifier
        return identifier

    def _parse_initializer_list(self, text):
        """Handle braced lists like {"a", "b"}."""
        inner = re.sub(self.BRACED_LIST_PATTERN, r"\1", text.strip()).strip()
        if not inner:
            return []
        parts = [p.strip().strip('"\'') for p in inner.split(",") if p.strip()]
        return [normalize_string(p) for p in parts]

    def _parse_vector_initializer(self, text):
        """Parse std::vector<T>{a, b, c} → ["a", "b", "c"]"""
        match = re.search(self.ARRAY_PATTERN_STD_VECTOR, text)
        if not match:
            return []
        contents = match.group(1).strip()
        return self._parse_initializer_list(f"{{{contents}}}")

    def parse(self, property, info, file_pair):
        params = info.get("params", [])
        if not params:
            return property

        # find meta param index
        meta_index = next(
            (i for i, p in enumerate(params)
             if isinstance(p.get("value"), (dict, str))
             and ("meta{" in str(p["value"])
                  or (isinstance(p["value"], dict) and "needs_restart" in p["value"]))),
            None,
        )

        # default param follows meta
        default_index = meta_index + 1 if meta_index is not None and len(params) > meta_index + 1 else 3
        if default_index >= len(params):
            return property

        default = params[default_index].get("value")
        if not isinstance(default, str):
            return property

        d = default.strip()

        # ------------------------------------------------------------------
        # Handle empty / nullopt / none cases
        # ------------------------------------------------------------------
        if "std::nullopt" in d or d in ("std::nullopt", "nullopt"):
            property["default"] = None
            return property

        # ------------------------------------------------------------------
        # Handle legacy_default<T>(value, ...)
        # ------------------------------------------------------------------
        legacy_match = re.search(self.LEGACY_DEFAULT_PATTERN, d)
        if legacy_match:
            d = legacy_match.group(1).strip()

        # ------------------------------------------------------------------
        # std::numeric_limits<T>::max()
        # ------------------------------------------------------------------
        if re.search(self.NUMERIC_LIMITS_PATTERN, d):
            property["default"] = "Maximum value"
            return property

        # ------------------------------------------------------------------
        # chrono::duration forms
        # ------------------------------------------------------------------
                # ------------------------------------------------------------------
        # chrono::duration forms
        #   - chrono::minutes{5}          -> "5 minutes"
        #   - std::chrono::weeks{2}       -> "2 weeks"
        #   - chrono::milliseconds{1min}  -> "1 minute"
        # ------------------------------------------------------------------
        chrono_match = re.search(self.CHRONO_PATTERN, d)
        if chrono_match:
            unit, value = chrono_match.groups()
            value = value.strip()

            # First handle inner literals like 1min, 30s, 100ms, 2h
            lit_match = re.match(r"(\d+)\s*(min|s|ms|h)", value)
            if lit_match:
                num, suffix = lit_match.groups()
                inner_unit_map = {
                    "min": "minute",
                    "s": "second",
                    "ms": "millisecond",
                    "h": "hour",
                }
                base = inner_unit_map.get(suffix, suffix)

                # pluralize
                if num != "1" and not base.endswith("s"):
                    base = base + "s"

                property["default"] = f"{num} {base}"
                # don't forcibly override property["type"] here; leave it as-is
                return property

            # Otherwise it's something like chrono::minutes{5} or chrono::weeks{2}
            # Use the outer chrono unit name.
            human_unit = unit
            # Simple pluralization fix if needed
            if value == "1" and human_unit.endswith("s"):
                human_unit = human_unit[:-1]

            property["default"] = f"{value} {human_unit}"
            return property


        # ------------------------------------------------------------------
        # net::unresolved_address("127.0.0.1", 9092)
        # ------------------------------------------------------------------
        if "net::unresolved_address" in d:
            match = re.search(self.UNRESOLVED_ADDRESS_PATTERN, d)
            if match:
                addr, port = match.groups()
                try:
                    port_val = int(port)
                except ValueError:
                    port_val = normalize_string(port)
                property["default"] = {
                    "address": addr.strip(),
                    "port": port_val,
                }
                property["type"] = "object"
                property["$ref"] = "#/definitions/net::unresolved_address"
                return property

        # ------------------------------------------------------------------
        # ss::sstring{CONSTEXPR}
        # ------------------------------------------------------------------
        sstr_match = re.search(self.SSTRING_PATTERN, d)
        if sstr_match:
            ident = sstr_match.group(1).strip()
            resolved = self._resolve_identifier(ident)
            property["default"] = resolved or ident
            return property

        # ------------------------------------------------------------------
        # std::vector initializer
        # ------------------------------------------------------------------
        if "std::vector" in d:
            property["default"] = self._parse_vector_initializer(d)
            property["type"] = "array"
            return property

        # ------------------------------------------------------------------
        # Plain braced list { ... }
        # ------------------------------------------------------------------
        if re.match(self.BRACED_LIST_PATTERN, d):
            property["default"] = self._parse_initializer_list(d)
            property["type"] = "array"
            return property

        # ------------------------------------------------------------------
        # Plain bool / numeric literals
        # ------------------------------------------------------------------
        if d in ("true", "false"):
            property["default"] = (d == "true")
            return property
        if re.match(r"^-?\d+\.\d+[fFlL]*$", d):
            # Strip C++ floating point suffixes (f, F, l, L)
            property["default"] = float(re.sub(r"[fFlL]+$", "", d))
            return property
        # Strip C++ integer suffixes (u, U, l, L, ll, LL, ul, UL, etc.)
        int_match = re.match(r"^(-?\d+)([uUlL]+)?$", d)
        if int_match:
            property["default"] = int(int_match.group(1))
            return property

        # ------------------------------------------------------------------
        # Size literals like 20_GiB
        # ------------------------------------------------------------------
        size_match = re.match(r"(\d+)_([KMGTP])iB", d)
        if size_match:
            num, unit = int(size_match.group(1)), size_match.group(2)
            mult = {"K": 1024, "M": 1024**2, "G": 1024**3, "T": 1024**4, "P": 1024**5}[unit]
            property["default"] = num * mult
            return property

        # ------------------------------------------------------------------
        # Computed C++ constants (max_serializable_ms, serde::max_serializable_ms, etc.)
        # Check this BEFORE generic namespace identifier check to ensure computed constants are resolved
        # ------------------------------------------------------------------
        if d in COMPUTED_CONSTANTS:
            property["default"] = COMPUTED_CONSTANTS[d]
            return property

        # ------------------------------------------------------------------
        # Constant-like or symbolic identifiers (model::..., net::..., etc.)
        # ------------------------------------------------------------------
        if "::" in d and not d.startswith("std::"):
            # Try to resolve to string enum if possible
            resolved = self._resolve_identifier(d)
            property["default"] = resolved or d
            return property

        # ------------------------------------------------------------------
        # Fallback — normalized string
        # ------------------------------------------------------------------
        property["default"] = normalize_string(d).replace("std::", "")
        return property


@debug_transformer
class EnumDefaultMappingTransformer:
    """
    Maps enum default values using enum string mappings.

    When an enum type has a _to_string() conversion function, the type definitions
    include enum_string_mappings. This transformer applies those mappings to the
    property's default value.

    Example:
        Property: write_caching_default
        Type: model::write_caching_mode
        Default: "default_false" (raw enum value)

        After mapping:
        Default: "false" (user-facing string)
    """


    def accepts(self, info, file_pair):
        # Accept properties that have enum constraints
        if "caching" in info.get("name", ""):
            logger.warning(f"[EnumDefaultMapping.accepts] {info.get('name')}: enum={info.get('enum')}, result={bool(info.get('enum'))}")
        return bool(info.get("enum"))

    def parse(self, property, info, file_pair):
        # Get default from property dict (may have been transformed by previous transformers)
        default = property.get("default")

        # Get enum values from BOTH property (transformed) and info (raw)
        # Prefer property's enum if it exists (already transformed), otherwise use info's
        enum_values = property.get("enum", info.get("enum", []))

        prop_name = property.get("name", info.get("name", "unknown"))

        # DEBUG logging for write_caching_default
        if prop_name == "write_caching_default":
            logger.warning(f"[EnumDefaultMapping] {prop_name}: default={default}, enum_values={enum_values}")
            logger.warning(f"   property keys: {list(property.keys())}")
            logger.warning(f"   info.enum: {info.get('enum')}")

        # Skip if no default
        if not default or not isinstance(default, str):
            if prop_name == "write_caching_default":
                logger.warning(f"[EnumDefaultMapping] Skipping: no default or not string")
            return property

        # Skip if default is already one of the mapped enum values
        if default in enum_values:
            if prop_name == "write_caching_default":
                logger.warning(f"[EnumDefaultMapping] Skipping: default already in enum values")
            return property

        # Check if we have a type definition with mappings
        type_defs = get_type_definitions()
        if not type_defs:
            if prop_name == "write_caching_default":
                logger.warning(f"[EnumDefaultMapping] No type definitions available")
            return property

        # Try to find the enum type definition
        # The enum might be stored under various names, try to match
        for type_name, type_def in type_defs.items():
            if type_def.get("type") != "enum":
                continue

            mappings = type_def.get("enum_string_mappings")
            if not mappings:
                continue

            # If this default value exists in the mappings, apply it
            if default in mappings:
                mapped_value = mappings[default]
                property["default"] = mapped_value
                logger.debug(f"Mapped enum default for {prop_name}: {default} -> {mapped_value}")
                return property

        return property


def get_type_definitions():
    """
    Lazily import type definitions to avoid circular imports.
    Returns the type definitions dictionary from property_extractor.
    """
    try:
        import property_extractor
        # Access the module-level variable directly
        if hasattr(property_extractor, '_type_definitions_cache'):
            cache = property_extractor._type_definitions_cache
            if cache:  # Check it's not empty
                return cache
        return None
    except (ImportError, AttributeError) as e:
        logger.debug(f"Could not import type definitions: {e}")
        return None


@debug_transformer
class ExperimentalTransformer:
    """
    Marks a property as experimental if flagged in meta or hidden_when_default.
    """
    def accepts(self, info, file_pair):
        return (
            get_meta_value(info, "experimental") is not None
            or (info.get("type") and info["type"].startswith(("development_", "hidden_when_default_")))
        )

    def parse(self, property, info, file_pair):
        # Check if type indicates experimental (development_ or hidden_when_default_)
        is_experimental_type = (
            info.get("type") and
            info["type"].startswith(("development_", "hidden_when_default_"))
        )

        # Get meta value, but default to "yes" if type is experimental
        default_val = "yes" if is_experimental_type else "no"
        val = get_meta_value(info, "experimental", default_val)

        property["is_experimental_property"] = (val != "no")
        return property


@debug_transformer
class AliasTransformer:
    def accepts(self, info, file_pair):
        if 'params' in info:
            for param in info['params']:
                if isinstance(param, dict) and 'value' in param:
                    value = param['value']
                    if isinstance(value, dict) and 'aliases' in value:
                        return True
        return False

    def parse(self, property, info, file_pair):
        aliases = []
        for param in info['params']:
            value = param.get('value', {})
            if isinstance(value, dict) and 'aliases' in value:
                aliases_dict = value['aliases']
                # Extract each alias, removing any surrounding braces or quotes.
                aliases.extend(alias.strip('{}"') for alias in aliases_dict.values())
        property['aliases'] = aliases

@debug_transformer
class EnterpriseTransformer:
    """
    Detect and extract enterprise-only constructor parameters.

    Relies on the parser's header metadata (`is_enterprise` / `is_enterprise_wrapper`)
    rather than heuristics. If a property is not marked as enterprise in its
    declaration type (e.g. `enterprise<property<T>>`), this transformer skips it.

    Supported patterns:
      - restricted_only:           Enterprise config with restricted values only
      - sanctioned_only:           Enterprise config with sanctioned values only
      - restricted_with_sanctioned: both restricted + sanctioned values
    """

    def accepts(self, info, file_pair):
        """Run for all properties to set is_enterprise flag."""
        # Always run for all properties so we can set is_enterprise flag
        return True

    def parse(self, property, info, file_pair):
        """Identify and record enterprise constructor values, if applicable."""
        if not self.accepts(info, file_pair):
            return property

        # Check if this is actually an enterprise property
        is_enterprise_property = info.get("is_enterprise") or info.get("is_enterprise_wrapper")

        params = info.get("params", [])
        if not params or len(params) < 3:
            # Not enough params to be an enterprise constructor
            property["is_enterprise"] = bool(is_enterprise_property)
            return property

        # If not marked as enterprise in the source, set to False and return
        if not is_enterprise_property:
            property["is_enterprise"] = False
            return property

        enterprise_constructor = None
        restricted_vals, sanctioned_vals = None, None

        # --- Check for vector at both start and end ---
        if len(params) >= 6 and all("std::vector" in str(p["value"]) for p in [params[0], params[-1]]):
            restricted_vals = self._extract_list_items(params[0]["value"])
            last_vector_vals = self._extract_list_items(params[-1]["value"])

            # If last vector is a superset of first vector, it's the enum definition, not sanctioned values
            # Pattern: restricted_only with enum defined in last parameter
            if set(restricted_vals).issubset(set(last_vector_vals)) and len(last_vector_vals) > len(restricted_vals):
                enterprise_constructor = "restricted_only"
                info["params"] = params[1:-1]  # Keep last param for enum extraction by TypeTransformer
            else:
                # True restricted_with_sanctioned: last vector is sanctioned values, not enum
                enterprise_constructor = "restricted_with_sanctioned"
                sanctioned_vals = last_vector_vals
                info["params"] = params[1:-1]

        # --- restricted_only (vector form) ---
        elif len(params) >= 5 and "std::vector" in str(params[0]["value"]):
            enterprise_constructor = "restricted_only"
            restricted_vals = self._extract_list_items(params[0]["value"])
            info["params"] = params[1:]

        # --- sanctioned_only (vector form) ---
        elif len(params) >= 5 and "std::vector" in str(params[-1]["value"]):
            enterprise_constructor = "sanctioned_only"
            sanctioned_vals = self._extract_list_items(params[-1]["value"])
            info["params"] = params[:-1]

        # --- restricted_with_sanctioned (scalar form) ---
        elif (
            len(params) >= 6
            and all(p["type"] in ("true", "false", "integer_literal", "string_literal", "qualified_identifier") for p in params[:2])
        ):
            enterprise_constructor = "restricted_with_sanctioned"
            restricted_vals = [self._clean_value(params[0]["value"])]
            sanctioned_vals = [self._clean_value(params[1]["value"])]
            info["params"] = params[2:]

        # --- restricted_only (scalar form) ---
        elif len(params) >= 5 and params[0]["type"] in (
            "true", "false", "integer_literal", "string_literal", "qualified_identifier"
        ):
            enterprise_constructor = "restricted_only"
            restricted_vals = [self._clean_value(params[0]["value"])]
            info["params"] = params[1:]

        # --- simple enterprise property (lambda validator pattern) ---
        elif (len(params) >= 3 and 
              params[0].get("type") == "lambda_expression" and
              params[1].get("type") == "string_literal"):
            enterprise_constructor = "simple"
            # Don't modify params for simple enterprise properties - they have normal structure
            # Remove the lambda validator from parameters as it's not needed for documentation
            info["params"] = params[1:]

        if not enterprise_constructor:
            # Not an enterprise property - explicitly set to False
            property["is_enterprise"] = False
            return property

        # Record enterprise attributes
        property["is_enterprise"] = True
        property["enterprise_constructor"] = enterprise_constructor

        if restricted_vals is not None:
            property["enterprise_restricted_value"] = restricted_vals
            property["enterprise_value"] = restricted_vals  # backward compat

        if sanctioned_vals is not None:
            property["enterprise_sanctioned_value"] = sanctioned_vals

        # Add friendly description (values are already cleaned by _clean_value)
        if enterprise_constructor == "restricted_with_sanctioned":
            r = restricted_vals[0]
            s = sanctioned_vals[0]
            property["enterprise_default_description"] = (
                f"Default: `{s}` (Community) or `{r}` (Enterprise)"
            )
        elif enterprise_constructor == "restricted_only":
            if len(restricted_vals) > 1:
                vals = ", ".join(f"`{v}`" for v in restricted_vals)
                property["enterprise_default_description"] = (
                    f"Available only with Enterprise license: {vals}"
                )
            else:
                property["enterprise_default_description"] = (
                    f"Available only with Enterprise license: `{restricted_vals[0]}`"
                )
        elif enterprise_constructor == "sanctioned_only":
            property["enterprise_default_description"] = (
                f"Community-only configuration. Sanctioned value: `{sanctioned_vals[0]}`"
            )

        return property

    # --- Helper: clean literal/identifier values ---
    def _clean_value(self, val):
        if not isinstance(val, str):
            return val
        val = val.strip()
        # remove surrounding quotes for string literals
        if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
            val = val[1:-1]
        # Strip C++ namespace qualifiers from enum values
        # e.g., model::partition_autobalancing_mode::continuous → continuous
        if '::' in val:
            val = val.split('::')[-1]
        return val

    # --- Helper: extract list elements from std::vector{...} ---
    def _extract_list_items(self, vector_text):
        match = re.search(r"\{([^}]*)\}", vector_text)
        if not match:
            return []
        contents = match.group(1)
        items = [self._clean_value(v.strip()) for v in contents.split(",") if v.strip()]
        return items


@debug_transformer
class MetaParamTransformer:
    """
    Converts Redpanda meta initializer strings (meta{...} or {...})
    into structured dictionaries usable by downstream transformers.

    Handles all Redpanda meta fields:
        - .needs_restart
        - .visibility
        - .example
        - .deprecated
        - .secret
        - .experimental
        - .gets_restored / .restored

    Works with both explicit and implicit meta wrappers:
        meta{ .visibility = visibility::user }
        {.needs_restart = needs_restart::no, .example = "123"}

    Skips non-meta initializer lists like {"a", "b"}.
    """

    def accepts(self, info, file_pair):
        # Accept if any param looks like a meta initializer
        return any(
            isinstance(p.get("value"), str)
            and (
                # explicit meta{...}
                p["value"].strip().startswith("meta{")
                # or bare {...} with at least one known meta key
                or (
                    p["value"].strip().startswith("{")
                    and re.search(
                        r"\.(needs_restart|visibility|example|deprecated|secret|experimental|gets_restored|restored)\s*=",
                        p["value"]
                    )
                )
            )
            for p in info.get("params", [])
        )

    def parse(self, property, info, file_pair):
        params = info.get("params", [])
        for p in params:
            val = p.get("value")
            if not isinstance(val, str):
                continue

            stripped = val.strip()

            # Only treat as meta if it matches known meta key patterns
            if not (
                stripped.startswith("meta{")
                or (
                    stripped.startswith("{")
                    and re.search(
                        r"\.(needs_restart|visibility|example|deprecated|secret|experimental|gets_restored|restored)\s*=",
                        stripped
                    )
                )
            ):
                continue

            # Extract content between first '{' and matching '}'
            match = re.search(r"\{(.*)\}", stripped, re.DOTALL)
            if not match:
                continue

            inner = match.group(1).strip()
            meta_dict = {}

            # Split fields like `.needs_restart = needs_restart::no,`
            for field in re.split(r",\s*(?=\.)", inner):
                field = field.strip().lstrip(".")
                if not field or "=" not in field:
                    continue

                key, value = [s.strip() for s in field.split("=", 1)]
                clean_key = key.replace(".", "")
                meta_dict[clean_key] = value

                # 🔹 Inline special handlers for known meta keys
                # ----------------------------------------------

                # Example values
                if clean_key == "example":
                    val_clean = value.strip().strip('"')
                    # Try to coerce to int or float, else leave as string
                    if re.fullmatch(r"-?\d+", val_clean):
                        property["example"] = int(val_clean)
                    elif re.fullmatch(r"-?\d+\.\d+", val_clean):
                        property["example"] = float(val_clean)
                    else:
                        property["example"] = normalize_string(val_clean)

                # Gets_restored / restored flags
                elif clean_key in ("gets_restored", "restored"):
                    val_clean = re.sub(r"^.*::", "", value)
                    property["gets_restored"] = (val_clean != "no")

                # Secret flags
                elif clean_key == "secret":
                    val_clean = re.sub(r"^.*::", "", value)
                    property["is_secret"] = (val_clean == "yes")

                # Visibility normalization (user, tunable, deprecated)
                elif clean_key == "visibility":
                    val_clean = re.sub(r"^.*::", "", value)
                    property["visibility"] = val_clean

                # Needs restart normalization
                elif clean_key == "needs_restart":
                    val_clean = re.sub(r"^.*::", "", value)
                    property["needs_restart"] = (val_clean != "no")

            # Tag and attach parsed meta info
            meta_dict["type"] = "initializer_list"
            p["value"] = meta_dict

        return property


@debug_transformer
class ExampleTransformer:
    """
    ExampleTransformer - Extracts example values from C++ property meta parameters
    
    RESPONSIBILITY:
    Processes the `.example` field from C++ meta{} initializers and adds the example
    value to the PropertyBag for documentation generation.
    
    PROCESSING:
    1. Checks parameters for dictionary format meta data (already parsed by parser)
    2. Searches for `example` key in initializer_list parameters 
    3. Attempts to parse example value as integer, float, or string
    4. Adds parsed example to property as "example" field
    
    DOWNSTREAM USAGE:
    - Documentation generators use example values in property descriptions
    - Configuration examples use placeholder values
    - API documentation shows realistic usage patterns
    
    INPUT FORMAT (parsed parameters):
    [
        {'value': 'property_name', 'type': 'string_literal'},
        {'value': 'Description...', 'type': 'string_literal'},
        {'value': {'needs_restart': 'needs_restart::yes', 'example': '"1073741824"', 'visibility': 'visibility::tunable'}, 'type': 'initializer_list'},
        ...
    ]
    
    OUTPUT:
    Adds to PropertyBag: {"example": "1073741824"}
    """
    
    def accepts(self, info, file_pair):
        """Accept properties that have meta parameters with example values in dictionary format"""
        if not info.get("params"):
            return False
            
        # Look for initializer_list parameters that contain example keys
        for param in info["params"]:
            if param.get("type") == "initializer_list" and isinstance(param.get("value"), dict):
                if "example" in param["value"]:
                    return True
        return False
    
    def parse(self, property, info, file_pair):
        """Extract example value from parsed meta parameters"""
        if not self.accepts(info, file_pair):
            return property
            
        for param in info["params"]:
            if param.get("type") == "initializer_list" and isinstance(param.get("value"), dict):
                meta_dict = param["value"]
                if "example" in meta_dict:
                    example_val = meta_dict["example"]
                    
                    # Clean up the value (remove quotes, etc.)
                    if isinstance(example_val, str):
                        example_val = example_val.strip().strip('"\'')
                    
                    # Try to coerce to appropriate type
                    if isinstance(example_val, str):
                        if re.fullmatch(r"-?\d+", example_val):
                            property["example"] = int(example_val)
                        elif re.fullmatch(r"-?\d+\.\d+", example_val):
                            property["example"] = float(example_val)
                        else:
                            property["example"] = example_val
                    else:
                        property["example"] = example_val
                    break
                    
        return property


@debug_transformer
class ValidatorEnumExtractor:
    """
    ValidatorEnumExtractor - Extracts enum constraints from validator functions for array properties

    RESPONSIBILITY:
    Analyzes validator functions to extract enum constraints for array-typed properties.
    For example, if sasl_mechanisms uses validate_sasl_mechanisms, this transformer:
    1. Finds the validator function in validators.cc
    2. Identifies the constraint array (e.g., supported_sasl_mechanisms)
    3. Resolves that array to get the actual enum values
    4. Adds them to property['items']['enum']

    PROCESSING:
    1. Detects array properties (type="array") with validator parameters
    2. Extracts validator function name from params
    3. Parses validator to find constraint array
    4. Resolves array to get enum values (e.g., ["SCRAM", "GSSAPI", "OAUTHBEARER", "PLAIN"])
    5. Sets property['items']['enum'] with the discovered values

    DOWNSTREAM USAGE:
    - JSON Schema generators use items.enum for validation rules
    - Documentation shows accepted values for array properties
    - API clients use enum values for input validation

    EXAMPLE:
    Input property with validator:
        sasl_mechanisms(..., validate_sasl_mechanisms)

    Output property with enum:
        {
            "type": "array",
            "items": {
                "type": "string",
                "enum": ["SCRAM", "GSSAPI", "OAUTHBEARER", "PLAIN"]
            }
        }
    """
    def __init__(self, constant_resolver):
        """
        Args:
            constant_resolver: ConstantResolver instance for resolving C++ constants
        """
        self.constant_resolver = constant_resolver

    def accepts(self, info, file_pair):
        """Only process array properties that have validator params."""
        params = info.get("params", [])
        if not params:
            return False

        # Must be an array type
        base_type = info.get("base_property_type", "")
        if not base_type or "vector" not in base_type:
            return False

        # Must have a validator parameter (usually the last param)
        # Validator is typically after: name, desc, meta, default
        return len(params) >= 5

    def parse(self, property, info, file_pair):
        """Extract enum constraint from validator function."""
        if not self.accepts(info, file_pair):
            return property

        params = info.get("params", [])

        # Look for validator in the last few parameters
        # Typically: params[0]=name, [1]=desc, [2]=meta, [3]=default, [4]=validator
        validator_param = None
        validator_name = None

        for i in range(min(4, len(params)), len(params)):
            param = params[i]
            param_val = param.get("value", "")
            param_type = param.get("type", "")

            # Skip if it's not a validator-like identifier
            if param_type not in ("identifier", "qualified_identifier", "call_expression"):
                continue

            # Check if it looks like a validator function name
            if isinstance(param_val, str) and ("validate" in param_val or "validator" in param_val):
                validator_name = param_val.replace("&", "").strip()
                validator_param = param
                break

        if not validator_name:
            return property

        # Use constant_resolver to extract enum constraint from validator
        from constant_resolver import resolve_validator_enum_constraint

        enum_results = resolve_validator_enum_constraint(validator_name, self.constant_resolver)

        if enum_results:
            # Add enum to items
            if "items" not in property:
                property["items"] = {}

            # Extract just the values for the enum field
            property["items"]["enum"] = [result["value"] for result in enum_results]

            # Add metadata about which enum values are enterprise-only
            enum_metadata = {}
            for result in enum_results:
                enum_metadata[result["value"]] = {
                    "is_enterprise": result["is_enterprise"]
                }

            # Only add x-enum-metadata if there are enterprise values
            if any(result["is_enterprise"] for result in enum_results):
                property["items"]["x-enum-metadata"] = enum_metadata

            logger.info(f"✓ Extracted enum constraint for {property.get('name', 'unknown')} from validator {validator_name}: {property['items']['enum']}")

        return property


@debug_transformer
class RuntimeValidationEnumExtractor:
    """
    RuntimeValidationEnumExtractor - Extracts enum constraints from runtime validation functions

    RESPONSIBILITY:
    For string properties without constructor validators, searches for runtime validation
    functions that compare the property value against constants and extracts those as enum values.

    PROCESSING:
    1. Detects string properties (not arrays) without validator parameters
    2. Searches the source file for validation functions that reference the property
    3. Parses comparison patterns (e.g., property != constant1 && property != constant2)
    4. Resolves constants to actual string values
    5. Sets property['enum'] with discovered values

    EXAMPLE:
    Input property without constructor validator:
        sasl_mechanism(*this, "sasl_mechanism", "Description...", {}, "")

    Runtime validation function:
        void validate_sasl_properties(..., std::string_view mechanism, ...) {
            if (mechanism != security::scram_sha256_authenticator::name
                && mechanism != security::scram_sha512_authenticator::name
                && mechanism != security::oidc::sasl_authenticator::name) {
                throw std::invalid_argument("Invalid mechanism");
            }
        }

    Output property with enum:
        {
            "type": "string",
            "enum": ["SCRAM-SHA-256", "SCRAM-SHA-512", "OAUTHBEARER"]
        }
    """
    def __init__(self, constant_resolver):
        """
        Args:
            constant_resolver: ConstantResolver instance for resolving C++ constants
        """
        self.constant_resolver = constant_resolver

    def accepts(self, info, file_pair):
        """Only process string properties without constructor validators."""
        params = info.get("params", [])
        if not params:
            return False

        # Must be a string type (not array)
        base_type = info.get("base_property_type", "")
        if not base_type:
            return False
        if "vector" in base_type or "array" in base_type:
            return False

        # Should be ss::sstring or std::string
        if "sstring" not in base_type and "string" not in base_type:
            return False

        # Should NOT have a validator parameter (those are handled by ValidatorEnumExtractor)
        # Check if any param looks like a validator
        for param in params[4:]:  # Skip name, desc, meta, default
            param_val = param.get("value", "")
            if isinstance(param_val, str) and ("validate" in param_val or "validator" in param_val):
                return False

        return True

    def parse(self, property, info, file_pair):
        """Extract enum constraint from runtime validation function."""
        if not self.accepts(info, file_pair):
            return property

        property_name = property.get("name")
        defined_in = property.get("defined_in")

        if not property_name or not defined_in:
            return property

        # Use constant_resolver to extract enum constraint from runtime validation
        from constant_resolver import resolve_runtime_validation_enum_constraint

        enum_results = resolve_runtime_validation_enum_constraint(
            property_name, defined_in, self.constant_resolver
        )

        if enum_results:
            # Extract just the values for the enum field
            property["enum"] = [result["value"] for result in enum_results]

            # Add metadata about which enum values are enterprise-only
            enum_metadata = {}
            for result in enum_results:
                enum_metadata[result["value"]] = {
                    "is_enterprise": result["is_enterprise"]
                }

            # Only add x-enum-metadata if there are enterprise values
            if any(result["is_enterprise"] for result in enum_results):
                property["x-enum-metadata"] = enum_metadata

            logger.info(f"✓ Extracted runtime validation enum for {property_name}: {property['enum']}")

        return property



################################################################################
# TRANSFORMER SYSTEM USAGE AND EXTENSION GUIDE
################################################################################

"""
USING THE TRANSFORMER SYSTEM:

The transformers are designed to be used as part of the property extraction pipeline
in property_extractor.py. The typical usage pattern is:

    transformers = [
        ParamNormalizerTransformer(),
        BasicInfoTransformer(), 
        MetaParamTransformer(),
        NeedsRestartTransformer(),
        GetsRestoredTransformer(),
        IsSecretTransformer(),
        VisibilityTransformer(),
        IsNullableTransformer(),
        IsArrayTransformer(type_transformer),
        TypeTransformer(),
        DeprecatedTransformer(),
        NumericBoundsTransformer(type_transformer),
        DurationBoundsTransformer(type_transformer),
        SimpleDefaultValuesTransformer(),
        FriendlyDefaultTransformer(),
        ExperimentalTransformer(),
        AliasTransformer(),
        EnterpriseTransformer(),
    ]

    for name, property_info in extracted_properties.items():
        property_bag = PropertyBag()
        
        for transformer in transformers:
            if transformer.accepts(property_info, file_pair):
                transformer.parse(property_bag, property_info, file_pair)
        
        final_properties[name] = property_bag

CREATING NEW TRANSFORMERS:

To add a new transformer, follow this pattern:

    @debug_transformer
    class MyNewTransformer:
        '''
        Brief description of what this transformer does.
        
        Include:
        - What it detects/extracts
        - Expected input format
        - Expected output format  
        - Downstream dependencies
        - Usage examples
        '''
        
        def accepts(self, info, file_pair):
            '''
            Return True if this transformer should process the given property.
            
            Args:
                info (dict): Raw property info from Tree-sitter parser
                file_pair (FilePair): Source file locations
                
            Returns:
                bool: True if transformer should process this property
            '''
            # Add your detection logic here
            return some_condition_check(info)
            
        def parse(self, property, info, file_pair):
            '''
            Extract/transform information from raw property info.
            
            Args:
                property (PropertyBag): Property to populate/modify
                info (dict): Raw property info to extract from
                file_pair (FilePair): Source file locations
                
            Returns:
                PropertyBag: The modified property (typically the same object)
            '''
            # Add your extraction/transformation logic here
            property["my_new_field"] = extract_my_data(info)
            return property

TRANSFORMER DESIGN PRINCIPLES:

1. SINGLE RESPONSIBILITY: Each transformer should handle one specific aspect
   of property processing (types, defaults, metadata, etc.)

2. DEFENSIVE PROGRAMMING: Always check for expected data structures and 
   handle missing/malformed data gracefully

3. IMMUTABLE INPUTS: Never modify the 'info' dict unless explicitly designed
   to normalize it (like ParamNormalizerTransformer)

4. COMPREHENSIVE LOGGING: Use @debug_transformer decorator and add detailed
   docstrings for debugging and maintenance

5. DEPENDENCY AWARENESS: Understand which transformers depend on your output
   and ensure proper ordering in the pipeline

6. TYPE SAFETY: Handle different parameter types robustly (strings, dicts, lists)

7. PATTERN CONSISTENCY: Follow established patterns for metadata extraction,
   type mapping, and error handling

DEBUGGING TRANSFORMER ISSUES:

1. Enable DEBUG_TRANSFORMERS = True at module level
2. Set DEBUG_FILTER to focus on specific properties  
3. Use @debug_transformer decorator on new transformers
4. Check transformer execution order - dependencies must run first
5. Verify accepts() logic correctly identifies target properties
6. Test with various C++ property declaration patterns

COMMON GOTCHAS:

1. Parameter ordering varies between property types (enterprise vs regular)
2. Tree-sitter parsing can produce different structures for similar C++ code
3. Meta information may be in different formats (raw strings vs parsed dicts)  
4. Type extraction must handle arbitrarily nested template patterns
5. Default values may reference constants that need separate resolution
6. Circular imports between transformers.py and property_extractor.py

MAINTENANCE CHECKLIST:

When Redpanda C++ code patterns change:
□ Update type extraction patterns for new C++ constructs
□ Add new metadata keys to find_meta_dict() recognition
□ Update enterprise property parameter patterns
□ Test with sample properties from new Redpanda versions  
□ Update documentation examples to reflect current usage
□ Verify backwards compatibility with existing property patterns

When JSON Schema requirements change:
□ Update type mapping in TypeTransformer
□ Add new validation constraints as transformer outputs
□ Update downstream schema consumption in documentation generators
□ Test schema validation with updated property definitions

The transformer system is designed to be extensible and maintainable. Follow
these patterns and your additions will integrate smoothly with the existing
pipeline while maintaining reliability and debuggability.
"""
