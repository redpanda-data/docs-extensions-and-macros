#!/usr/bin/env python3
"""
Resolves C++ constant references to their actual values.

For properties that use constants as default values (e.g., `ss::sstring{net::tls_v1_2_cipher_suites}`),
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
            constant_name: The constant name (e.g., "net::tls_v1_2_cipher_suites" or "tls_v1_2_cipher_suites")

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
            patterns: List of file patterns to search (e.g., ['net/tls.cc'])
            identifier: The constant identifier (e.g., 'tls_v1_2_cipher_suites')

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

    def _extract_constant_value(self, content: str, identifier: str) -> Optional[str]:
        """
        Extract a constant's string value from C++ source code.

        Handles formats like:
        - const std::string_view identifier = "value";
        - constexpr std::string_view identifier = "value";
        - const ss::sstring identifier = "value";
        - Multi-line concatenated strings

        Args:
            content: The C++ source code
            identifier: The constant identifier

        Returns:
            The extracted string value, or None if not found
        """
        # Pattern for constant declaration with string value
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
