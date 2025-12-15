#!/usr/bin/env python3
"""
Resolves C++ constant references to their actual values.

For properties that use constants as default values (for example, `ss::sstring{net::tls_v1_2_cipher_suites}`),
this module looks up the constant definition and extracts the actual string value.
"""

import re
from pathlib import Path
from typing import Optional, Dict
import logging

logger = logging.getLogger(__name__)


class ConstantResolver:
    def __init__(self, source_path: Path):
        """
        Initialize the constant resolver with the Redpanda source directory.

        Args:
            source_path: Path to the Redpanda src/v directory
        """
        self.source_path = source_path
        self._constant_cache: Dict[str, str] = {}

    def resolve_constant(self, constant_name: str) -> Optional[str]:
        """
        Resolve a C++ constant name to its actual string value.

        Args:
            constant_name: The constant name (for example, "net::tls_v1_2_cipher_suites" or "tls_v1_2_cipher_suites")

        Returns:
            The actual string value, or None if not found
        """
        # Check cache first
        if constant_name in self._constant_cache:
            return self._constant_cache[constant_name]

        # Parse namespace and identifier
        if '::' in constant_name:
            namespace, identifier = constant_name.rsplit('::', 1)
        else:
            namespace = None
            identifier = constant_name

        # Search strategy based on namespace
        if namespace == 'net':
            value = self._search_in_files(['net/tls.cc', 'net/tls.h'], identifier)
        elif namespace == 'model':
            value = self._search_in_files(['model/**/*.cc', 'model/**/*.h'], identifier)
        elif namespace == 'config':
            value = self._search_in_files(['config/**/*.cc', 'config/**/*.h'], identifier)
        else:
            # Try common locations
            value = self._search_in_files([
                'net/**/*.cc',
                'config/**/*.cc',
                'model/**/*.cc'
            ], identifier)

        if value:
            self._constant_cache[constant_name] = value
            logger.info(f"Resolved constant {constant_name} = {value[:50]}...")

        return value

    def _search_in_files(self, patterns: list[str], identifier: str) -> Optional[str]:
        """
        Search for a constant definition in files matching the given patterns.

        Args:
            patterns: List of file patterns to search (for example, ['net/tls.cc'])
            identifier: The constant identifier (for example, 'tls_v1_2_cipher_suites')

        Returns:
            The constant's string value, or None if not found
        """
        for pattern in patterns:
            if '**' in pattern:
                # Glob pattern
                files = list(self.source_path.glob(pattern))
            else:
                # Direct path
                file_path = self.source_path / pattern
                files = [file_path] if file_path.exists() else []

            for file_path in files:
                try:
                    with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()

                    value = self._extract_constant_value(content, identifier)
                    if value:
                        logger.debug(f"Found {identifier} in {file_path}")
                        return value
                except Exception as e:
                    logger.debug(f"Error reading {file_path}: {e}")
                    continue

        return None

    def resolve_array_constant(self, array_name: str) -> Optional[list]:
        """
        Resolve a C++ array constant to get its element values.

        Handles patterns like:
        - inline constexpr auto supported_sasl_mechanisms = std::to_array<std::string_view>({gssapi, scram, oauthbearer, plain});
        - constexpr std::array<std::string_view, N> array_name = {val1, val2, val3};

        Args:
            array_name: The array constant name (for example, "supported_sasl_mechanisms")

        Returns:
            List of string values from the array, or None if not found
        """
        # Check cache
        cache_key = f"array:{array_name}"
        if cache_key in self._constant_cache:
            return self._constant_cache[cache_key]

        # Search in config directory first (most common for validators)
        search_dirs = ['config', 'security', 'model', 'kafka']

        for dir_name in search_dirs:
            search_path = self.source_path / dir_name
            if not search_path.exists():
                continue

            for file_path in search_path.rglob('*.h'):
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        content = f.read()

                    values = self._extract_array_values(content, array_name)
                    if values:
                        # Resolve any identifiers in the array to their string values
                        resolved_values = []
                        for val in values:
                            if val.startswith('"') and val.endswith('"'):
                                # Already a string literal
                                resolved_values.append(val.strip('"'))
                            else:
                                # Try to resolve as an identifier
                                resolved = self._extract_constant_value(content, val)
                                if resolved:
                                    resolved_values.append(resolved)
                                else:
                                    resolved_values.append(val)

                        self._constant_cache[cache_key] = resolved_values
                        logger.debug(f"Resolved array {array_name} = {resolved_values} from {file_path}")
                        return resolved_values

                except Exception as e:
                    logger.debug(f"Error reading {file_path}: {e}")
                    continue

        logger.debug(f"Could not resolve array constant: {array_name}")
        return None

    def _extract_array_values(self, content: str, identifier: str) -> Optional[list]:
        """
        Extract array element values from C++ source code.

        Handles patterns like:
        - std::to_array<std::string_view>({val1, val2, val3})
        - std::array<std::string_view, N> = {val1, val2, val3}

        Args:
            content: The C++ source code
            identifier: The array identifier

        Returns:
            List of element values (may be identifiers or string literals), or None if not found
        """
        # Pattern for array with std::to_array or direct initialization
        patterns = [
            # inline constexpr auto name = std::to_array<type>({val1, val2});
            rf'inline\s+constexpr\s+auto\s+{re.escape(identifier)}\s*=\s*std::to_array<[^>]+>\s*\(\s*\{{([^}}]+)\}}\s*\)',
            # constexpr auto name = std::to_array<type>({val1, val2});
            rf'constexpr\s+auto\s+{re.escape(identifier)}\s*=\s*std::to_array<[^>]+>\s*\(\s*\{{([^}}]+)\}}\s*\)',
            # constexpr std::array<type, N> name = {val1, val2};
            rf'constexpr\s+std::array<[^>]+>\s+{re.escape(identifier)}\s*=\s*\{{([^}}]+)\}}',
        ]

        for pattern in patterns:
            match = re.search(pattern, content, re.MULTILINE | re.DOTALL)
            if match:
                # Extract comma-separated values
                values_str = match.group(1)
                # Remove comments
                values_str = re.sub(r'//.*$', '', values_str, flags=re.MULTILINE)
                values_str = re.sub(r'/\*.*?\*/', '', values_str, flags=re.DOTALL)

                # Split by comma and clean up
                values = [v.strip() for v in values_str.split(',') if v.strip()]
                return values

        return None

    def _is_enterprise_file(self, file_path: Path) -> bool:
        """
        Check if a file is marked as a Redpanda Enterprise file.

        Args:
            file_path: Path to the source file

        Returns:
            True if the file contains "Redpanda Enterprise file" in its header
        """
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                # Check first 500 chars (license header)
                header = f.read(500)
                return "Redpanda Enterprise file" in header
        except Exception:
            return False

    def _resolve_authenticator_name(self, class_ref: str) -> Optional[dict]:
        """
        Resolve an authenticator class name constant.

        For patterns like:
        - security::scram_sha256_authenticator
        - security::oidc::sasl_authenticator

        Finds the class definition and extracts the `static constexpr const char* name` value.

        Args:
            class_ref: Qualified class name (for example, "security::scram_sha256_authenticator")

        Returns:
            Dict with 'value' and 'is_enterprise' keys, or None if not found
        """
        # Extract all namespace parts and class name
        parts = class_ref.split('::')
        class_name = parts[-1]  # Last part is the class name
        namespaces = parts[:-1]  # Everything before is namespaces

        # Search in security directory for authenticator classes
        search_path = self.source_path / 'security'
        if not search_path.exists():
            return None

        # For nested namespaces like security::oidc::sasl_authenticator,
        # also check subdirectories
        search_paths = [search_path]
        if len(namespaces) > 1:
            # If we have security::oidc, also check security/oidc directory
            nested_path = search_path
            for ns in namespaces[1:]:  # Skip 'security' as that's already the base
                nested_path = nested_path / ns
                if nested_path.exists():
                    search_paths.append(nested_path)

        for search_dir in search_paths:
            for header_file in search_dir.rglob('*.h'):
                try:
                    with open(header_file, 'r', encoding='utf-8') as f:
                        content = f.read()

                    # Strategy: Find the class/struct declaration, then search for name constant
                    # in the following content (avoids nested brace issues)

                    # Pattern 1: Standard class/struct declaration
                    class_pattern = rf'(?:struct|class)\s+{re.escape(class_name)}\s+[^{{]*\{{'
                    class_match = re.search(class_pattern, content)

                    if class_match:
                        # Extract a chunk after the class declaration (3000 chars should be enough)
                        start_pos = class_match.end()
                        chunk = content[start_pos:start_pos + 3000]

                        # Look for the name constant in this chunk
                        name_pattern = r'static\s+constexpr\s+const\s+char\s*\*\s*name\s*=\s*"([^"]+)"'
                        name_match = re.search(name_pattern, chunk)
                        if name_match:
                            value = name_match.group(1)
                            is_enterprise = self._is_enterprise_file(header_file)
                            logger.debug(f"Resolved authenticator {class_ref}::name → '{value}' (enterprise={is_enterprise}) from {header_file}")
                            return {"value": value, "is_enterprise": is_enterprise}

                    # Pattern 2: Template specialization (for scram authenticators)
                    template_pattern = rf'struct\s+\w+<[^>]*{re.escape(class_name.replace("_authenticator", ""))}[^>]*>\s*\{{'
                    template_match = re.search(template_pattern, content)

                    if template_match:
                        start_pos = template_match.end()
                        chunk = content[start_pos:start_pos + 2000]

                        name_pattern = r'static\s+constexpr\s+const\s+char\s*\*\s*name\s*=\s*"([^"]+)"'
                        name_match = re.search(name_pattern, chunk)
                        if name_match:
                            value = name_match.group(1)
                            is_enterprise = self._is_enterprise_file(header_file)
                            logger.debug(f"Resolved authenticator {class_ref}::name → '{value}' (enterprise={is_enterprise}) from {header_file}")
                            return {"value": value, "is_enterprise": is_enterprise}

                except Exception as e:
                    logger.debug(f"Error reading {header_file}: {e}")
                    continue

        logger.debug(f"Could not resolve authenticator name for: {class_ref}")
        return None

    def _extract_constant_value(self, content: str, identifier: str) -> Optional[str]:
        """
        Extract a constant's string value from C++ source code.

        Handles formats like:
        - const std::string_view identifier = "value";
        - constexpr std::string_view identifier = "value";
        - const ss::sstring identifier = "value";
        - inline constexpr std::string_view identifier{"value"};
        - Multi-line concatenated strings

        Args:
            content: The C++ source code
            identifier: The constant identifier

        Returns:
            The extracted string value, or None if not found
        """
        # Pattern 1: inline constexpr std::string_view name{"VALUE"};
        brace_pattern = rf'inline\s+constexpr\s+std::string_view\s+{re.escape(identifier)}\s*\{{\s*"([^"]+)"\s*\}}'
        match = re.search(brace_pattern, content)
        if match:
            return match.group(1)

        # Pattern 2: constexpr std::string_view name{"VALUE"};
        brace_pattern2 = rf'constexpr\s+std::string_view\s+{re.escape(identifier)}\s*\{{\s*"([^"]+)"\s*\}}'
        match = re.search(brace_pattern2, content)
        if match:
            return match.group(1)

        # Pattern 3: const/constexpr type identifier = "value";
        # Matches: const/constexpr [type] identifier = "value" (with possible concatenation)
        pattern = rf'''
            (?:const|constexpr|extern\s+const|inline\s+constexpr)\s+     # const qualifier
            (?:std::string_view|ss::sstring|std::string)\s+              # type
            {re.escape(identifier)}\s*                                    # identifier
            =\s*                                                          # equals
            (                                                             # capture group for value
                "(?:[^"\\]|\\.)*"                                        # first string literal
                (?:\s*\n\s*"(?:[^"\\]|\\.)*")*                          # optional continuation strings
            )
            \s*;                                                          # semicolon
        '''

        match = re.search(pattern, content, re.VERBOSE | re.DOTALL)
        if not match:
            return None

        # Extract and concatenate all string literals
        value_section = match.group(1)

        # Find all quoted strings
        string_literals = re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"', value_section)

        if not string_literals:
            return None

        # Concatenate all string parts
        result = ''.join(string_literals)

        # Handle escape sequences
        result = result.encode('utf-8').decode('unicode_escape')

        return result


