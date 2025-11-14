#!/usr/bin/env python3
"""
Redpanda Configuration Property Extractor

This script extracts configuration properties from Redpanda's C++ source code and generates
JSON schema definitions with proper type resolution and default value expansion.

SPECIAL HANDLING FOR one_or_many_property TYPES:

Redpanda uses a custom C++ type called `one_or_many_property<T>` for configuration properties
that can accept either a single value or an array of values. Examples include:

- admin: one_or_many_property<model::broker_endpoint>
- admin_api_tls: one_or_many_property<endpoint_tls_config>  
- kafka_api_tls: one_or_many_property<endpoint_tls_config>

These properties allow flexible configuration syntax:
  Single value:  admin: {address: "127.0.0.1", port: 9644}
  Array syntax:  admin: [{address: "127.0.0.1", port: 9644}, {address: "0.0.0.0", port: 9645}]

PROCESSING PIPELINE:

1. **Property Detection & Transformation** (transformers.py):
   - IsArrayTransformer detects one_or_many_property<T> declarations
   - Marks these properties as type="array" with items.type extracted from T
   - TypeTransformer extracts inner types from template declarations

2. **Type Resolution & Default Expansion** (property_extractor.py):
   - resolve_type_and_default() converts C++ types to JSON schema types
   - Expands C++ constructor defaults to structured JSON objects
   - Ensures array-type properties have array defaults (wraps single objects in arrays)

3. **Documentation Generation** (generate-handlebars-docs.js):
   - Properly formats array defaults as [{ }] instead of { }
   - Displays correct types in documentation (array vs object)

EXAMPLE TRANSFORMATION:

C++ Source:
  one_or_many_property<model::broker_endpoint> admin(
    *this, "admin", "Network address for Admin API",
    {model::broker_endpoint(net::unresolved_address("127.0.0.1", 9644))}
  );

JSON Output:
  "admin": {
    "type": "array",
    "items": {"type": "object"},
    "default": [{"address": "127.0.0.1", "port": 9644}]
  }

Documentation Output:
  Type: array
  Default: [{address: "127.0.0.1", port: 9644}]
"""
import logging
import sys
import os
import json
import re
import yaml
import ast
from copy import deepcopy

from pathlib import Path
from file_pair import FilePair
from tree_sitter import Language, Parser
import operator
import re

from parser import build_treesitter_cpp_library, extract_properties_from_file_pair
from property_bag import PropertyBag
from transformers import *
from constant_resolver import ConstantResolver

# Compiled regex patterns for performance optimization
VECTOR_PATTERN = re.compile(r'std::vector<[^>]+>\s*\{\s*([^}]*)\s*\}')
ENUM_PATTERN = re.compile(r'^[a-zA-Z0-9_:]+::([a-zA-Z0-9_]+)$')  # Match full qualified identifier, not followed by constructors
CONSTRUCTOR_PATTERN = re.compile(r'([a-zA-Z0-9_:]+)\((.*)\)')
BRACED_CONSTRUCTOR_PATTERN = re.compile(r'([a-zA-Z0-9_:]+)\{(.*)\}')
DIGIT_SEPARATOR_PATTERN = re.compile(r"(?<=\d)'(?=\d)")
FUNCTION_CALL_PATTERN = re.compile(r'([a-zA-Z0-9_:]+)\(\)')
CHRONO_PATTERN = re.compile(r'std::chrono::([a-zA-Z]+)\s*\{\s*(\d+)\s*\}')
CHRONO_PAREN_PATTERN = re.compile(r'(?:std::)?chrono::([a-zA-Z]+)\s*\(\s*([^)]+)\s*\)')
TIME_UNIT_PATTERN = re.compile(r'(\d+)\s*(min|s|ms|h)')
ADDRESS_PATTERN = re.compile(r'net::unresolved_address\s*\(\s*"?([^",]+)"?\s*,\s*([^)]+)\)')
KEYVAL_PATTERN = re.compile(r"'([^']+)':\s*'([^']+)'")
IDENTIFIER_PATTERN = re.compile(r'^[a-zA-Z_][a-zA-Z0-9_]*$')
SSTRING_PATTERN = re.compile(r'ss::sstring\{([a-zA-Z_][a-zA-Z0-9_]*)\}')
UNDERSCORE_PREFIX_PATTERN = re.compile(r"^_")

class ConstexprCache:
    """
    Cache for C++ constexpr identifier and function lookups to avoid repeated filesystem walks.
    
    This class dramatically improves performance when processing large numbers of properties
    by building a cache of all constexpr definitions once, then serving lookups from memory.
    
    Performance Impact:
    - Without cache: O(n*m) where n = properties, m = source files (thousands of filesystem operations)
    - With cache: O(m + n) where cache build is O(m), lookups are O(1) (single filesystem walk)
    """
    
    def __init__(self):
        self.constexpr_cache = {}  # identifier -> value
        self.function_cache = {}   # function_name -> value
        self.is_built = False
        self.redpanda_source = None
    
    def build_cache(self, redpanda_source=None):
        """
        Build the cache by walking the Redpanda source tree once and extracting all constexpr definitions.
        
        Args:
            redpanda_source (str, optional): Path to Redpanda source. If None, will be auto-detected.
        """
        if self.is_built and self.redpanda_source == redpanda_source:
            return  # Already built for this source
        
        if not redpanda_source:
            redpanda_source = find_redpanda_source()
        
        if not redpanda_source:
            logger.warning("Could not find Redpanda source directory for constexpr cache")
            return
        
        self.redpanda_source = redpanda_source
        self.constexpr_cache.clear()
        self.function_cache.clear()
        
        # Constexpr identifier patterns
        constexpr_patterns = [
            re.compile(r'inline\s+constexpr\s+std::string_view\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{\s*"([^"]+)"\s*\}'),
            re.compile(r'constexpr\s+std::string_view\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{\s*"([^"]+)"\s*\}'),
            re.compile(r'inline\s+constexpr\s+auto\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"([^"]+)"'),
            re.compile(r'constexpr\s+auto\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"([^"]+)"'),
            re.compile(r'static\s+constexpr\s+std::string_view\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{\s*"([^"]+)"\s*\}'),
            re.compile(r'static\s+inline\s+constexpr\s+std::string_view\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{\s*"([^"]+)"\s*\}'),
        ]
        
        # General function patterns to extract ALL string-returning functions
        # These patterns capture: namespace::function_name and the returned string
        general_function_patterns = [
            # Pattern: inline constexpr std::string_view name { "value" }
            re.compile(r'inline\s+constexpr\s+std::string_view\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{\s*"([^"]+)"\s*\}'),
            # Pattern: constexpr std::string_view name { "value" }
            re.compile(r'constexpr\s+std::string_view\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{\s*"([^"]+)"\s*\}'),
            # Pattern: inline std::string_view name() { return "value"; }
            re.compile(r'inline\s+std::string_view\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*\)\s*\{\s*return\s*"([^"]+)"'),
            # Pattern: std::string_view name() { return "value"; }
            re.compile(r'std::string_view\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*\)\s*\{\s*return\s*"([^"]+)"'),
            # Pattern: inline const model::topic name("value")
            re.compile(r'inline\s+const\s+model::topic\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*"([^"]+)"\s*\)'),
            # Pattern: const model::topic name("value")
            re.compile(r'const\s+model::topic\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*"([^"]+)"\s*\)'),
            # Pattern: inline const model::ns name("value")
            re.compile(r'inline\s+const\s+model::ns\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*"([^"]+)"\s*\)'),
            # Pattern: const model::ns name("value")
            re.compile(r'const\s+model::ns\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*"([^"]+)"\s*\)'),
        ]

        # Legacy specific patterns (kept for compatibility, but general patterns should cover these)
        function_patterns = {}

        search_dirs = [
            os.path.join(redpanda_source, 'src', 'v', 'model'),  # For model:: functions
            os.path.join(redpanda_source, 'src', 'v', 'config'),
            os.path.join(redpanda_source, 'src', 'v', 'kafka'),
            os.path.join(redpanda_source, 'src', 'v', 'security'),
            os.path.join(redpanda_source, 'src', 'v', 'pandaproxy'),
        ]
        
        files_processed = 0
        for search_dir in search_dirs:
            if not os.path.exists(search_dir):
                continue
                
            for root, dirs, files in os.walk(search_dir):
                for file in files:
                    if file.endswith(('.h', '.cc', '.hpp', '.cpp')):
                        file_path = os.path.join(root, file)
                        try:
                            with open(file_path, 'r', encoding='utf-8') as f:
                                content = f.read()
                            
                            # Extract constexpr identifiers
                            for pattern in constexpr_patterns:
                                for match in pattern.finditer(content):
                                    identifier = match.group(1)
                                    value = match.group(2)
                                    self.constexpr_cache[identifier] = value

                            # Extract ALL string-returning functions using general patterns
                            # This replaces hardcoded function patterns
                            for pattern in general_function_patterns:
                                for match in pattern.finditer(content):
                                    func_name = match.group(1)
                                    func_value = match.group(2)

                                    # Try to determine namespace for the function
                                    namespace = self._extract_namespace_for_function(content, match.start())

                                    # Store with both simple name and qualified name
                                    self.function_cache[func_name] = func_value
                                    if namespace:
                                        qualified_name = f"{namespace}::{func_name}"
                                        self.function_cache[qualified_name] = func_value

                            # Legacy: Extract function definitions from hardcoded patterns (if any)
                            for func_name, patterns in function_patterns.items():
                                for pattern in patterns:
                                    match = pattern.search(content)
                                    if match:
                                        self.function_cache[func_name] = match.group(1)
                                        break
                            
                            files_processed += 1
                                    
                        except (FileNotFoundError, PermissionError, OSError, UnicodeDecodeError) as e:
                            logger.debug(f"Error reading {file_path} for cache: {e}")
                            continue
        
        self.is_built = True
        logger.debug(f"Built constexpr cache: {len(self.constexpr_cache)} identifiers, "
                    f"{len(self.function_cache)} functions from {files_processed} files")

    def _extract_namespace_for_function(self, content, position):
        """
        Extract the namespace at a given position in the file.

        Args:
            content (str): File content
            position (int): Position in the file

        Returns:
            str: Namespace (e.g., "model" or "config::tls")
        """
        # Look backwards from position to find namespace declaration
        preceding = content[:position]

        # Find all namespace declarations before this position
        namespace_pattern = re.compile(r'namespace\s+(\w+)\s*\{')
        namespaces = []

        for match in namespace_pattern.finditer(preceding):
            ns_name = match.group(1)
            # Check if we're still inside this namespace by tracking brace depth
            # Start with depth=1 (we entered the namespace with its opening brace)
            after_ns = content[match.end():position]
            brace_depth = 1

            for char in after_ns:
                if char == '{':
                    brace_depth += 1
                elif char == '}':
                    brace_depth -= 1
                    if brace_depth == 0:
                        # Namespace was closed before reaching current position
                        break

            if brace_depth > 0:
                # Still inside this namespace
                namespaces.append(ns_name)

        return '::'.join(namespaces) if namespaces else ''

    def lookup_constexpr(self, identifier):
        """
        Look up a constexpr identifier value from the cache.
        
        Args:
            identifier (str): The identifier to look up
            
        Returns:
            str or None: The resolved value if found, None otherwise
        """
        if not self.is_built:
            self.build_cache()
        
        return self.constexpr_cache.get(identifier)
    
    def lookup_function(self, function_name):
        """
        Look up a function call result from the cache.
        
        Args:
            function_name (str): The function name to look up
            
        Returns:
            str or None: The resolved value if found, None otherwise
        """
        if not self.is_built:
            self.build_cache()
        
        return self.function_cache.get(function_name)

# Global cache instance
_constexpr_cache = ConstexprCache()

# Global storage for type definitions (used by transformers for enum mapping)
_type_definitions_cache = {}

# Import topic property extractor
def find_redpanda_source():
    """
    Locate the Redpanda source directory by searching standard locations.
    
    The property extractor looks for the Redpanda source code in multiple
    locations to handle different execution contexts (project root, tools directory, etc.).
    
    Returns:
        str or None: Path to the Redpanda source directory if found, None otherwise.
    """
    redpanda_source_paths = [
        'tmp/redpanda',  # Current directory
        '../tmp/redpanda',  # Parent directory  
        'tools/property-extractor/tmp/redpanda',  # From project root
        os.path.join(os.getcwd(), 'tools', 'property-extractor', 'tmp', 'redpanda')
    ]
    
    for path in redpanda_source_paths:
        if os.path.exists(path):
            return path
    
    return None

def safe_arithmetic_eval(expression):
    """
    Safely evaluate simple arithmetic expressions like '60 * 5' without using eval().
    Only allows basic operators: +, -, *, /, //, %, and **
    Only works with integers and basic arithmetic.
    
    Returns the result if successful, raises ValueError if unsafe or invalid.
    """
    # Only allow safe characters: digits, spaces, and basic operators
    allowed_chars = set('0123456789+-*/%() ')
    if not all(c in allowed_chars for c in expression):
        raise ValueError("Expression contains unsafe characters")
    
    # Simple operator mapping for basic arithmetic
    ops = {
        '+': operator.add,
        '-': operator.sub,
        '*': operator.mul,
        '/': operator.truediv,
        '//': operator.floordiv,
        '%': operator.mod,
    }
    
    # For simple cases like "60 * 5", handle directly
    for op_str, op_func in ops.items():
        if op_str in expression:
            parts = expression.split(op_str)
            if len(parts) == 2:
                try:
                    left = int(parts[0].strip())
                    right = int(parts[1].strip())
                    return int(op_func(left, right))
                except (ValueError, ZeroDivisionError):
                    pass
    
    # If it's just a number, return it
    try:
        return int(expression.strip())
    except ValueError:
        pass
    
    raise ValueError("Could not safely evaluate expression")

try:
    from topic_property_extractor import TopicPropertyExtractor
except ImportError:
    # TopicPropertyExtractor not available, will skip topic property extraction
    TopicPropertyExtractor = None

# Import cloud configuration support
try:
    from cloud_config import fetch_cloud_config, add_cloud_support_metadata
    # Configure cloud_config logger to suppress INFO logs by default
    import logging
    logging.getLogger('cloud_config').setLevel(logging.WARNING)
except ImportError as e:
    # Cloud configuration support not available due to missing dependencies
    logging.warning(f"Cloud configuration support not available: {e}")
    fetch_cloud_config = None
    add_cloud_support_metadata = None

logger = logging.getLogger("viewer")


def process_enterprise_value(enterprise_str):
    """
    Convert a raw C++ "enterprise" expression into a JSON-friendly value.
    
    Accepts a string extracted from C++ sources and returns a value suitable for JSON
    serialization: a Python list for initializer-lists, a simple string for enum-like
    tokens, a boolean-like or quoted string unchanged, or a human-readable hint for
    lambda-based expressions.
    
    The function applies pattern matching in the following order (order is significant):
    1. std::vector<...>{...} initializer lists → Python list (quoted strings are unescaped,
       unqualified enum tokens are reduced to their final identifier).
    2. C++ scoped enum-like tokens (foo::bar::BAZ) → "BAZ".
    3. Lambda expressions (strings starting with "[](" and ending with "}") → a short
       human-readable hint such as "Enterprise feature enabled" or context-specific text.
    4. Simple literal values (e.g., "true", "false", "OIDC", or quoted strings) → returned as-is.
    
    Parameters:
        enterprise_str (str): Raw C++ expression text to be converted.
    
    Returns:
        Union[str, bool, list]: A JSON-serializable representation of the input.
    """
    enterprise_str = enterprise_str.strip()

    # FIRST: Handle std::vector initialization patterns (highest priority)
    # This must come before enum processing because vectors can contain enums
    # Tolerate optional whitespace around braces
    vector_match = VECTOR_PATTERN.match(enterprise_str)
    if vector_match:
        content = vector_match.group(1).strip()
        if not content:
            return []
        
        # Parse the content as a list of values
        values = []
        current_value = ""
        in_quotes = False
        
        for char in content:
            if char == '"' and (not current_value or current_value[-1] != '\\'):
                in_quotes = not in_quotes
                current_value += char
            elif char == ',' and not in_quotes:
                if current_value.strip():
                    # Clean up the value
                    value = current_value.strip()
                    if value.startswith('"') and value.endswith('"'):
                        values.append(ast.literal_eval(value))
                    else:
                        # Handle enum values in the vector
                        enum_match = ENUM_PATTERN.match(value)
                        if enum_match:
                            values.append(enum_match.group(1))
                        else:
                            values.append(value)
                current_value = ""
            else:
                current_value += char
        
        # Add the last value
        if current_value.strip():
            value = current_value.strip()
            if value.startswith('"') and value.endswith('"'):
                values.append(ast.literal_eval(value))
            else:
                # Handle enum values in the vector
                enum_match = ENUM_PATTERN.match(value)
                if enum_match:
                    values.append(enum_match.group(1))
                else:
                    values.append(value)
        
        return values
    
    # SECOND: Handle enum-like patterns (extract the last part after ::)
    enum_match = ENUM_PATTERN.match(enterprise_str)
    if enum_match:
        enum_value = enum_match.group(1)
        return enum_value
    
    # THIRD: Handle C++ lambda expressions - these usually indicate "any non-default value"
    if enterprise_str.startswith("[](") and enterprise_str.endswith("}"):
        # For lambda expressions, return a generic message
        # No hardcoded logic for specific properties
        return "Enterprise feature enabled"
    
    # FOURTH: Handle simple values with proper JSON types
    # Convert boolean literals to actual boolean values for JSON compatibility
    if enterprise_str == "true":
        return True
    elif enterprise_str == "false":
        return False
    elif enterprise_str == "OIDC" or enterprise_str.startswith('"'):
        return enterprise_str
    
    # Fallback: return the original value
    return enterprise_str


def resolve_cpp_function_call(function_name):
    """
    Resolve zero-argument C++ functions to their literal string return values.

    Uses the pre-built ConstexprCache which dynamically extracts ALL string-returning
    functions from source using general patterns. No hardcoded patterns needed.

    Parameters:
        function_name (str): Fully-qualified C++ function name to resolve (e.g., "model::kafka_audit_logging_topic")

    Returns:
        str or None: The literal string returned by the C++ function, or None if not found in cache
    """
    # Look up function in the pre-built cache
    # The cache was populated by ConstexprCache.build_cache() with general patterns
    # that automatically discover ALL string-returning functions
    cached_result = _constexpr_cache.lookup_function(function_name)
    if cached_result is not None:
        logger.debug(f"Resolved function '{function_name}' -> '{cached_result}' from cache")
        return cached_result

    # Also try without namespace qualifier (e.g., "kafka_audit_logging_topic")
    if '::' in function_name:
        simple_name = function_name.split('::')[-1]
        cached_result = _constexpr_cache.lookup_function(simple_name)
        if cached_result is not None:
            logger.debug(f"Resolved function '{function_name}' (as '{simple_name}') -> '{cached_result}' from cache")
            return cached_result

    logger.debug(f"Function '{function_name}' not found in cache")
    return None


def resolve_constexpr_identifier(identifier):
    """
    Resolve a constexpr identifier from Redpanda source code to its literal string value.

    Uses a cache to avoid repeated filesystem walks for better performance.
    Searches common Redpanda source locations for constexpr string or string_view definitions matching the given identifier and returns the literal if found.

    Parameters:
        identifier (str): The identifier name to resolve (e.g., "scram" or "net::tls_v1_2_cipher_suites").

    Returns:
        str or None: The resolved literal string value if found, otherwise `None`.
    """
    # Try cache lookup first (much faster)
    cached_result = _constexpr_cache.lookup_constexpr(identifier)
    if cached_result is not None:
        logger.debug(f"Resolved identifier '{identifier}' -> '{cached_result}' from cache")
        return cached_result

    # Fallback to original filesystem search for compatibility
    redpanda_source = find_redpanda_source()
    if not redpanda_source:
        logger.debug(f"Could not find Redpanda source directory to resolve identifier: {identifier}")
        return None

    # Strip namespace qualifier if present (e.g., "net::tls_v1_2_cipher_suites" -> "tls_v1_2_cipher_suites")
    search_identifier = identifier.split('::')[-1] if '::' in identifier else identifier
    
    # Pattern to match constexpr string_view definitions
    # Matches: inline constexpr std::string_view scram{"SCRAM"};
    patterns = [
        rf'inline\s+constexpr\s+std::string_view\s+{re.escape(search_identifier)}\s*\{{\s*"([^"]+)"\s*\}}',
        rf'constexpr\s+std::string_view\s+{re.escape(search_identifier)}\s*\{{\s*"([^"]+)"\s*\}}',
        rf'inline\s+constexpr\s+auto\s+{re.escape(search_identifier)}\s*=\s*"([^"]+)"',
        rf'constexpr\s+auto\s+{re.escape(search_identifier)}\s*=\s*"([^"]+)"',
        rf'static\s+constexpr\s+std::string_view\s+{re.escape(search_identifier)}\s*\{{\s*"([^"]+)"\s*\}}',
        rf'static\s+inline\s+constexpr\s+std::string_view\s+{re.escape(search_identifier)}\s*\{{\s*"([^"]+)"\s*\}}',
    ]

    # Pattern for multi-line concatenated string constants (like TLS cipher suites)
    # Matches: const std::string_view identifier = "line1"\n                                    "line2"\n...;
    multiline_pattern = rf'(?:const|extern\s+const)\s+std::string_view\s+{re.escape(search_identifier)}\s*=\s*((?:"[^"]*"\s*)+);'
    
    # Search recursively through the config directory and other common locations
    search_dirs = [
        os.path.join(redpanda_source, 'src', 'v', 'config'),
        os.path.join(redpanda_source, 'src', 'v', 'kafka'),
        os.path.join(redpanda_source, 'src', 'v', 'security'),
        os.path.join(redpanda_source, 'src', 'v', 'pandaproxy'),
        os.path.join(redpanda_source, 'src', 'v', 'net'),  # For TLS cipher suites and network constants
    ]
    
    for search_dir in search_dirs:
        if not os.path.exists(search_dir):
            continue
            
        # Walk through the directory recursively
        for root, dirs, files in os.walk(search_dir):
            for file in files:
                # Check both .h and .cc files since definitions can be in either
                if file.endswith(('.h', '.cc', '.hpp', '.cpp')):
                    file_path = os.path.join(root, file)
                    try:
                        with open(file_path, 'r', encoding='utf-8') as f:
                            content = f.read()
                        
                        # Try each single-line pattern first
                        for pattern in patterns:
                            match = re.search(pattern, content, re.MULTILINE)
                            if match:
                                resolved_value = match.group(1)
                                logger.debug(f"Resolved identifier '{identifier}' -> '{resolved_value}' from {file_path}")
                                return resolved_value

                        # Try multi-line concatenated string pattern (for TLS cipher suites, etc.)
                        multiline_match = re.search(multiline_pattern, content, re.MULTILINE | re.DOTALL)
                        if multiline_match:
                            # Extract all quoted strings and concatenate them
                            strings_section = multiline_match.group(1)
                            string_literals = re.findall(r'"([^"]*)"', strings_section)
                            if string_literals:
                                resolved_value = ''.join(string_literals)
                                logger.debug(f"Resolved multi-line identifier '{identifier}' -> '{resolved_value[:50]}...' from {file_path}")
                                return resolved_value
                                
                    except (FileNotFoundError, PermissionError, OSError, UnicodeDecodeError) as e:
                        logger.debug(f"Error reading {file_path}: {e}")
                        continue
    
    logger.debug(f"Could not resolve identifier: {identifier}")
    return None


def validate_paths(options):
    """
    Validate that required file-system paths referenced by `options` exist and exit the process on failure.
    
    Checks:
    - Verifies `options.path` exists; logs an error and exits with status code 1 if it does not.
    - If `options.definitions` is provided, verifies that file exists; logs an error and exits with status code 1 if it does not.
    
    Parameters:
        options: An object with at least the attributes:
            - path (str): Path to the input source directory or file.
            - definitions (Optional[str]): Path to the type definitions file (may be None or empty).
    """
    path = options.path

    if not os.path.exists(path):
        logger.error(f'Path does not exist: "{path}".')
        sys.exit(1)

    if options.definitions and not os.path.exists(options.definitions):
        logger.error(
            f'File with the type definitions not found: "{options.definitions}".'
        )
        sys.exit(1)


def get_file_pairs(options):
    path = Path(options.path)

    file_iter = path.rglob("*.h") if options.recursive else path.glob("*.h")

    file_pairs = []

    for i in file_iter:
        if os.path.exists(i.with_suffix(".cc")):
            file_pairs.append(FilePair(i.resolve(), i.with_suffix(".cc").resolve()))

    return file_pairs


def get_treesitter_cpp_parser_and_language(treesitter_dir, destination_path):
    if not os.path.exists(destination_path):
        build_treesitter_cpp_library(treesitter_dir, destination_path)

    cpp = Language(destination_path, "cpp")

    parser = Parser()
    parser.set_language(cpp)

    return parser, cpp


def get_files_with_properties(file_pairs, treesitter_parser, cpp_language):
    files_with_properties = []

    for fp in file_pairs:
        properties = extract_properties_from_file_pair(
            treesitter_parser, cpp_language, fp
        )
        implementation_value = str(fp.implementation)

        # List of file paths to check
        file_paths = [
            "src/v/config/configuration.cc",
            "src/v/config/node_config.cc",
            "src/v/kafka/client/configuration.cc",
            "src/v/pandaproxy/rest/configuration.cc",
            "src/v/pandaproxy/schema_registry/configuration.cc"
        ]

        # Check if any of the paths are in fp.implementation
        if any(path in implementation_value for path in file_paths):
            if len(properties) > 0:
                files_with_properties.append((fp, properties))

    

    return files_with_properties


def transform_files_with_properties(files_with_properties):
    type_transformer = TypeTransformer()

    # Initialize ConstantResolver for validator enum extraction
    redpanda_src = find_redpanda_source()
    constant_resolver = None
    if redpanda_src:
        src_v_path = Path(redpanda_src) / 'src' / 'v'
        if src_v_path.exists():
            constant_resolver = ConstantResolver(src_v_path)
            logger.debug(f"Initialized ConstantResolver with path: {src_v_path}")

    transformers = [
        EnterpriseTransformer(), ## this must be the first, as it modifies current data
        ParamNormalizerTransformer(),
        TypeTransformer(),
        MetaParamTransformer(),
        BasicInfoTransformer(),
        IsNullableTransformer(),
        IsArrayTransformer(type_transformer),
        NeedsRestartTransformer(),
        GetsRestoredTransformer(),
        VisibilityTransformer(),
        DeprecatedTransformer(),
        IsSecretTransformer(),
        ExampleTransformer(),
        NumericBoundsTransformer(type_transformer),
        DurationBoundsTransformer(type_transformer),
        SimpleDefaultValuesTransformer(),
        FriendlyDefaultTransformer(),
        ExperimentalTransformer(),
        AliasTransformer(),
    ]

    # Add enum extractors if we have a constant_resolver
    if constant_resolver:
        transformers.append(ValidatorEnumExtractor(constant_resolver))
        transformers.append(RuntimeValidationEnumExtractor(constant_resolver))

    all_properties = PropertyBag()

    for fp, properties in files_with_properties:
        for name in properties:
            # ignore private properties
            if UNDERSCORE_PREFIX_PATTERN.match(name):
                continue


            property_definition = PropertyBag()

            for transformer in transformers:
                if transformer.accepts(properties[name], fp):
                    transformer.parse(property_definition, properties[name], fp)

            # Skip experimental properties
            if property_definition.get('is_experimental_property'):
                continue

            if len(property_definition) > 0:
                all_properties[name] = property_definition

    return all_properties