def resolve_property_default(default_value: str, resolver: ConstantResolver) -> str:
    """
    Resolve a property default value that might be a constant reference.

    Handles patterns like:
    - "literal string" -> returns as-is
    - net::tls_v1_2_cipher_suites -> resolves to actual value
    - ss::sstring{net::tls_v1_2_cipher_suites} -> extracts and resolves

    Args:
        default_value: The default value string from the parser
        resolver: ConstantResolver instance

    Returns:
        The resolved string value
    """
    if not default_value or not isinstance(default_value, str):
        return default_value

    # If it's already a quoted string literal, return as-is
    if default_value.startswith('"') and default_value.endswith('"'):
        return default_value

    # Check if it's a constructor with a constant: ss::sstring{constant}
    constructor_match = re.match(r'[\w:]+\{([\w:]+)\}', default_value)
    if constructor_match:
        constant_name = constructor_match.group(1)
        resolved = resolver.resolve_constant(constant_name)
        if resolved:
            return resolved
        # Fall through to try resolving as plain identifier
        default_value = constant_name

    # Check if it's a plain identifier that looks like a constant
    if re.match(r'^[\w:]+$', default_value) and ('::' in default_value or default_value.islower()):
        resolved = resolver.resolve_constant(default_value)
        if resolved:
            return resolved

    return default_value