def apply_transformers_to_topic_properties(topic_properties):
    """
    Apply transformers to topic properties that were extracted separately.
    This ensures topic properties get the same metadata as cluster properties.
    """
    if not topic_properties:
        return topic_properties
    
    type_transformer = TypeTransformer()
    transformers = [
        # Apply selected transformers that are relevant for topic properties
        NeedsRestartTransformer(),  # This is the key one we need for needs_restart field
        VisibilityTransformer(),
        DeprecatedTransformer(),
        IsSecretTransformer(),
        ExperimentalTransformer(),
        EnterpriseTransformer(),  # Need this to set is_enterprise field
    ]
    
    transformed_properties = PropertyBag()
    
    for prop_name, prop_data in topic_properties.items():
        property_definition = PropertyBag(prop_data)  # Start with existing data
        
        # Create a mock file path for topic properties
        mock_fp = "topic_properties"
        
        # Create a mock properties dict that transformers expect
        mock_properties = {prop_name: property_definition}
        
        for transformer in transformers:
            if transformer.accepts(property_definition, mock_fp):
                transformer.parse(property_definition, property_definition, mock_fp)

        # Skip experimental properties
        if property_definition.get('is_experimental_property'):
            continue

        transformed_properties[prop_name] = property_definition
    
    logging.info(f"Applied transformers to {len(transformed_properties)} topic properties")
    return transformed_properties


def filter_referenced_definitions(properties, definitions):
    """
    Filter definitions to only include types that are actually referenced by properties.

    Performs transitive closure: if type A references type B, both are included.
    This significantly reduces the size of the definitions section.

    Args:
        properties: Dict of property definitions
        definitions: Dict of all type definitions

    Returns:
        dict: Filtered definitions containing only referenced types
    """
    referenced = set()

    def collect_references(obj, visited=None):
        """Recursively collect type references from properties and definitions."""
        if visited is None:
            visited = set()

        if isinstance(obj, dict):
            # Check for $ref
            if '$ref' in obj:
                ref = obj['$ref']
                if ref.startswith('#/definitions/'):
                    type_name = ref.replace('#/definitions/', '')
                    if type_name not in visited:
                        referenced.add(type_name)
                        visited.add(type_name)
                        # Recursively collect references from this definition
                        if type_name in definitions:
                            collect_references(definitions[type_name], visited)

            # Check for c_type
            if 'c_type' in obj:
                type_name = obj['c_type']
                if type_name and type_name in definitions and type_name not in visited:
                    referenced.add(type_name)
                    visited.add(type_name)
                    collect_references(definitions[type_name], visited)

            # Recurse into nested objects
            for value in obj.values():
                collect_references(value, visited)

        elif isinstance(obj, list):
            for item in obj:
                collect_references(item, visited)

    # Collect all references from properties
    collect_references(properties)

    # Filter definitions to only referenced types
    filtered = {k: v for k, v in definitions.items() if k in referenced}

    logger.info(f"📉 Filtered definitions from {len(definitions)} to {len(filtered)} (only referenced types)")

    return filtered


def clean_private_fields_from_definitions(definitions):
    """
    Remove private fields (those starting with _) from definition properties.
    This keeps the JSON output clean by only exposing public API.

    Args:
        definitions: Dictionary of type definitions

    Returns:
        Dictionary with private fields filtered out
    """
    cleaned = {}
    total_private_fields = 0

    for def_name, def_data in definitions.items():
        if 'properties' in def_data and def_data['properties']:
            # Filter out fields starting with underscore
            original_props = def_data['properties']
            cleaned_props = {k: v for k, v in original_props.items() if not k.startswith('_')}

            private_count = len(original_props) - len(cleaned_props)
            total_private_fields += private_count

            # Only include definitions that have at least one public field
            if cleaned_props:
                cleaned[def_name] = {**def_data, 'properties': cleaned_props}
        else:
            # Keep definitions without properties (like enums)
            cleaned[def_name] = def_data

    if total_private_fields > 0:
        logger.info(f"🧹 Cleaned {total_private_fields} private fields from definitions")

    return cleaned


# The definitions.json file contains type definitions that the extractor uses to standardize and centralize type information. After extracting and transforming the properties from the source code, the function merge_properties_and_definitions looks up each property's type in the definitions. If a property's type (or the type of its items, in the case of arrays) matches one of the definitions, the transformer replaces that type with a JSON pointer ( such as #/definitions/<type>) to the corresponding entry in definitions.json. The final JSON output then includes both a properties section (with types now referencing the definitions) and a definitions section, so that consumers of the output can easily resolve the full type information.
def merge_properties_and_definitions(properties, definitions):
    # Do not overwrite the resolved type/default with a reference. Just return the resolved properties and definitions.
    return dict(properties=properties, definitions=definitions)


def apply_property_overrides(properties, overrides, overrides_file_path=None):
    """
    Apply overrides from an overrides mapping to the extracted properties, mutating and returning the properties dictionary.
    
    Processes entries in overrides["properties"]; for each override key the function:
    - If the key matches a property dictionary key, applies the override to that property.
    - Otherwise, searches existing properties for an entry whose `"name"` equals the override key and applies the override if found.
    - If no matching property is found, creates a new property from the override and adds it under the override key.
    
    The function supports overrides that add or replace description, version, example content, default, type, config_scope, related_topics, and other metadata. When examples reference external files, relative paths are resolved relative to overrides_file_path.
    
    Parameters:
        properties (dict): Mapping of existing property entries (modified in-place).
        overrides (dict): Loaded overrides structure; only keys under "properties" are processed.
        overrides_file_path (str|None): Filesystem path of the overrides file used to resolve relative example_file references.
    
    Returns:
        dict: The same properties mapping with overrides applied and any new properties created.
    """
    if overrides and "properties" in overrides:
        for prop, override in overrides["properties"].items():
            # First check if property exists by key
            if prop in properties:
                # Apply overrides to existing properties
                _apply_override_to_existing_property(properties[prop], override, overrides_file_path)
            else:
                # Check if property exists by name field (handles cases where key != name)
                existing_property_key = None
                for key, property_data in properties.items():
                    if hasattr(property_data, 'get') and property_data.get('name') == prop:
                        existing_property_key = key
                        break
                
                if existing_property_key:
                    # Found existing property by name, apply overrides to it
                    logger.info(f"Applying override to existing property '{prop}' (found by name, key='{existing_property_key}')")
                    _apply_override_to_existing_property(properties[existing_property_key], override, overrides_file_path)
                else:
                    # Create new property from override
                    logger.info(f"Creating new property from override: {prop}")
                    properties[prop] = _create_property_from_override(prop, override, overrides_file_path)
    return properties


def _apply_override_to_existing_property(property_dict, override, overrides_file_path):
    """Apply overrides to an existing property."""
    # Apply description override
    if "description" in override:
        property_dict["description"] = override["description"]
    
    # Apply version override (introduced in version)
    if "version" in override:
        property_dict["version"] = override["version"]
    
    # Apply example override with multiple input format support
    example_content = _process_example_override(override, overrides_file_path)
    if example_content:
        property_dict["example"] = example_content
    
    # Apply default override
    if "default" in override:
        property_dict["default"] = override["default"]
    
    # Apply type override
    if "type" in override:
        property_dict["type"] = override["type"]
    
    # Apply config_scope override
    if "config_scope" in override:
        property_dict["config_scope"] = override["config_scope"]
    
    # Apply related_topics override
    if "related_topics" in override:
        if isinstance(override["related_topics"], list):
            property_dict["related_topics"] = override["related_topics"]
        else:
            logger.warning(f"related_topics for property must be an array")

    # Apply exclude_from_docs override
    if "exclude_from_docs" in override:
        property_dict["exclude_from_docs"] = override["exclude_from_docs"]

    # Apply category override for topic properties
    if "category" in override:
        property_dict["category"] = override["category"]


def _create_property_from_override(prop_name, override, overrides_file_path):
    """Create a new property from override specification."""
    # Create base property structure
    new_property = {
        "name": prop_name,
        "description": override.get("description", f"Configuration property: {prop_name}"),
        "type": override.get("type", "string"),
        "default": override.get("default", None),
        "defined_in": "override",  # Mark as override-created
        "config_scope": override.get("config_scope", "topic"),  # Default to topic for new properties
        "is_topic_property": override.get("config_scope", "topic") == "topic",
        "is_deprecated": override.get("is_deprecated", False),
        "visibility": override.get("visibility", "user")
    }
    
    # Add version if specified
    if "version" in override:
        new_property["version"] = override["version"]
    
    # Add example if specified
    example_content = _process_example_override(override, overrides_file_path)
    if example_content:
        new_property["example"] = example_content
    
    # Add related_topics if specified
    if "related_topics" in override:
        if isinstance(override["related_topics"], list):
            new_property["related_topics"] = override["related_topics"]
        else:
            logger.warning(f"related_topics for property '{prop_name}' must be an array")
    
    # Add any other custom fields from override
    for key, value in override.items():
        if key not in ["description", "type", "default", "config_scope", "version", 
                       "example", "example_file", "example_yaml", "related_topics", 
                       "is_deprecated", "visibility"]:
            new_property[key] = value

    # Add exclude_from_docs if specified
    if "exclude_from_docs" in override:
        new_property["exclude_from_docs"] = override["exclude_from_docs"]

    # Add category if specified
    if "category" in override:
        new_property["category"] = override["category"]
    
    return new_property


def _process_example_override(override, overrides_file_path=None):
    """
    Process example overrides in various user-friendly formats.
    
    Supports multiple input formats for examples:
    1. Direct string: "example": "content"
    2. Multi-line array: "example": ["line1", "line2", ...]
    3. External file: "example_file": "path/to/file"
    4. Auto-formatted YAML: "example_yaml": {...}
    
    Args:
        override: Dictionary containing override data for a property
        overrides_file_path: Path to the overrides file (for resolving relative paths)
    
    Returns:
        Processed AsciiDoc example content as string, or None if no example found
    """
    # Format 1: Direct AsciiDoc string
    if "example" in override:
        example = override["example"]
        if isinstance(example, str):
            return example
        elif isinstance(example, list):
            # Format 2: Multi-line array - join with newlines
            return "\n".join(example)
    
    # Format 3: External file reference
    if "example_file" in override:
        file_path = override["example_file"]
        
        # Support both absolute and relative paths
        if not os.path.isabs(file_path):
            # Build search paths starting with the overrides file directory
            search_paths = []
            
            # If we have the overrides file path, try relative to its directory first
            if overrides_file_path:
                overrides_dir = os.path.dirname(overrides_file_path)
                search_paths.append(os.path.join(overrides_dir, file_path))
            
            # Then try common locations relative to current working directory
            search_paths.extend([
                file_path,
                os.path.join("examples", file_path),
                os.path.join("docs-data", file_path),
                os.path.join("__tests__", "docs-data", file_path)
            ])
            
            found_path = None
            for search_path in search_paths:
                if os.path.exists(search_path):
                    found_path = search_path
                    break
            
            if found_path:
                file_path = found_path
            else:
                logger.warning(f"Example file not found: {override['example_file']}")
                logger.warning(f"Searched in: {', '.join(search_paths)}")
                return None
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return f.read().strip()
        except Exception as e:
            logger.error(f"Error reading example file {file_path}: {e}")
            return None
    
    # Format 4: Auto-formatted YAML configuration
    if "example_yaml" in override:
        yaml_data = override["example_yaml"]
        title = yaml_data.get("title", "Example")
        description = yaml_data.get("description", "")
        config = yaml_data.get("config", {})
        
        # Build AsciiDoc content
        lines = [f".{title}"]
        if description:
            lines.append(f"{description}\n")
        
        lines.extend([
            "[,yaml]",
            "----"
        ])
        
        # Convert config to YAML and add to lines
        try:
            yaml_content = yaml.dump(config, default_flow_style=False, indent=2)
            lines.append(yaml_content.rstrip())
        except Exception as e:
            import traceback
            logger.error(f"Error formatting YAML config: {e}")
            logger.debug(f"Full traceback:\n{traceback.format_exc()}")
            return None
        
        lines.append("----")
        
        return "\n".join(lines)
    
    return None


def add_config_scope(properties):
    """
    Add a config_scope field to each property based on its defined_in value or property type.
    'cluster' if defined_in == src/v/config/configuration.cc
    'broker' if defined_in == src/v/config/node_config.cc
    'topic' if is_topic_property == True
    
    For override-created properties, preserve existing config_scope if already set.
    """
    for prop in properties.values():
        # Check if this is a topic property first
        if prop.get("is_topic_property", False):
            prop["config_scope"] = "topic"
        else:
            # Skip config_scope assignment if it's already been set by an override
            if prop.get("config_scope") is not None:
                # Keep the existing config_scope from override or previous assignment
                pass
            else:
                defined_in = prop.get("defined_in", "")
                if defined_in == "src/v/config/configuration.cc":
                    prop["config_scope"] = "cluster"
                elif defined_in in ["src/v/config/node_config.cc", 
                                    "src/v/pandaproxy/rest/configuration.cc",
                                    "src/v/kafka/client/configuration.cc", 
                                    "src/v/pandaproxy/schema_registry/configuration.cc"]:
                    prop["config_scope"] = "broker"
                else:
                    prop["config_scope"] = None
    return properties


def map_enum_defaults(properties):
    """
    Map enum default values to their user-facing strings using enum_string_mappings.

    This runs after resolve_type_and_default() when enum constraints have been populated.
    For properties with enum constraints, if the default value is not in the enum list,
    check if it matches a raw enum value in the type definitions and map it to the
    user-facing string representation.

    Args:
        properties (dict): Properties with resolved types and enum constraints

    Returns:
        dict: Properties with mapped enum default values
    """
    global _type_definitions_cache

    if not _type_definitions_cache:
        return properties

    for prop_name, prop in properties.items():
        # Skip if not an enum property or no default
        if not prop.get("enum") or "default" not in prop:
            continue

        default = prop.get("default")
        enum_values = prop.get("enum", [])

        # Skip if default is None or already in the enum list
        if default is None or default in enum_values:
            continue

        # Check if default is a raw enum value that needs mapping
        if not isinstance(default, str):
            continue

        # Search type definitions for matching enum with string mappings
        for type_name, type_def in _type_definitions_cache.items():
            if type_def.get("type") != "enum":
                continue

            mappings = type_def.get("enum_string_mappings")
            if not mappings:
                continue

            # If we find a mapping for this default value, apply it
            if default in mappings:
                mapped_value = mappings[default]
                prop["default"] = mapped_value
                logger.debug(f"✓ Mapped enum default for {prop_name}: {default} → {mapped_value}")
                break

    return properties


def format_time_human_readable(value, unit):
    """
    Convert a numeric time value to a human-readable string.

    Args:
        value: Numeric value (int)
        unit: 'ms' for milliseconds, 's' for seconds

    Returns:
        Human-readable string like "7 days", "1 hour", "30 minutes"
    """
    # Convert to milliseconds for uniform handling
    if unit == 's':
        ms = value * 1000
    else:
        ms = value

    # Time unit thresholds in milliseconds
    units = [
        (365 * 24 * 60 * 60 * 1000, 'year', 'years'),
        (7 * 24 * 60 * 60 * 1000, 'week', 'weeks'),
        (24 * 60 * 60 * 1000, 'day', 'days'),
        (60 * 60 * 1000, 'hour', 'hours'),
        (60 * 1000, 'minute', 'minutes'),
        (1000, 'second', 'seconds'),
        (1, 'millisecond', 'milliseconds'),
    ]

    # Try to find the largest unit that divides evenly
    for threshold, singular, plural in units:
        if ms >= threshold and ms % threshold == 0:
            count = ms // threshold
            unit_name = singular if count == 1 else plural
            return f"{int(count)} {unit_name}"

    # If no clean division, return the original with units
    if unit == 's':
        return f"{value} seconds"
    else:
        return f"{value} milliseconds"


def evaluate_chrono_expressions(properties):
    """
    Evaluate chrono expressions in default values and convert to numeric values.
    Also adds human-readable versions for better UX in templates.

    Examples:
    - "24h * 365" -> 31536000000 (for milliseconds) + "365 days"
    - "7 * 24h" -> 604800 (for seconds) + "7 days"
    - "1h" -> 3600000 (for milliseconds) or 3600 (for seconds) + "1 hour"

    Conversion factors:
    - ms (milliseconds): 1
    - s (seconds): 1000 ms
    - min (minutes): 60000 ms
    - h (hours): 3600000 ms
    - d (days): 86400000 ms
    """
    import re

    # Conversion factors to milliseconds
    time_units = {
        'ms': 1,
        's': 1000,
        'min': 60 * 1000,
        'h': 60 * 60 * 1000,
        'd': 24 * 60 * 60 * 1000,
    }

    def parse_time_value(expr):
        """Parse a time expression like '24h' or '365' and return milliseconds."""
        expr = expr.strip()

        # Try to match number with unit suffix
        match = re.match(r'^(\d+(?:\.\d+)?)(ms|s|min|h|d)?$', expr)
        if match:
            value = float(match.group(1))
            unit = match.group(2) if match.group(2) else None

            if unit:
                return value * time_units[unit]
            else:
                # Bare number - assume it's already in target units
                return value

        return None

    def evaluate_expression(expr_str):
        """Evaluate a simple mathematical expression with time units."""
        expr_str = expr_str.strip()

        # Handle simple cases first (just a time value)
        simple_value = parse_time_value(expr_str)
        if simple_value is not None:
            return simple_value

        # Handle expressions like "24h * 365" or "7 * 24h"
        # Replace time values with their millisecond equivalents
        tokens = re.split(r'(\s*[*/+\-]\s*)', expr_str)
        evaluated_tokens = []

        for token in tokens:
            token = token.strip()
            if not token:
                continue

            # Check if it's an operator
            if token in ['*', '/', '+', '-']:
                evaluated_tokens.append(token)
            else:
                # Try to parse as time value
                value = parse_time_value(token)
                if value is not None:
                    evaluated_tokens.append(str(value))
                else:
                    # Not a time value, keep as is
                    evaluated_tokens.append(token)

        # Evaluate the expression
        try:
            result = eval(' '.join(evaluated_tokens))
            return result
        except:
            return None

    converted_count = 0

    for prop_name, prop in properties.items():
        default = prop.get('default')
        c_type = prop.get('c_type', '')

        # Only process string defaults with chrono types
        if not isinstance(default, str):
            continue

        # Check if it's a chrono type or looks like a time expression
        is_chrono = 'chrono' in c_type or 'duration' in c_type.lower()
        has_time_expr = any(unit in default for unit in ['ms', 's', 'min', 'h', 'd']) or any(op in default for op in ['*', '+', '-', '/'])

        if not (is_chrono or has_time_expr):
            continue

        # Try to evaluate the expression
        result_ms = evaluate_expression(default)

        if result_ms is not None:
            # Convert to appropriate output unit based on type
            unit = 'ms'  # Track which unit we're using for human-readable format

            if 'std::chrono::milliseconds' in c_type:
                result = int(result_ms)
                unit = 'ms'
            elif 'std::chrono::seconds' in c_type:
                result = int(result_ms / 1000)
                unit = 's'
            elif 'std::chrono::minutes' in c_type:
                result = int(result_ms / 60000)
                unit = 'min'
            elif 'std::chrono::hours' in c_type:
                result = int(result_ms / 3600000)
                unit = 'h'
            elif 'duration' in c_type.lower():
                # Assume milliseconds for generic duration types
                result = int(result_ms)
                unit = 'ms'
            else:
                # Default to milliseconds
                result = int(result_ms)
                unit = 'ms'

            prop['default'] = result

            # Add human-readable version for templates
            human_readable = format_time_human_readable(result, unit)
            prop['default_human_readable'] = human_readable

            converted_count += 1
            logger.debug(f"Evaluated chrono expression for {prop_name}: '{default}' -> {result} ({human_readable})")

    if converted_count > 0:
        logger.info(f"Evaluated {converted_count} chrono expressions in default values")

    return properties


def resolve_type_with_namespace(type_name, definitions):
    """
    Resolve a type name, trying with namespace prefixes if not found directly.

    Args:
        type_name: Type name to resolve (may be unqualified)
        definitions: Dictionary of type definitions

    Returns:
        The definition dict if found, or {} if not found
    """
    # Try the type name as-is first
    if type_name in definitions:
        return definitions[type_name]

    # Try common namespace prefixes
    common_namespaces = ['config', 'model', 'security', 'net', 'kafka', 'pandaproxy']
    for namespace in common_namespaces:
        qualified_name = f"{namespace}::{type_name}"
        if qualified_name in definitions:
            return definitions[qualified_name]

    # Not found
    return {}