def resolve_validator_enum_constraint(validator_name: str, resolver: ConstantResolver) -> Optional[list]:
    """
    Extract enum constraint values from a validator function.

    For validators like validate_sasl_mechanisms, this function:
    1. Finds the validator function in validators.cc
    2. Parses it to find what constant array it validates against (for example, supported_sasl_mechanisms)
    3. Resolves that array to get the actual enum values
    4. Checks for enterprise values (for example, enterprise_sasl_mechanisms)

    Args:
        validator_name: Name of the validator function (for example, "validate_sasl_mechanisms")
        resolver: ConstantResolver instance

    Returns:
        List of dicts with 'value' and 'is_enterprise' keys, or None if not found
    """
    # Find validators.cc in the config directory
    validators_file = resolver.source_path / 'config' / 'validators.cc'
    if not validators_file.exists():
        logger.debug(f"validators.cc not found at {validators_file}")
        return None

    try:
        with open(validators_file, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        logger.debug(f"Error reading validators.cc: {e}")
        return None

    # Find the validator function definition
    # Pattern: validate_name(...) { ... }
    func_pattern = rf'{re.escape(validator_name)}\s*\([^)]*\)\s*\{{([^}}]+(?:\{{[^}}]*\}}[^}}]*)*)\}}'
    func_match = re.search(func_pattern, content, re.DOTALL)

    if not func_match:
        logger.debug(f"Validator function {validator_name} not found")
        return None

    func_body = func_match.group(1)

    # Look for patterns like:
    # - std::ranges::contains(supported_sasl_mechanisms, m)
    # - std::find.*(...array.begin())
    # - std::count.*(...array.begin())
    constraint_patterns = [
        r'std::ranges::contains\s*\(\s*([\w:]+)\s*,',
        r'std::find.*\(\s*([\w:]+)\.begin\(\)',
        r'std::count.*\(\s*([\w:]+)\.begin\(\)',
    ]

    constraint_array = None
    for pattern in constraint_patterns:
        match = re.search(pattern, func_body)
        if match:
            constraint_array = match.group(1)
            logger.debug(f"Found constraint array '{constraint_array}' in validator {validator_name}")
            break

    if not constraint_array:
        logger.debug(f"No constraint array found in {validator_name}")
        return None

    # Resolve the constraint array to get enum values
    enum_values = resolver.resolve_array_constant(constraint_array)
    if not enum_values:
        return None

    # Check if there's an enterprise version of this array
    # Pattern: supported_X -> enterprise_X
    enterprise_array = constraint_array.replace('supported_', 'enterprise_')
    enterprise_values = []

    if enterprise_array != constraint_array:
        enterprise_values = resolver.resolve_array_constant(enterprise_array) or []
        if enterprise_values:
            logger.debug(f"Found enterprise array '{enterprise_array}' with values: {enterprise_values}")

    # Build result with enterprise metadata
    results = []
    for value in enum_values:
        is_enterprise = value in enterprise_values
        results.append({
            "value": value,
            "is_enterprise": is_enterprise
        })

    logger.info(f"Extracted {len(results)} enum values from validator {validator_name}: {[r['value'] for r in results]}")
    return results


def resolve_runtime_validation_enum_constraint(property_name: str, defined_in: str, resolver: ConstantResolver) -> Optional[list]:
    """
    Extract enum constraint values from runtime validation functions.

    For properties without constructor validators, this searches for validation
    functions that check the property value against constants.

    Pattern example (kafka/client/configuration.cc:validate_sasl_properties):
        if (
          mechanism != security::scram_sha256_authenticator::name
          && mechanism != security::scram_sha512_authenticator::name
          && mechanism != security::oidc::sasl_authenticator::name) {
            throw std::invalid_argument(...);
        }

    Args:
        property_name: Name of the property (for example, "sasl_mechanism")
        defined_in: Path where property is defined (for example, "src/v/kafka/client/configuration.cc")
        resolver: ConstantResolver instance

    Returns:
        List of dicts with 'value' and 'is_enterprise' keys, or None if not found
    """
    # Find the source file where the property is defined
    source_file = resolver.source_path / Path(defined_in).relative_to('src/v')

    if not source_file.exists():
        logger.debug(f"Source file not found: {source_file}")
        return None

    try:
        with open(source_file, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        logger.debug(f"Error reading {source_file}: {e}")
        return None

    # Search for validation functions that reference this property
    # Use a simpler approach: find function declarations and extract chunks around them

    # Look for validation/check functions
    func_decl_pattern = r'(?:void|bool|std::optional<[\w:]+>)\s+(\w*validate\w*|\w*check\w*)\s*\('

    for func_match in re.finditer(func_decl_pattern, content, re.IGNORECASE):
        func_name = func_match.group(1)
        func_start = func_match.start()

        # Extract chunks: one after function definition, one for searching call sites
        func_def_chunk = content[func_start:func_start + 2000]

        # Also search the entire file for call sites (more expensive but necessary)
        # Look for: func_name(...property_name()...)
        func_call_pattern = rf'{re.escape(func_name)}\s*\([^;)]*\b\w*\.?{re.escape(property_name)}\s*\('
        call_site_match = re.search(func_call_pattern, content)

        if not call_site_match:
            logger.debug(f"Skipping validation function {func_name} - property {property_name} not passed to this function")
            continue

        logger.debug(f"Found validation function {func_name} that validates property {property_name}")

        # Use the function definition chunk for finding comparison patterns
        chunk = func_def_chunk

        # Look for comparison patterns in this chunk
        # We're looking for patterns like: mechanism != constant::name
        # Use a generic parameter name search since we don't know the exact param name
        comparison_pattern = r'(\w+)\s*!=\s*([\w:]+::name)'

        matches = re.findall(comparison_pattern, chunk)
        if matches:
            # Group by parameter name
            by_param = {}
            for param_name, constant_ref in matches:
                if param_name not in by_param:
                    by_param[param_name] = []
                by_param[param_name].append(constant_ref)

            # Process the parameter with the most comparisons (likely the one we want)
            if by_param:
                most_common_param = max(by_param.keys(), key=lambda k: len(by_param[k]))
                constant_refs = by_param[most_common_param]

                logger.debug(f"Found {len(constant_refs)} comparisons in function {func_name} for parameter {most_common_param}")

                # Resolve each constant to its actual value
                enum_values = []
                for constant_ref in constant_refs:
                    # Extract the class/struct name (remove ::name)
                    class_ref = constant_ref.replace('::name', '')

                    # Search for the class definition and extract the name constant
                    result = resolver._resolve_authenticator_name(class_ref)
                    if result:
                        enum_values.append(result)
                        logger.debug(f"Resolved {constant_ref} → '{result['value']}' (enterprise={result['is_enterprise']})")

                if enum_values:
                    logger.info(f"Extracted {len(enum_values)} enum values from runtime validation for {property_name}: {[v['value'] for v in enum_values]}")
                    return enum_values

    logger.debug(f"No runtime validation enum constraint found for {property_name}")
    return None