def resolve_type_and_default(properties, definitions):
    """
    Normalize property types and expand C++-style default values into JSON-compatible Python structures.

    ============================================================================
    TYPE RESOLUTION SYSTEM - How C++ Types Become JSON Schema Types
    ============================================================================

    This function bridges C++ type system with JSON Schema by:
    1. Resolving definition references ($ref pointers) to actual type structures
    2. Expanding C++ constructors into JSON-compatible default values
    3. Ensuring type consistency between properties and their defaults
    4. Handling special array/optional type patterns from Redpanda source

    TYPE RESOLUTION FLOW:
    ┌─────────────────────────────────────────────────────────────────────────
    │ C++ Source:
    │   property<model::broker_endpoint> admin(...,
    │     model::broker_endpoint(net::unresolved_address("127.0.0.1", 9644))
    │   )
    │
    │ ↓ TypeTransformer (transformers.py)
    │   type: "broker_endpoint"  (extracted from template parameter)
    │   default: "model::broker_endpoint(net::unresolved_address(\"127.0.0.1\", 9644))"
    │
    │ ↓ Definition Lookup (definitions dict)
    │   definitions["broker_endpoint"] = {
    │     "type": "object",
    │     "properties": {"address": {"type": "string"}, "port": {"type": "integer"}}
    │   }
    │
    │ ↓ Constructor Expansion (this function)
    │   type: "object"  (resolved from definition)
    │   default: {"address": "127.0.0.1", "port": 9644}  (expanded constructor)
    │
    │ ↓ JSON Output:
    │   "admin": {
    │     "type": "object",
    │     "properties": {...},
    │     "default": {"address": "127.0.0.1", "port": 9644}
    │   }
    └─────────────────────────────────────────────────────────────────────────

    DEFINITION SYSTEM - Reusable Type Structures:
    ┌─────────────────────────────────────────────────────────────────────────
    │ Purpose: Definitions centralize complex type information to avoid
    │          repeating structure across multiple properties.
    │
    │ Source: definitions.json contains hand-crafted JSON Schema definitions
    │         for Redpanda's C++ types (endpoints, durations, enums, etc.)
    │
    │ Usage in Properties:
    │   Before resolution:  type: "broker_endpoint"
    │   After resolution:   type: "object" + properties from definition
    │
    │ $ref Pointers:
    │   Some definitions use JSON Schema $ref to reference other definitions:
    │   {"$ref": "#/definitions/compression"} → resolve recursively
    │
    │ Definition Structure:
    │   {
    │     "compression": {
    │       "type": "string",
    │       "enum": ["gzip", "snappy", "lz4", "zstd", "none"]
    │     },
    │     "broker_endpoint": {
    │       "type": "object",
    │       "properties": {
    │         "address": {"type": "string"},
    │         "port": {"type": "integer"}
    │       }
    │     }
    │   }
    └─────────────────────────────────────────────────────────────────────────

    CONSTRUCTOR EXPANSION - C++ to JSON Conversion:
    ┌─────────────────────────────────────────────────────────────────────────
    │ SIMPLE PRIMITIVES:
    │   C++: 9092                    → JSON: 9092
    │   C++: "localhost"             → JSON: "localhost"
    │   C++: true                    → JSON: true
    │
    │ ENUM VALUES:
    │   C++: model::compression::gzip  → JSON: "gzip"
    │   Pattern: namespace::type::value → Extract final value
    │
    │ CONSTRUCTORS:
    │   C++: net::unresolved_address("127.0.0.1", 9644)
    │   → Parse: type=unresolved_address, args=["127.0.0.1", 9644]
    │   → Lookup definition for "unresolved_address"
    │   → Match args to definition properties by position
    │   → Result: {"address": "127.0.0.1", "port": 9644}
    │
    │ ARRAYS:
    │   C++: std::vector<int>{1, 2, 3}  → JSON: [1, 2, 3]
    │   C++: {1, 2, 3}                  → JSON: [1, 2, 3]
    │   Special: one_or_many_property wraps single values in arrays
    │
    │ CHRONO DURATIONS:
    │   C++: std::chrono::seconds{30}   → JSON: 30 (with units in description)
    │   C++: std::chrono::milliseconds{5000} → JSON: 5000
    │
    │ OPTIONAL TYPES:
    │   C++: std::optional<int>{}       → JSON: null
    │   C++: std::optional<int>{42}     → JSON: 42
    └─────────────────────────────────────────────────────────────────────────

    SPECIAL HANDLING:
    ┌─────────────────────────────────────────────────────────────────────────
    │ one_or_many_property<T>:
    │   - Always treated as array type in JSON
    │   - Single default values are wrapped: {x:1} → [{x:1}]
    │   - Already-array defaults preserved: [{x:1}] → [{x:1}]
    │
    │ Array Items Type Resolution:
    │   - If items.type references a definition, resolve it:
    │     items.type: "endpoint_tls_config" → items: {...definition...}
    │   - Ensures array item validation has full type information
    │
    │ Enterprise Values:
    │   - enterprise_value strings expanded via process_enterprise_value()
    │   - Converts license restriction patterns to user-friendly strings
    └─────────────────────────────────────────────────────────────────────────

    HOW TO ADD NEW TYPE DEFINITIONS:
    1. Identify the C++ type that needs a definition (e.g., new_endpoint_type)
    2. Analyze the C++ struct/class to determine JSON schema structure
    3. Add entry to definitions.json with appropriate JSON Schema:
       {
         "new_endpoint_type": {
           "type": "object",
           "properties": {"field1": {"type": "string"}, "field2": {"type": "integer"}}
         }
       }
    4. TypeTransformer will automatically extract the type name from C++
    5. This function will look up the definition and expand constructors
    6. Test with a property using the new type to verify expansion

    Parameters:
        properties (dict): Property name → metadata dict with keys: "type", "default",
                          "items", "enterprise_value" that will be modified in-place
        definitions (dict): Type name → JSON Schema definition used for lookups
                           and constructor expansion

    Returns:
        dict: The same `properties` dict after in-place type normalization and
              default value expansion
    """
    import ast
    import re

    def resolve_definition_type(defn):
        """Recursively resolve $ref pointers to get the actual type definition."""
        while isinstance(defn, dict) and "$ref" in defn:
            ref = defn["$ref"]
            ref_name = ref.split("/")[-1]
            defn = definitions.get(ref_name, defn)
        return defn

    def parse_constructor(s):
        """
        Parse a C++-style constructor or initializer expression into its type name and argument list.
        
        Parses input forms such as `Type(arg1, arg2)`, `Type{arg1, arg2}`, or plain literals/enum-like tokens. For string literals the returned argument is a Python string value; for integer literals the returned argument is an int. Nested constructors and nested brace/paren groups are preserved as argument tokens.
        
        Parameters:
            s (str): The C++ expression to parse.
        
        Returns:
            tuple:
                - type_name (str|None): The parsed type name for constructor forms, or `None` when `s` is a primitive literal or enum-like token.
                - args (list): A list of argument tokens; tokens are raw strings for complex/nested arguments, Python `str` for quoted string literals, or `int` for integer literals.
        """
        s = s.strip()
        original_s = s
        if s.startswith("{") and s.endswith("}"):
            s = s[1:-1].strip()

        match = CONSTRUCTOR_PATTERN.match(s)
        if match:
            type_name, arg_str = match.groups()
        else:
            match = BRACED_CONSTRUCTOR_PATTERN.match(s)
            if match:
                type_name, arg_str = match.groups()
            else:
                if s.startswith('"') and s.endswith('"'):
                    return None, [ast.literal_eval(s)]
                try:
                    return None, [int(s)]
                except ValueError:
                    return None, [s]
        
        args = []
        depth = 0
        current = ''
        in_string = False
        for c in arg_str:
            if c == '"' and (not current or current[-1] != '\\'):
                in_string = not in_string
            if c == ',' and depth == 0 and not in_string:
                if current.strip():
                    args.append(current.strip())
                current = ''
            else:
                if c in '({' and not in_string:
                    depth += 1
                elif c in ')}' and not in_string:
                    depth -= 1
                current += c
        if current.strip():
            args.append(current.strip())
        return type_name, args

    def process_cpp_patterns(arg_str):
        """
        Convert a C++-style expression string into a JSON-friendly literal representation.

        This function recognises common C++ patterns produced by the extractor and maps them to values suitable for JSON schema defaults and examples. Handled cases include:
        - std::nullopt -> null
        - zero-argument functions (e.g., model::kafka_audit_logging_topic()) resolved from source when possible
        - enum tokens (e.g., fips_mode_flag::disabled -> "disabled")
        - constexpr identifiers and simple string constructors resolved to their literal strings when available
        - known default constructors and truncated type names mapped to sensible defaults (e.g., duration -> 0, path -> "")
        - simple heuristics for unknown constructors and concatenated expressions

        Returns:
            processed (str): A string representing the JSON-ready value (for example: '"value"', 'null', '0', or the original input when no mapping applied).
        """
        arg_str = arg_str.strip()
        # Remove C++ digit separators (apostrophes) that may appear in numeric literals
        # Example: "30'000ms" -> "30000ms"
        arg_str = DIGIT_SEPARATOR_PATTERN.sub('', arg_str)

        if arg_str == "std::nullopt" or arg_str == "nullopt":
            return "null"

        # Dynamically resolve C++ function calls by looking up their return values in source
        function_call_match = FUNCTION_CALL_PATTERN.match(arg_str)
        if function_call_match:
            function_name = function_call_match.group(1)
            resolved_value = resolve_cpp_function_call(function_name)
            if resolved_value is not None:
                return f'"{resolved_value}"'

        chrono_match = CHRONO_PATTERN.match(arg_str)
        if chrono_match:
            unit = chrono_match.group(1)
            value = chrono_match.group(2)
            unit_map = {
                'hours': 'h',
                'minutes': 'min',
                'seconds': 's',
                'milliseconds': 'ms',
                'microseconds': 'us',
                'nanoseconds': 'ns'
            }
            short = unit_map.get(unit.lower(), unit)
            return f'"{value} {short}"'
        
        # Handle chrono literals with parentheses like chrono::milliseconds(5min) -> "5 minutes"
        chrono_paren_match = CHRONO_PAREN_PATTERN.match(arg_str)
        if chrono_paren_match:
            unit = chrono_paren_match.group(1)
            value = chrono_paren_match.group(2).strip()
            
            inner_time_match = TIME_UNIT_PATTERN.match(value)
            if inner_time_match:
                num, suffix = inner_time_match.groups()
                inner_unit_map = {
                    "min": "minute",
                    "s": "second",
                    "ms": "millisecond",
                    "h": "hour",
                }
                base = inner_unit_map.get(suffix, suffix)
                if num != "1" and not base.endswith("s"):
                    base = base + "s"
                return f'"{num} {base}"'

            # Evaluate arithmetic in duration constructors (e.g., "60 * 5" -> "300 seconds")
            if "*" in value:
                try:
                    result = safe_arithmetic_eval(value)
                    unit_map = {
                        'hours': 'hour',
                        'minutes': 'minute',
                        'seconds': 'second',
                        'milliseconds': 'millisecond',
                        'microseconds': 'microsecond',
                        'nanoseconds': 'nanosecond'
                    }
                    base = unit_map.get(unit.lower(), unit)
                    if result != 1 and not base.endswith("s"):
                        base = base + "s"
                    return f'"{result} {base}"'
                except (ValueError, Exception):
                    pass

            try:
                num = int(value)
                unit_map = {
                    'hours': 'hour',
                    'minutes': 'minute',
                    'seconds': 'second',
                    'milliseconds': 'millisecond',
                    'microseconds': 'microsecond',
                    'nanoseconds': 'nanosecond'
                }
                base = unit_map.get(unit.lower(), unit)
                if num != 1 and not base.endswith("s"):
                    base = base + "s"
                return f'"{num} {base}"'
            except ValueError:
                return f'"{value} {unit}"'

        address_match = ADDRESS_PATTERN.match(arg_str)
        if address_match:
            addr = address_match.group(1).strip().strip('"')
            port = address_match.group(2).strip()
            try:
                port_val = int(port)
                return f'"{addr}:{port_val}"'
            except ValueError:
                return f'"{addr}:{port}"'

        keyval_match = KEYVAL_PATTERN.match(arg_str)
        if keyval_match:
            key = keyval_match.group(1)
            value = keyval_match.group(2)
            processed_value = process_cpp_patterns(value)
            if processed_value.startswith('"') and processed_value.endswith('"'):
                processed_value = processed_value[1:-1]
            return processed_value
        
        # Extract enum value from qualified identifiers (fips_mode_flag::disabled -> "disabled")
        # ENUM_PATTERN uses anchors to avoid matching constructor syntax (config::type{})
        enum_match = ENUM_PATTERN.match(arg_str)
        if enum_match:
            enum_value = enum_match.group(1)
            return f'"{enum_value}"'

        # Resolve constexpr identifiers by looking up their values in source files
        if IDENTIFIER_PATTERN.match(arg_str):
            resolved_value = resolve_constexpr_identifier(arg_str)
            if resolved_value is not None:
                return f'"{resolved_value}"'

        sstring_match = SSTRING_PATTERN.match(arg_str)
        if sstring_match:
            identifier = sstring_match.group(1)
            resolved_value = resolve_constexpr_identifier(identifier)
            if resolved_value is not None:
                return f'"{resolved_value}"'
            else:
                return f'"{identifier}"'

        # Map C++ default constructors to their runtime values
        # These patterns are derived from analyzing the C++ source implementations
        constructor_patterns = {
            r'config::leaders_preference\{\}': '"none"',  # type_t::none is default
            r'std::chrono::seconds\{0\}': '0',
            r'std::chrono::milliseconds\{0\}': '0',
            r'model::timeout_clock::duration\{\}': '0',
            r'config::data_directory_path\{\}': '""',
            r'std::optional<[^>]+>\{\}': 'null',
        }

        for pattern, replacement in constructor_patterns.items():
            if re.match(pattern, arg_str):
                return replacement

        # Fallback mappings for truncated type names (tree-sitter may truncate constructors)
        truncated_patterns = {
            'leaders_preference': '"none"',
            'data_directory_path': '""',
            'timeout_clock_duration': '0',
            'log_level': '"info"',
            'compression_type': '"none"',
        }

        if arg_str in truncated_patterns:
            return truncated_patterns[arg_str]

        generic_constructor_match = re.match(r'[a-zA-Z0-9_:]+\{\}', arg_str)
        if generic_constructor_match:
            # For unknown constructors, try to infer a reasonable default
            type_name = arg_str[:-2]  # Remove the {}
            if 'duration' in type_name.lower() or 'time' in type_name.lower():
                return '0'
            elif 'path' in type_name.lower() or 'directory' in type_name.lower():
                return '""'
            elif 'optional' in type_name.lower():
                return 'null'
            else:
                return '""'  # Conservative default to empty string
        
        # Handle string concatenation with + operator (such as "128_kib + 1")
        if " + " in arg_str:
            return f'"{arg_str}"'
        
        return arg_str

    def expand_default(type_name, default_str):
        """
        Convert a C++-style default initializer into a JSON-serializable Python value.
        
        This expands C++ constructor and initializer-list syntax into Python primitives, dictionaries, and lists suitable for JSON output. Supported transformations include:
        - String constructors and quoted literals → Python str.
        - Integer and boolean literals → Python int and bool.
        - Object constructors (Type(arg1, arg2) or Type{...}) → dict mapping constructor arguments to the object's properties when a corresponding type definition exists.
        - Nested constructors → nested dicts with their fields expanded.
        - Array initializer lists (e.g., {Type(...), Type(...)}) → Python list with each element expanded.
        - Special-case mappings for known type patterns (for example, an address-type constructor expanded into {"address", "port"} when the target type expects that shape).
        If a default cannot be resolved or the type is an enum, the original input is returned unchanged; the string "null" is converted to None. If default_str is not a string, it is returned as-is.
        
        Parameters:
            type_name (str): The resolved type name for the default value (e.g., "model::broker_endpoint" or a primitive type like "string").
            default_str (str | any): The C++ default expression to expand, or a non-string value already decoded.
        
        Returns:
            The expanded Python representation of the default: a dict for objects, a list for arrays, a primitive (str/int/bool), None for null, or the original value/string when expansion is not possible.
        """
        # Handle non-string defaults
        if not isinstance(default_str, str):
            return default_str
        
        # Apply C++ pattern processing for simple cases (not complex constructor calls)
        if not ("(" in default_str and "::" in default_str):
            processed = process_cpp_patterns(default_str)
            if processed != default_str:
                # Pattern was processed, return the result
                if processed == "null":
                    return None
                elif processed.startswith('"') and processed.endswith('"'):
                    return ast.literal_eval(processed)
                else:
                    return processed
        
        # Handle string type with constructor syntax (e.g., ss::sstring{scram})
        if type_name == "string" and ("{" in default_str or "(" in default_str):
            tname, args = parse_constructor(default_str)
            if tname and args:
                # For string constructors, resolve the first argument and return it as the string value
                first_arg = args[0] if args else ""
                # Apply C++ pattern processing to resolve identifiers
                processed_arg = process_cpp_patterns(first_arg)
                if processed_arg.startswith('"') and processed_arg.endswith('"'):
                    return ast.literal_eval(processed_arg)  # Remove quotes
                else:
                    return processed_arg
            
        type_def = resolve_definition_type(resolve_type_with_namespace(type_name, definitions))
        if "enum" in type_def:
            # Strip C++ namespace qualifiers from enum values
            # e.g., model::partition_autobalancing_mode::continuous → continuous
            if isinstance(default_str, str) and '::' in default_str:
                return default_str.split('::')[-1]
            return default_str
        # If it has properties but no explicit type, it's an object
        if type_def.get("type") == "object" or (type_def.get("properties") and not type_def.get("type")):
            tname, args = parse_constructor(default_str)
            if tname is None:
                return default_str
            
            props = list(type_def["properties"].keys())
            result = {}

            # For each constructor argument, try to expand it and map to the correct property
            for i, prop in enumerate(props):
                prop_def = type_def["properties"][prop]
                # Strip leading underscore from private field names for public API
                public_prop_name = prop.lstrip('_')
                if "$ref" in prop_def:
                    sub_type = prop_def["$ref"].split("/")[-1]
                else:
                    sub_type = prop_def.get("type")
                    
                if i < len(args):
                    arg = args[i]
                    # Check if this argument is a nested constructor call
                    if "(" in arg and "::" in arg:
                        # Parse the nested constructor
                        nested_tname, nested_args = parse_constructor(arg)
                        if nested_tname and nested_tname in definitions:
                            # Get the definition for the nested type
                            nested_type_def = resolve_definition_type(definitions.get(nested_tname, {}))
                            nested_props = list(nested_type_def.get("properties", {}).keys())

                            # Expand the nested constructor by mapping its arguments to its properties
                            nested_result = {}
                            for j, nested_prop in enumerate(nested_props):
                                nested_prop_def = nested_type_def["properties"][nested_prop]
                                # Strip leading underscore from private field names for public API
                                public_nested_prop_name = nested_prop.lstrip('_')
                                if j < len(nested_args):
                                    nested_arg = nested_args[j]
                                    # Apply simple C++ pattern processing to the argument
                                    processed_nested_arg = process_cpp_patterns(nested_arg)

                                    # Convert the processed argument based on the property type
                                    if nested_prop_def.get("type") == "string":
                                        if processed_nested_arg.startswith('"') and processed_nested_arg.endswith('"'):
                                            nested_result[public_nested_prop_name] = ast.literal_eval(processed_nested_arg)
                                        else:
                                            nested_result[public_nested_prop_name] = processed_nested_arg
                                    elif nested_prop_def.get("type") == "integer":
                                        try:
                                            nested_result[public_nested_prop_name] = int(processed_nested_arg)
                                        except ValueError:
                                            nested_result[public_nested_prop_name] = processed_nested_arg
                                    elif nested_prop_def.get("type") == "boolean":
                                        nested_result[public_nested_prop_name] = processed_nested_arg.lower() == "true"
                                    else:
                                        nested_result[public_nested_prop_name] = processed_nested_arg
                                else:
                                    nested_result[public_nested_prop_name] = None
                            
                            # Now we have the expanded nested object, we need to map it to the parent object's properties
                            # This is where the type-aware mapping happens
                            
                            # Special case: if the nested type is net::unresolved_address and parent is broker_endpoint
                            if nested_tname == "net::unresolved_address" and type_name == "model::broker_endpoint":
                                # Map net::unresolved_address properties to broker_endpoint
                                # Only map the fields that actually exist in the net::unresolved_address
                                result["address"] = nested_result.get("address")
                                result["port"] = nested_result.get("port")
                                break
                            else:
                                # General case: if we have a single nested constructor argument,
                                # try to merge its properties into the parent
                                if i == 0 and len(args) == 1:
                                    result.update(nested_result)
                                    # Set remaining properties to None
                                    for remaining_prop in props[i+1:]:
                                        public_remaining_prop = remaining_prop.lstrip('_')
                                        if public_remaining_prop not in result:
                                            result[public_remaining_prop] = None
                                    break
                                else:
                                    # Map the nested object to the current property
                                    result[public_prop_name] = nested_result
                        else:
                            # Fallback: recursively expand with the expected property type
                            expanded_arg = expand_default(sub_type, arg)
                            result[public_prop_name] = expanded_arg
                    else:
                        # Simple value, parse based on the property type
                        # First apply C++ pattern processing
                        processed_arg = process_cpp_patterns(arg)

                        if sub_type == "string":
                            # If processed_arg is already quoted, use ast.literal_eval, otherwise keep as is
                            if processed_arg.startswith('"') and processed_arg.endswith('"'):
                                result[public_prop_name] = ast.literal_eval(processed_arg)
                            else:
                                result[public_prop_name] = processed_arg
                        elif sub_type == "integer":
                            try:
                                result[public_prop_name] = int(processed_arg)
                            except ValueError:
                                # If conversion fails, keep as string (might be processed C++ pattern)
                                result[public_prop_name] = processed_arg
                        elif sub_type == "boolean":
                            result[public_prop_name] = processed_arg.lower() == "true"
                        else:
                            result[public_prop_name] = processed_arg
                else:
                    result[public_prop_name] = None
            return result
        elif type_def.get("type") == "array":
            # Handle array defaults with C++ initializer list syntax like {model::broker_endpoint(...)}
            # This is specifically important for one_or_many_property types that use initializer lists
            # in their C++ defaults but should produce JSON arrays in the output.
            #
            # Example transformation:
            # C++: {model::broker_endpoint(net::unresolved_address("127.0.0.1", 9644))}
            # JSON: [{"address": "127.0.0.1", "port": 9644, "name": "127.0.0.1:9644"}]
            if isinstance(default_str, str) and default_str.strip().startswith("{") and default_str.strip().endswith("}"):
                # This is an initializer list, parse the elements
                initializer_content = default_str.strip()[1:-1].strip()  # Remove outer braces
                if initializer_content:
                    # Parse multiple comma-separated elements
                    elements = []
                    current_element = ""
                    paren_depth = 0
                    in_quotes = False
                    
                    # Parse elements while respecting nested parentheses and quoted strings
                    for char in initializer_content:
                        if char == '"' and (not current_element or current_element[-1] != '\\'):
                            in_quotes = not in_quotes
                        
                        if not in_quotes:
                            if char == '(':
                                paren_depth += 1
                            elif char == ')':
                                paren_depth -= 1
                            elif char == ',' and paren_depth == 0:
                                # Found a top-level comma, this is a separator
                                if current_element.strip():
                                    elements.append(current_element.strip())
                                current_element = ""
                                continue
                        
                        current_element += char
                    
                    # Add the last element
                    if current_element.strip():
                        elements.append(current_element.strip())
                    
                    # Try to determine the item type from the type_def
                    items_def = type_def.get("items", {})
                    if "$ref" in items_def:
                        item_type_name = items_def["$ref"].split("/")[-1]
                    else:
                        item_type_name = items_def.get("type", "string")  # Default to string for arrays
                    
                    # Process each element
                    result_array = []
                    for element_str in elements:
                        # Check if this element is a function call that needs resolution
                        if "::" in element_str and element_str.endswith("()"):
                            # This is a function call, resolve it
                            resolved_value = process_cpp_patterns(element_str)
                            if resolved_value.startswith('"') and resolved_value.endswith('"'):
                                # Remove quotes from resolved string values
                                result_array.append(ast.literal_eval(resolved_value))
                            else:
                                result_array.append(resolved_value)
                        elif element_str.startswith('"') and element_str.endswith('"'):
                            # This is a quoted string, parse it
                            result_array.append(ast.literal_eval(element_str))
                        elif item_type_name == "string":
                            # For string items, expand using the item type (might be constructor)
                            expanded_element = expand_default(item_type_name, element_str)
                            result_array.append(expanded_element)
                        else:
                            # For other types, expand using the item type
                            expanded_element = expand_default(item_type_name, element_str)
                            result_array.append(expanded_element)
                    
                    return result_array
                else:
                    return []
            else:
                return default_str
        else:
            return default_str

    for prop in properties.values():
        t = prop.get("type")
        ref_name = None


        # Handle both JSON pointer references and direct type names (including C++ types)
        if isinstance(t, str):
            if t.startswith("#/definitions/"):
                ref_name = t.split("/")[-1]
            else:
                # Try to resolve the type with namespace prefixes
                resolved_def = resolve_type_with_namespace(t, definitions)
                if resolved_def:
                    # Find the actual key name that matched
                    if t in definitions:
                        ref_name = t
                    else:
                        # Try namespace-qualified versions
                        for namespace in ['config', 'model', 'security', 'net', 'kafka', 'pandaproxy']:
                            qualified = f"{namespace}::{t}"
                            if qualified in definitions:
                                ref_name = qualified
                                break

        if ref_name:
            defn = resolve_type_with_namespace(ref_name, definitions) if ref_name not in definitions else definitions.get(ref_name)
            if defn:
                resolved = resolve_definition_type(defn)
                # Always set type to the resolved type string (object, string, etc.)
                resolved_type = resolved.get("type")

                # Special handling for enum types
                if resolved_type == "enum" or "enum" in resolved:
                    # Enums are represented as strings with an enum constraint in JSON Schema
                    prop["type"] = "string"
                    if "enum" in resolved:
                        prop["enum"] = resolved["enum"]
                elif resolved_type in ("object", "string", "integer", "boolean", "array", "number"):
                    prop["type"] = resolved_type
                else:
                    prop["type"] = "object"  # fallback for complex types

                # Expand default if possible
                if "default" in prop and prop["default"] is not None:
                    expanded = expand_default(ref_name, prop["default"])
                    prop["default"] = expanded
        
        # Handle case where default is already an object with nested constructors
        elif prop.get("type") == "object" and isinstance(prop.get("default"), dict):
            default_obj = prop["default"]
            for field_name, field_value in default_obj.items():
                if isinstance(field_value, str) and "::" in field_value and "(" in field_value:
                    # This field contains a nested constructor, try to expand it
                    tname, args = parse_constructor(field_value)
                    if tname and tname in definitions:
                        expanded = expand_default(tname, field_value)
                        if isinstance(expanded, dict):
                            # Update the existing object fields with the expanded values
                            for exp_key, exp_value in expanded.items():
                                if exp_key in default_obj:
                                    default_obj[exp_key] = exp_value
                            # Remove the field that contained the constructor
                            # unless it's supposed to remain (like 'name' field)
                            # For now, let's replace entire default with expanded version
                            prop["default"] = expanded
                            break
        
        # Handle case where property type is array and default contains C++ constructor syntax
        # This is a backup mechanism for cases where the expand_default function above
        # didn't catch array initialization patterns. It specifically looks for properties
        # that are already marked as array type but still have string defaults with
        # C++ constructor syntax that need expansion.
        elif prop.get("type") == "array" and isinstance(prop.get("default"), str):
            default_str = prop["default"]
            if default_str.strip().startswith("{") and default_str.strip().endswith("}"):
                # This is an initializer list for an array, expand it using the same logic as expand_default
                initializer_content = default_str.strip()[1:-1].strip()  # Remove outer braces
                if initializer_content:
                    # Parse multiple comma-separated elements
                    elements = []
                    current_element = ""
                    paren_depth = 0
                    in_quotes = False
                    
                    # Parse elements while respecting nested parentheses and quoted strings
                    for char in initializer_content:
                        if char == '"' and (not current_element or current_element[-1] != '\\'):
                            in_quotes = not in_quotes
                        
                        if not in_quotes:
                            if char == '(':
                                paren_depth += 1
                            elif char == ')':
                                paren_depth -= 1
                            elif char == ',' and paren_depth == 0:
                                # Found a top-level comma, this is a separator
                                if current_element.strip():
                                    elements.append(current_element.strip())
                                current_element = ""
                                continue
                        
                        current_element += char
                    
                    # Add the last element
                    if current_element.strip():
                        elements.append(current_element.strip())
                    
                    # Get the item type from the property definition
                    items_type = prop.get("items", {}).get("type", "string")
                    
                    # Process each element
                    result_array = []
                    for element_str in elements:
                        # Check if this element is a function call that needs resolution
                        if "::" in element_str and element_str.endswith("()"):
                            # This is a function call, resolve it
                            resolved_value = process_cpp_patterns(element_str)
                            if resolved_value.startswith('"') and resolved_value.endswith('"'):
                                # Remove quotes from resolved string values
                                result_array.append(ast.literal_eval(resolved_value))
                            else:
                                result_array.append(resolved_value)
                        elif element_str.startswith('"') and element_str.endswith('"'):
                            # This is a quoted string, parse it
                            result_array.append(ast.literal_eval(element_str))
                        elif items_type in definitions:
                            # For complex types, expand using the item type
                            expanded_element = expand_default(items_type, element_str)
                            result_array.append(expanded_element)
                        else:
                            # For simple types, just use the element as-is (likely a string)
                            result_array.append(element_str)
                    
                    prop["default"] = result_array
                else:
                    prop["default"] = []
        
        # Handle array properties where the default is a single object but should be an array
        # This is crucial for one_or_many_property types that are detected as arrays
        # but have defaults that were parsed as single objects by the transformers.
        #
        # Background: The transformer chain processes defaults before type resolution,
        # so a property like admin with default {model::broker_endpoint(...)} gets
        # expanded to {address: "127.0.0.1", port: 9644} (single object).
        # But since admin is one_or_many_property<model::broker_endpoint>, it should
        # be an array: [{address: "127.0.0.1", port: 9644}]
        if prop.get("type") == "array":
            default = prop.get("default")
            if isinstance(default, dict):
                # If we have an array type but the default is a single object, wrap it in an array
                # This handles cases like admin: {address: "127.0.0.1", port: 9644} -> [{address: ...}]
                prop["default"] = [default]
            elif isinstance(default, str) and default.strip() == "{}":
                # Empty object string should become empty array for array types
                # This handles cases like admin_api_tls: "{}" -> []
                prop["default"] = []
        
        # Also handle array item types - resolve C++ type references
        # Note: Check for 'items' field regardless of type, since some transformers may overwrite
        # the type from "array" to "object" while leaving the items field behind
        if "items" in prop:
            items_type = prop["items"].get("type")
            if isinstance(items_type, str):
                # Check if items_type is a C++ type that needs resolution
                if items_type in definitions:
                    item_defn = definitions.get(items_type)
                    if item_defn:
                        resolved_item = resolve_definition_type(item_defn)
                        resolved_item_type = resolved_item.get("type")
                        if resolved_item_type in ("object", "string", "integer", "boolean", "array", "number"):
                            prop["items"]["type"] = resolved_item_type
                        else:
                            prop["items"]["type"] = "object"  # fallback for complex types
                # If not in definitions but looks like a C++ type, apply fallback logic
                elif "::" in items_type or items_type.endswith(">") or items_type.endswith("_t") or items_type.startswith("std::"):
                    # Apply same heuristics as for unresolved property types
                    if any(word in items_type.lower() for word in ["int", "long", "short", "double", "float", "number", "_id"]):
                        prop["items"]["type"] = "integer"
                    elif any(word in items_type.lower() for word in ["bool"]):
                        prop["items"]["type"] = "boolean"
                    elif any(word in items_type.lower() for word in ["string", "str", "path", "url", "name"]):
                        prop["items"]["type"] = "string"
                    else:
                        # Default to object for complex types (config::*, model::*, etc.)
                        prop["items"]["type"] = "object"
                    logger.debug(f"Resolved C++ type in items: {items_type} -> {prop['items']['type']} (for property '{prop.get('name', 'unknown')}')")
    
    # Final pass: apply C++ pattern processing to any remaining unprocessed defaults
    for prop in properties.values():
        if "default" in prop:
            default_value = prop["default"]
            
            # Special handling for arrays containing key-value patterns like "'key': 'value'"
            if isinstance(default_value, list) and len(default_value) > 0:
                # Check if this looks like an array of key-value patterns
                all_keyval_patterns = True
                for item in default_value:
                    if not isinstance(item, str) or not re.match(r"'[^']+'\s*:\s*'[^']+'", item):
                        all_keyval_patterns = False
                        break
                
                if all_keyval_patterns:
                    # Convert array of key-value strings to a single object
                    result_object = {}
                    for item in default_value:
                        keyval_match = re.match(r"'([^']+)'\s*:\s*'([^']+)'", item)
                        if keyval_match:
                            key = keyval_match.group(1)
                            value = keyval_match.group(2)
                            # Process the value part
                            processed_value = process_cpp_patterns(value)
                            if processed_value.startswith('"') and processed_value.endswith('"'):
                                processed_value = processed_value[1:-1]  # Remove outer quotes
                            result_object[key] = processed_value
                    
                    # Convert the array type to object since we're now storing an object
                    prop["default"] = result_object
                    if prop.get("type") == "array":
                        prop["type"] = "object"
                    continue  # Skip further processing for this property
            
            if isinstance(default_value, str):
                # Process string defaults
                processed = process_cpp_patterns(default_value)
                if processed != default_value:
                    if processed == "null":
                        prop["default"] = None
                    elif isinstance(processed, str) and processed.startswith('"') and processed.endswith('"'):
                        prop["default"] = ast.literal_eval(processed)
                    else:
                        prop["default"] = processed
            
            elif isinstance(default_value, list):
                # Process array defaults - apply C++ pattern processing to each element
                processed_array = []
                for item in default_value:
                    if isinstance(item, dict):
                        # Process each field in the object
                        processed_item = {}
                        for field_name, field_value in item.items():
                            if isinstance(field_value, str) and "::" in field_value and "(" in field_value:
                                # This field contains a C++ constructor pattern - try to expand it using type definitions
                                tname, args = parse_constructor(field_value)
                                if tname and tname in definitions:
                                    # Get the definition for the nested type and expand the constructor
                                    nested_type_def = resolve_definition_type(definitions.get(tname, {}))
                                    if nested_type_def.get("properties"):
                                        nested_props = list(nested_type_def["properties"].keys())
                                        nested_result = {}
                                        
                                        # Map constructor arguments to type properties
                                        for j, nested_prop in enumerate(nested_props):
                                            nested_prop_def = nested_type_def["properties"][nested_prop]
                                            # Strip leading underscore from private field names for public API
                                            public_nested_prop_name = nested_prop.lstrip('_')
                                            if j < len(args):
                                                nested_arg = args[j]
                                                processed_nested_arg = process_cpp_patterns(nested_arg)

                                                # Convert based on property type
                                                if nested_prop_def.get("type") == "string":
                                                    if processed_nested_arg.startswith('"') and processed_nested_arg.endswith('"'):
                                                        nested_result[public_nested_prop_name] = ast.literal_eval(processed_nested_arg)
                                                    else:
                                                        nested_result[public_nested_prop_name] = processed_nested_arg
                                                elif nested_prop_def.get("type") == "integer":
                                                    try:
                                                        nested_result[public_nested_prop_name] = int(processed_nested_arg)
                                                    except ValueError:
                                                        nested_result[public_nested_prop_name] = processed_nested_arg
                                                elif nested_prop_def.get("type") == "boolean":
                                                    nested_result[public_nested_prop_name] = processed_nested_arg.lower() == "true"
                                                else:
                                                    nested_result[public_nested_prop_name] = processed_nested_arg
                                            else:
                                                nested_result[public_nested_prop_name] = None
                                        
                                        # For special case of net::unresolved_address inside broker_authn_endpoint
                                        if tname == "net::unresolved_address":
                                            # Replace the entire object with expanded net::unresolved_address values
                                            # Only include the fields that are actually defined in the type
                                            processed_item.update(nested_result)
                                            break  # Don't process other fields since we replaced the whole object
                                        else:
                                            processed_item[field_name] = nested_result
                                    else:
                                        # Fallback to simple pattern processing
                                        processed_field = process_cpp_patterns(field_value)
                                        if processed_field == "null":
                                            processed_item[field_name] = None
                                        elif isinstance(processed_field, str) and processed_field.startswith('"') and processed_field.endswith('"'):
                                            processed_item[field_name] = ast.literal_eval(processed_field)
                                        else:
                                            processed_item[field_name] = processed_field
                                else:
                                    # Fallback to simple pattern processing
                                    processed_field = process_cpp_patterns(field_value)
                                    if processed_field == "null":
                                        processed_item[field_name] = None
                                    elif isinstance(processed_field, str) and processed_field.startswith('"') and processed_field.endswith('"'):
                                        processed_item[field_name] = ast.literal_eval(processed_field)
                                    else:
                                        processed_item[field_name] = processed_field
                            elif isinstance(field_value, str):
                                # Simple string field - apply C++ pattern processing
                                processed_field = process_cpp_patterns(field_value)
                                if processed_field == "null":
                                    processed_item[field_name] = None
                                elif isinstance(processed_field, str) and processed_field.startswith('"') and processed_field.endswith('"'):
                                    processed_item[field_name] = ast.literal_eval(processed_field)
                                else:
                                    processed_item[field_name] = processed_field
                            else:
                                processed_item[field_name] = field_value
                        processed_array.append(processed_item)
                    else:
                        # Non-object array item
                        if isinstance(item, str):
                            processed_item = process_cpp_patterns(item)
                            if processed_item == "null":
                                processed_array.append(None)
                            elif isinstance(processed_item, str) and processed_item.startswith('"') and processed_item.endswith('"'):
                                processed_array.append(ast.literal_eval(processed_item))
                            else:
                                processed_array.append(processed_item)
                        else:
                            processed_array.append(item)
                prop["default"] = processed_array
            
            elif isinstance(default_value, dict):
                # Process object defaults - apply C++ pattern processing to each field
                processed_object = {}
                for field_name, field_value in default_value.items():
                    if isinstance(field_value, str):
                        processed_field = process_cpp_patterns(field_value)
                        if processed_field == "null":
                            processed_object[field_name] = None
                        elif isinstance(processed_field, str) and processed_field.startswith('"') and processed_field.endswith('"'):
                            processed_object[field_name] = ast.literal_eval(processed_field)
                        else:
                            processed_object[field_name] = processed_field
                    else:
                        processed_object[field_name] = field_value
                prop["default"] = processed_object
        
        # Handle unresolved C++ types
        prop_type = prop.get("type")
        if isinstance(prop_type, str):
            # Check if it's an unresolved C++ type (contains :: or ends with >)
            if ("::" in prop_type or prop_type.endswith(">") or 
                prop_type.endswith("_t") or prop_type.startswith("std::")):
                # Default unresolved C++ types to string, unless they look like numbers
                if any(word in prop_type.lower() for word in ["int", "long", "short", "double", "float", "number"]):
                    prop["type"] = "integer"
                elif any(word in prop_type.lower() for word in ["bool"]):
                    prop["type"] = "boolean"
                else:
                    prop["type"] = "string"
    
    # Final pass: process enterprise values
    for prop in properties.values():
        if "enterprise_value" in prop:
            enterprise_value = prop["enterprise_value"]
            if isinstance(enterprise_value, str):
                processed_enterprise = process_enterprise_value(enterprise_value)
                prop["enterprise_value"] = processed_enterprise

    # FINAL COMPREHENSIVE PASS: Ensure NO C++ types remain in the output
    # This catches any edge cases that earlier passes missed
    for prop_name, prop in properties.items():
        # Check property type field
        if isinstance(prop.get("type"), str) and ("::" in prop["type"] or prop["type"].endswith(">")):
            logger.warning(f"Found unresolved C++ type in property '{prop_name}': {prop['type']}")
            # Apply smart fallback resolution
            cpp_type = prop["type"]
            if any(word in cpp_type.lower() for word in ["int", "long", "short", "double", "float", "number", "_id"]):
                prop["type"] = "integer"
            elif any(word in cpp_type.lower() for word in ["bool"]):
                prop["type"] = "boolean"
            elif any(word in cpp_type.lower() for word in ["string", "str", "path", "url", "name"]):
                prop["type"] = "string"
            else:
                # Default to object for complex types (config::*, model::*, etc.)
                prop["type"] = "object"
            logger.info(f"  Resolved to: {prop['type']}")

        # Check items.type field for arrays
        if prop.get("type") == "array" and "items" in prop:
            items_type = prop["items"].get("type")
            if isinstance(items_type, str) and ("::" in items_type or items_type.endswith(">")):
                logger.warning(f"Found unresolved C++ type in property '{prop_name}' items: {items_type}")
                # Apply smart fallback resolution
                if any(word in items_type.lower() for word in ["int", "long", "short", "double", "float", "number", "_id"]):
                    prop["items"]["type"] = "integer"
                elif any(word in items_type.lower() for word in ["bool"]):
                    prop["items"]["type"] = "boolean"
                elif any(word in items_type.lower() for word in ["string", "str", "path", "url", "name"]):
                    prop["items"]["type"] = "string"
                else:
                    # Default to object for complex types (config::*, model::*, etc.)
                    prop["items"]["type"] = "object"
                logger.info(f"  Resolved to: {prop['items']['type']}")

            # Check items.$ref field
            # Only warn if it's NOT a JSON pointer (valid JSON pointers start with #/)
            items_ref = prop["items"].get("$ref")
            if isinstance(items_ref, str) and "::" in items_ref:
                if items_ref.startswith("#/definitions/"):
                    # This is a valid JSON pointer - extract and resolve the definition name
                    ref_type = items_ref.split("/")[-1]
                    if ref_type in definitions:
                        resolved = resolve_definition_type(definitions[ref_type])
                        resolved_type = resolved.get("type", "object")
                        prop["items"]["type"] = resolved_type
                        del prop["items"]["$ref"]
                        logger.debug(f"Resolved items.$ref '{items_ref}' to '{resolved_type}' for property '{prop_name}'")
                    else:
                        logger.warning(f"Cannot resolve items.$ref '{items_ref}' - definition not found for property '{prop_name}'")
                else:
                    # Raw C++ type name (not a JSON pointer) - this is an error
                    logger.warning(f"Found raw C++ type in property '{prop_name}' items.$ref: {items_ref}")
                    if items_ref in definitions:
                        resolved = resolve_definition_type(definitions[items_ref])
                        resolved_type = resolved.get("type", "object")
                        prop["items"]["type"] = resolved_type
                        del prop["items"]["$ref"]
                        logger.info(f"  Resolved to: {prop['items']['type']}")

        # Check $ref field at property level
        # Only warn if it's NOT a JSON pointer
        prop_ref = prop.get("$ref")
        if isinstance(prop_ref, str) and "::" in prop_ref:
            if prop_ref.startswith("#/definitions/"):
                # This is a valid JSON pointer - extract and resolve the definition name
                ref_type = prop_ref.split("/")[-1]
                if ref_type in definitions:
                    resolved = resolve_definition_type(definitions[ref_type])
                    resolved_type = resolved.get("type", "object")
                    prop["type"] = resolved_type
                    del prop["$ref"]
                    logger.debug(f"Resolved $ref '{prop_ref}' to '{resolved_type}' for property '{prop_name}'")
                else:
                    logger.warning(f"Cannot resolve $ref '{prop_ref}' - definition not found for property '{prop_name}'")
            else:
                # Raw C++ type name (not a JSON pointer) - this is an error
                logger.warning(f"Found raw C++ type in property '{prop_name}' $ref: {prop_ref}")
                if prop_ref in definitions:
                    resolved = resolve_definition_type(definitions[prop_ref])
                    resolved_type = resolved.get("type", "object")
                    prop["type"] = resolved_type
                    del prop["$ref"]
                    logger.info(f"  Resolved to: {prop['type']}")

    return properties


def extract_topic_properties(source_path):
    """
    Extract topic properties and convert them to the standard properties format.
    
    Args:
        source_path: Path to the Redpanda source code
        
    Returns:
        Dictionary of topic properties in the standard format with config_scope: "topic"
    """
    if TopicPropertyExtractor is None:
        logging.warning("TopicPropertyExtractor not available, skipping topic property extraction")
        return {}
    
    try:
        extractor = TopicPropertyExtractor(source_path)
        topic_data = extractor.extract_topic_properties()
        topic_properties = topic_data.get("topic_properties", {})
        
        # Convert topic properties to the standard properties format
        converted_properties = {}
        for prop_name, prop_data in topic_properties.items():
            # Skip no-op properties
            if prop_data.get("is_noop", False):
                continue

            # Assign category based on property name pattern or mapping
            def infer_category(name):
                retention = [
                    "cleanup.policy", "compaction.strategy", "delete.retention.ms", "max.compaction.lag.ms",
                    "min.cleanable.dirty.ratio", "min.compaction.lag.ms", "retention.bytes", "retention.ms"
                ]
                segment = [
                    "compression.type", "max.message.bytes", "message.timestamp.type", "segment.bytes", "segment.ms"
                ]
                performance = [
                    "flush.bytes", "flush.ms", "redpanda.leaders.preference", "replication.factor", "write.caching"
                ]
                tiered = [
                    "initial.retention.local.target.bytes", "initial.retention.local.target.ms", "redpanda.remote.delete",
                    "redpanda.remote.read", "redpanda.remote.recovery", "redpanda.remote.write", "retention.local.target.bytes",
                    "retention.local.target.ms"
                ]
                remote_replica = ["redpanda.remote.readreplica"]
                iceberg = [
                    "redpanda.iceberg.delete", "redpanda.iceberg.invalid.record.action", "redpanda.iceberg.mode",
                    "redpanda.iceberg.partition.spec", "redpanda.iceberg.target.lag.ms"
                ]
                schema_registry = [
                    "redpanda.key.schema.id.validation", "redpanda.key.subject.name.strategy", "redpanda.value.schema.id.validation",
                    "redpanda.value.subject.name.strategy", "confluent.key.schema.validation", "confluent.key.subject.name.strategy",
                    "confluent.value.schema.validation", "confluent.value.subject.name.strategy"
                ]
                if name in retention:
                    return "retention-compaction"
                if name in segment:
                    return "segment-message"
                if name in performance:
                    return "performance-cluster"
                if name in tiered:
                    return "tiered-storage"
                if name in remote_replica:
                    return "remote-read-replica"
                if name in iceberg:
                    return "iceberg-integration"
                if name in schema_registry:
                    return "schema-registry"
                return "other"

            converted_properties[prop_name] = {
                "name": prop_name,
                "description": prop_data.get("description", ""),
                "type": prop_data.get("type", "string"),
                "config_scope": "topic",
                "defined_in": prop_data.get("defined_in", ""),
                "corresponding_cluster_property": prop_data.get("corresponding_cluster_property", ""),
                "cluster_property_doc_file": prop_data.get("cluster_property_doc_file", ""),
                "alternate_cluster_property": prop_data.get("alternate_cluster_property", ""),
                "alternate_cluster_property_doc_file": prop_data.get("alternate_cluster_property_doc_file", ""),
                "acceptable_values": prop_data.get("acceptable_values", ""),
                "is_deprecated": False,
                "is_topic_property": True,
                "category": infer_category(prop_name)
            }
            
        logging.info(f"Extracted {len(converted_properties)} topic properties (excluding {len([p for p in topic_properties.values() if p.get('is_noop', False)])} no-op properties)")
        return converted_properties
        
    except Exception as e:
        logging.error(f"Failed to extract topic properties: {e}")
        return {}


def main():
    """
    CLI entry point that extracts Redpanda configuration properties from C++ sources and emits JSON outputs.
    
    Runs a full extraction and transformation pipeline:
    - Parses command-line options (required: --path). Optional flags include --recursive, --output, --enhanced-output, --overrides, --cloud-support, and --verbose.
    - The --overrides file can contain both property overrides (under "properties" key) and definition overrides (under "definitions" key).
    - Validates input paths and collects header/.cc file pairs.
    - Initializes Tree-sitter C++ parser and extracts configuration properties from source files (optionally augmented with topic properties).
    - Produces two outputs:
      - Original properties JSON: resolved types, expanded C++ defaults, added config_scope, and optional cloud metadata.
      - Enhanced properties JSON: same as original but with overrides applied before final resolution.
    - If --cloud-support is requested, attempts to fetch cloud configuration and add cloud metadata; this requires the cloud_config integration and network access (also requires GITHUB_TOKEN for private access). If cloud support is requested but dependencies are missing, the process will exit with an error.
    - Writes JSON to files when --output and/or --enhanced-output are provided; otherwise prints the original JSON to stdout.
    - Exits with non-zero status on fatal errors (missing files, parse errors, missing Tree-sitter parser, I/O failures, or missing cloud dependencies when requested).
    
    Side effects:
    - Reads and writes files, may call external cloud config fetchers, logs to the configured logger, and may call sys.exit() on fatal conditions.
    """
    global _type_definitions_cache
    import argparse
    from pathlib import Path

    def generate_options():
        """
        Create and return an argparse.ArgumentParser preconfigured for the property extractor CLI.
        
        The parser understands the following options:
        - --path (required): path to the Redpanda source directory to scan.
        - --recursive: scan the path recursively.
        - --output: file path to write the JSON output (stdout if omitted).
        - --enhanced-output: file path to write the enhanced JSON output with overrides applied.
        - --overrides: optional JSON file with property and definition overrides. Structure:
            {
              "properties": { "property_name": { "description": "...", ... } },
              "definitions": { "type_name": { "type": "object", "properties": {...} } }
            }
        - --definitions: DEPRECATED - use overrides.json with "definitions" key instead.
        - --cloud-support: enable fetching cloud metadata from the cloudv2 repository (requires GITHUB_TOKEN and external dependencies such as pyyaml and requests).
        - -v / --verbose: enable verbose (DEBUG-level) logging.
        
        Returns:
            argparse.ArgumentParser: Parser configured with the above options.
        """
        arg_parser = argparse.ArgumentParser(
            description="Internal property extraction tool - use doc-tools.js for user interface"
        )
        # Core required parameters
        arg_parser.add_argument("--path", type=str, required=True, help="Path to Redpanda source directory")
        arg_parser.add_argument("--recursive", action="store_true", help="Scan path recursively")
        
        # Output options
        arg_parser.add_argument("--output", type=str, help="JSON output file path")
        arg_parser.add_argument("--enhanced-output", type=str, help="Enhanced JSON output file path")
        
        # Data sources
        arg_parser.add_argument(
            "--definitions",
            type=str,
            help="DEPRECATED: Type definitions JSON file (use --overrides with 'definitions' key instead)"
        )
        arg_parser.add_argument(
            "--overrides",
            type=str,
            help="JSON file with property and definition overrides. Format: {'properties': {...}, 'definitions': {...}}"
        )
        
        # Feature flags (set by Makefile from environment variables)
        arg_parser.add_argument("--cloud-support", action="store_true", help="Enable cloud metadata")
        arg_parser.add_argument("-v", "--verbose", action="store_true", help="Verbose logging")

        return arg_parser

    arg_parser = generate_options()
    options, _ = arg_parser.parse_known_args()

    if options.verbose:
        logging.basicConfig(level="DEBUG")
        # Also enable INFO logging for cloud_config in verbose mode
        logging.getLogger('cloud_config').setLevel(logging.INFO)
    else:
        logging.basicConfig(level="WARNING")  # Suppress INFO logs by default

    validate_paths(options)

    file_pairs = get_file_pairs(options)

    if not file_pairs:
        logging.error("No h/cc file pairs were found")
        sys.exit(-1)

    # DYNAMIC TYPE DEFINITION EXTRACTION
    # Automatically extract type definitions from C++ source code
    # This replaces the need for manually maintaining definitions.json
    logger.info("🔍 Extracting type definitions from C++ source code...")

    from type_definition_extractor import extract_definitions_from_source

    try:
        # Extract definitions from the parent 'v' directory to get all subdirectories
        # (model, config, net, etc.) since types may be defined in different modules
        source_root = Path(options.path)

        # If path points to repo root, go down to src/v
        if (source_root / 'src' / 'v').exists():
            source_root = source_root / 'src' / 'v'
        # If path points to a specific subdirectory, go up to the parent 'v' directory
        elif source_root.name in ('config', 'model', 'net', 'kafka', 'pandaproxy', 'security'):
            source_root = source_root.parent

        logger.debug(f"Extracting type definitions from: {source_root}")
        definitions = extract_definitions_from_source(str(source_root))
        logger.info(f"✅ Extracted {len(definitions)} type definitions dynamically")

        # Store definitions in global cache for transformers to access
        _type_definitions_cache = definitions
    except Exception as e:
        logger.warning(f"Failed to extract dynamic definitions: {e}")
        definitions = {}

    # Load overrides file (contains both property and definition overrides)
    overrides = None
    if options.overrides:
        try:
            with open(options.overrides) as f:
                overrides = json.load(f)

            # Load definition overrides from the overrides file
            if overrides and "definitions" in overrides:
                definition_overrides = overrides["definitions"]
                num_overrides = len(definition_overrides)
                definitions.update(definition_overrides)
                _type_definitions_cache = definitions
                logger.info(f"📝 Loaded {num_overrides} definition overrides from {options.overrides}")
        except Exception as e:
            logging.error(f"Failed to load overrides file: {e}")
            sys.exit(1)

    # DEPRECATED: Support legacy --definitions flag for backward compatibility
    # Users should migrate to putting definitions in overrides.json under "definitions" key
    if options.definitions and os.path.exists(options.definitions):
        try:
            logger.warning("⚠️  --definitions flag is deprecated. Please move definitions to overrides.json under 'definitions' key")
            with open(options.definitions) as json_file:
                static_definitions = json.load(json_file)

            # Merge: static overrides take precedence
            num_overrides = len(static_definitions)
            definitions.update(static_definitions)
            _type_definitions_cache = definitions

            logger.info(f"📝 Loaded {num_overrides} legacy definition overrides from {options.definitions}")
        except json.JSONDecodeError as e:
            logging.error(f"Failed to parse definitions file: {e}")
            sys.exit(1)

    treesitter_dir = os.path.join(os.getcwd(), "tree-sitter/tree-sitter-cpp")
    destination_path = os.path.join(treesitter_dir, "tree-sitter-cpp.so")

    if not os.path.exists(os.path.join(treesitter_dir, "src/parser.c")):
        logging.error("Missing parser.c. Ensure Tree-sitter submodules are initialized.")
        sys.exit(1)

    treesitter_parser, cpp_language = get_treesitter_cpp_parser_and_language(
        treesitter_dir, destination_path
    )

    # Pre-build constexpr cache for performance
    # This avoids repeated filesystem walks when resolving C++ identifiers and function calls
    logger.info("🔧 Building constexpr identifier cache...")
    _constexpr_cache.build_cache(options.path)
    logger.info(f"✅ Cached {len(_constexpr_cache.constexpr_cache)} constexpr identifiers and {len(_constexpr_cache.function_cache)} functions")

    files_with_properties = get_files_with_properties(
        file_pairs, treesitter_parser, cpp_language
    )
    properties = transform_files_with_properties(files_with_properties)

    # Extract topic properties and add them to the main properties dictionary
    topic_properties = extract_topic_properties(options.path)
    if topic_properties:
        # Apply transformers to topic properties to ensure they get the same metadata as cluster properties
        topic_properties = apply_transformers_to_topic_properties(topic_properties)
        properties.update(topic_properties)
        logging.info(f"Added {len(topic_properties)} topic properties to the main properties collection")

        # Validate and fix up corresponding_cluster_property mappings
        # Some cluster properties have a "_default" suffix that the extractor doesn't catch
        fixup_count = 0
        invalid_mappings = []

        for prop_name, prop_data in properties.items():
            if not prop_data.get('is_topic_property'):
                continue

            # Validate primary cluster property mapping
            if prop_data.get('corresponding_cluster_property'):
                cluster_prop = prop_data['corresponding_cluster_property']
                # Check if the mapped cluster property exists
                if cluster_prop not in properties:
                    # Try the _default variant
                    default_variant = f'{cluster_prop}_default'
                    if default_variant in properties:
                        prop_data['corresponding_cluster_property'] = default_variant
                        # Update doc file for the new property name
                        if prop_data.get('cluster_property_doc_file'):
                            # Re-determine doc file for the _default variant
                            if ('cloud_storage' in default_variant or 'remote_' in default_variant or
                                's3_' in default_variant or 'azure_' in default_variant or
                                'gcs_' in default_variant or 'archival_' in default_variant or
                                'tiered_' in default_variant):
                                prop_data['cluster_property_doc_file'] = 'object-storage-properties.adoc'
                            else:
                                prop_data['cluster_property_doc_file'] = 'cluster-properties.adoc'
                        fixup_count += 1
                    else:
                        invalid_mappings.append({
                            'topic_property': prop_name,
                            'cluster_property': cluster_prop,
                            'type': 'primary'
                        })

            # Validate alternate cluster property mapping (for conditional mappings)
            if prop_data.get('alternate_cluster_property'):
                alternate_prop = prop_data['alternate_cluster_property']
                if alternate_prop not in properties:
                    # Try the _default variant
                    default_variant = f'{alternate_prop}_default'
                    if default_variant in properties:
                        prop_data['alternate_cluster_property'] = default_variant
                        # Update doc file for the new property name
                        if prop_data.get('alternate_cluster_property_doc_file'):
                            if ('cloud_storage' in default_variant or 'remote_' in default_variant or
                                's3_' in default_variant or 'azure_' in default_variant or
                                'gcs_' in default_variant or 'archival_' in default_variant or
                                'tiered_' in default_variant):
                                prop_data['alternate_cluster_property_doc_file'] = 'object-storage-properties.adoc'
                            else:
                                prop_data['alternate_cluster_property_doc_file'] = 'cluster-properties.adoc'
                        fixup_count += 1
                    else:
                        invalid_mappings.append({
                            'topic_property': prop_name,
                            'cluster_property': alternate_prop,
                            'type': 'alternate'
                        })

        if fixup_count > 0:
            print(f"✅ Fixed {fixup_count} cluster property mappings by adding '_default' suffix", file=sys.stderr, flush=True)

        # Report invalid mappings
        if invalid_mappings:
            print(f"\n⚠️  Found {len(invalid_mappings)} topic properties with invalid cluster property mappings:", file=sys.stderr, flush=True)
            for mapping in invalid_mappings:
                print(f"  • {mapping['topic_property']} -> {mapping['cluster_property']} ({mapping['type']}) [CLUSTER PROPERTY NOT FOUND]", file=sys.stderr, flush=True)
            print("These mappings reference cluster properties that do not exist in the extracted properties.", file=sys.stderr, flush=True)
            print("This could indicate:", file=sys.stderr, flush=True)
            print("  1. The cluster property name changed in the source code", file=sys.stderr, flush=True)
            print("  2. The cluster property is not being extracted properly", file=sys.stderr, flush=True)
            print("  3. The mapping logic in config_response_utils.cc uses a computed value, not a real cluster property", file=sys.stderr, flush=True)
            print("", file=sys.stderr, flush=True)

    # First, create the original properties without overrides for the base JSON output
    # 1. Add config_scope field based on which source file defines the property
    original_properties = add_config_scope(deepcopy(properties))
    
    # 2. Fetch cloud configuration and add cloud support metadata if requested
    # Check both CLI flag and environment variable (CLOUD_SUPPORT=1 from Makefile)
    cloud_support_enabled = options.cloud_support or os.environ.get('CLOUD_SUPPORT') == '1'
    cloud_config = None
    if cloud_support_enabled:
        if fetch_cloud_config and add_cloud_support_metadata:
            logging.info("Cloud support enabled, fetching cloud configuration...")
            cloud_config = fetch_cloud_config()  # This will raise an exception if it fails
            original_properties = add_cloud_support_metadata(original_properties, cloud_config)
            logging.info(f"✅ Cloud support metadata applied successfully using configuration version {cloud_config.version}")
        else:
            logging.error("❌ Cloud support requested but cloud_config module not available")
            logging.error("This indicates missing Python dependencies for cloud configuration")
            logging.error("Install required packages: pip install pyyaml requests")
            logging.error("Or if using a virtual environment, activate it first")
            sys.exit(1)
    
    # 3. Resolve type references and expand default values for original properties
    original_properties = resolve_type_and_default(original_properties, definitions)

    # 4. Map enum default values to user-facing strings
    original_properties = map_enum_defaults(original_properties)

    # 5. Evaluate chrono expressions in default values
    original_properties = evaluate_chrono_expressions(original_properties)

    # 6. Filter definitions to only include referenced types (reduces bloat)
    filtered_definitions = filter_referenced_definitions(original_properties, definitions)

    # 6. Clean private fields from definitions (keep JSON output clean)
    filtered_definitions = clean_private_fields_from_definitions(filtered_definitions)

    # Generate original properties JSON (without overrides)
    original_properties_and_definitions = merge_properties_and_definitions(
        original_properties, filtered_definitions
    )
    original_json_output = json.dumps(original_properties_and_definitions, indent=4, sort_keys=True)

    # Now create enhanced properties with overrides applied
    # 1. Apply any description overrides from external override files
    enhanced_properties = apply_property_overrides(deepcopy(properties), overrides, options.overrides)
    
    # 2. Add config_scope field based on which source file defines the property
    enhanced_properties = add_config_scope(enhanced_properties)
    
    # 3. Add cloud support metadata if requested
    if cloud_config:
        enhanced_properties = add_cloud_support_metadata(enhanced_properties, cloud_config)
        logging.info("✅ Cloud support metadata applied to enhanced properties")
    
    # 4. Resolve type references and expand default values
    # This step converts:
    # - C++ type names (model::broker_endpoint) to JSON schema types (object)
    # - C++ constructor defaults to structured JSON objects
    # - Single object defaults to arrays for one_or_many_property types
    enhanced_properties = resolve_type_and_default(enhanced_properties, definitions)

    # 5. Map enum default values to user-facing strings
    enhanced_properties = map_enum_defaults(enhanced_properties)

    # 6. Evaluate chrono expressions in default values
    enhanced_properties = evaluate_chrono_expressions(enhanced_properties)

    # 7. Filter definitions to only include referenced types (reduces bloat)
    filtered_enhanced_definitions = filter_referenced_definitions(enhanced_properties, definitions)

    # 7. Clean private fields from definitions (keep JSON output clean)
    filtered_enhanced_definitions = clean_private_fields_from_definitions(filtered_enhanced_definitions)

    # Generate enhanced properties JSON (with overrides)
    enhanced_properties_and_definitions = merge_properties_and_definitions(
        enhanced_properties, filtered_enhanced_definitions
    )
    enhanced_json_output = json.dumps(enhanced_properties_and_definitions, indent=4, sort_keys=True)

    # Write original properties file (for backward compatibility)
    if options.output:
        try:
            with open(options.output, "w+") as json_file:
                json_file.write(original_json_output)
            print(f"✅ Original properties JSON generated at {options.output}")
        except IOError as e:
            logging.error(f"Failed to write original output file: {e}")
            sys.exit(1)
    else:
        print(original_json_output)

    # Write enhanced properties file (with overrides applied)
    if options.enhanced_output:
        try:
            with open(options.enhanced_output, "w+") as json_file:
                json_file.write(enhanced_json_output)
            print(f"✅ Enhanced properties JSON (with overrides) generated at {options.enhanced_output}")
        except IOError as e:
            logging.error(f"Failed to write enhanced output file: {e}")
            sys.exit(1)

if __name__ == "__main__":
    main()