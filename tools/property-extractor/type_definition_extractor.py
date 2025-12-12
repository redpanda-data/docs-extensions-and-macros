#!/usr/bin/env python3
"""
Dynamic C++ Type Definition Extractor

This module dynamically extracts type definitions from Redpanda C++ source code:
- Struct and class definitions with their fields
- Enum definitions with their values
- Type aliases (using/typedef)

The extracted definitions are formatted into a JSON schema-like dictionary for use in property documentation generation.
"""

import os
import re
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


class TypeDefinitionExtractor:
    """
    Extracts C++ type definitions from source code to build a dynamic definitions dictionary.

    This automatically discovers:
    - Structs used in properties (model::broker_endpoint, config::tls_config, etc.)
    - Enums and their values (model::compression, model::cleanup_policy_bitflags, etc.)
    - Nested type definitions
    """

    def __init__(self, source_path):
        """
        Initialize the extractor.

        Args:
            source_path (str): Path to Redpanda source directory
        """
        self.source_path = Path(source_path)
        self.definitions = {}
        self.enum_cache = {}
        self.struct_cache = {}

    def extract_all_definitions(self):
        """
        Extract all type definitions from the source tree.

        Returns:
            dict: Dictionary of {type_name: definition} in JSON schema format
        """
        logger.info("🔍 Extracting type definitions from C++ source...")

        # Scan these directories for type definitions
        # These are relative to the source_path provided
        search_dirs = [
            'model',
            'config',
            'net',
            'kafka',
            'pandaproxy',
            'security',
            'utils',
        ]

        for search_dir in search_dirs:
            full_path = self.source_path / search_dir
            if not full_path.exists():
                logger.debug(f"Skipping non-existent directory: {search_dir}")
                continue

            self._scan_directory(full_path, search_dir)

        logger.info(f"✅ Extracted {len(self.definitions)} type definitions")
        logger.info(f"   - {len(self.enum_cache)} enums")
        logger.info(f"   - {len(self.struct_cache)} structs/classes")

        return self.definitions

    def _scan_directory(self, directory, relative_path):
        """
        Recursively scan a directory for C++ header files and extract definitions.

        Args:
            directory (Path): Directory to scan
            relative_path (str): Relative path for source references
        """
        for header_file in directory.rglob('*.h'):
            try:
                self._extract_from_file(header_file, relative_path)
            except Exception as e:
                logger.debug(f"Error processing {header_file}: {e}")

    def _extract_from_file(self, file_path, relative_path):
        """
        Extract type definitions from a single C++ header file.

        Args:
            file_path (Path): Path to header file
            relative_path (str): Relative path for source references
        """
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
        except (OSError, UnicodeDecodeError) as e:
            logger.debug(f"Cannot read {file_path}: {e}")
            return

        # Extract enums first (they're simpler)
        self._extract_enums(content, file_path, relative_path)

        # Then extract type aliases (using/typedef)
        self._extract_type_aliases(content, file_path, relative_path)

        # Then extract struct/class definitions
        self._extract_structs(content, file_path, relative_path)

    def _extract_enums(self, content, file_path, relative_path):
        """
        Extract enum definitions and their values.

        Pattern matches:
        - enum class name : type { value1, value2, ... };
        - enum name { value1, value2, ... };
        """
        # Pattern for enum class with optional underlying type
        # Handle both simple types (uint8_t) and qualified types (std::uint16_t)
        enum_pattern = re.compile(
            r'enum\s+(?:class\s+)?(\w+)\s*(?::\s*[\w:]+)?\s*\{([^}]+)\}',
            re.MULTILINE | re.DOTALL
        )

        for match in enum_pattern.finditer(content):
            enum_name = match.group(1)
            enum_body = match.group(2)

            # Extract enum values (handle comments and assignments)
            # Remove comments FIRST before splitting by comma to avoid issues with commas in comments
            cleaned_body = re.sub(r'//.*$', '', enum_body, flags=re.MULTILINE)
            cleaned_body = re.sub(r'/\*.*?\*/', '', cleaned_body, flags=re.DOTALL)

            values = []
            for line in cleaned_body.split(','):
                line = line.strip()

                if not line:
                    continue

                # Extract value name (before = if assignment exists)
                value_match = re.match(r'^(\w+)', line)
                if value_match:
                    value_name = value_match.group(1)
                    values.append(value_name)

            if values:
                # Try to determine the namespace/qualified name
                namespace = self._extract_namespace(content, match.start())
                qualified_name = f"{namespace}::{enum_name}" if namespace else enum_name

                # Look for a corresponding _to_string() conversion function
                string_mappings = self._extract_enum_to_string_mappings(content, enum_name, values, file_path)

                definition = {
                    "type": "enum",
                    "enum": values,
                    "defined_in": str(file_path.relative_to(self.source_path))
                }

                # If we found string mappings, add them to the definition
                if string_mappings:
                    definition["enum_string_mappings"] = string_mappings
                    # Use mapped strings as the enum values for documentation
                    definition["enum"] = [string_mappings.get(v, v) for v in values]
                    logger.debug(f"Found {len(string_mappings)} string mappings for enum: {qualified_name}")

                self.definitions[qualified_name] = definition
                self.enum_cache[qualified_name] = definition["enum"]

                logger.debug(f"Found enum: {qualified_name} with {len(values)} values")

    def _extract_enum_to_string_mappings(self, content, enum_name, enum_values, file_path=None):
        """
        Extract enum-to-string conversion mappings from multiple C++ patterns.

        Looks for patterns like:
        1. _to_string() function:
           const char* write_caching_mode_to_string(write_caching_mode s) {
               switch (s) {
               case write_caching_mode::default_true:
                   return "true";
               }
           }

        2. operator<< overload:
           std::ostream& operator<<(std::ostream& os, timestamp_type ts) {
               switch (ts) {
               case timestamp_type::append_time:
                   return os << "LogAppendTime";
               }
           }

        3. string_switch pattern (operator>> or parse functions):
           ts_type = string_switch<timestamp_type>(s)
                       .match("LogAppendTime", timestamp_type::append_time)
                       .match("CreateTime", timestamp_type::create_time);

        Args:
            content: The file content to search
            enum_name: Name of the enum
            enum_values: List of enum value names
            file_path: Optional Path object of the file being processed

        Returns:
            dict: Mapping of enum values to their string representations
        """
        mappings = {}

        # Helper function to search for mappings in content
        def search_content(search_content):
            found_mappings = {}

            # Pattern 1: Look for _to_string() function
            to_string_pattern = rf'{enum_name}_to_string\s*\([^)]+\)\s*\{{([^}}]+(?:\{{[^}}]*\}}[^}}]*)*)\}}'
            match = re.search(to_string_pattern, search_content, re.MULTILINE | re.DOTALL)
            if match:
                function_body = match.group(1)
                case_pattern = rf'case\s+(?:{enum_name}::)?(\w+)\s*:\s*(?:.*?return\s*"([^"]+)"|.*?return\s*std::string_view\{{"([^"]+)"\}})'
                for case_match in re.finditer(case_pattern, function_body, re.MULTILINE | re.DOTALL):
                    enum_value = case_match.group(1)
                    string_value = case_match.group(2) or case_match.group(3)
                    if enum_value in enum_values and string_value:
                        found_mappings[enum_value] = string_value

            # Pattern 2: Look for operator<< overload
            operator_pattern = rf'operator<<\s*\([^,]+,\s*(?:const\s+)?{enum_name}\s+\w+\)\s*\{{([^}}]+(?:\{{[^}}]*\}}[^}}]*)*)\}}'
            match = re.search(operator_pattern, search_content, re.MULTILINE | re.DOTALL)
            if match:
                function_body = match.group(1)
                case_pattern = rf'case\s+(?:{enum_name}::)?(\w+)\s*:\s*.*?(?:os|o)\s*<<\s*"([^"]+)"'
                for case_match in re.finditer(case_pattern, function_body, re.MULTILINE | re.DOTALL):
                    enum_value = case_match.group(1)
                    string_value = case_match.group(2)
                    if enum_value in enum_values and string_value:
                        found_mappings[enum_value] = string_value

            # Pattern 3: Look for string_switch pattern
            string_switch_pattern = rf'string_switch<{enum_name}>\s*\([^)]+\)((?:\s*\.match\s*\([^)]+\))+)'
            for switch_match in re.finditer(string_switch_pattern, search_content, re.MULTILINE | re.DOTALL):
                matches_block = switch_match.group(1)
                match_pattern = r'\.match\s*\(\s*"([^"]+)"\s*,\s*(?:' + enum_name + r'::)?(\w+)\s*\)'
                for match_call in re.finditer(match_pattern, matches_block):
                    string_value = match_call.group(1)
                    enum_value = match_call.group(2)
                    if enum_value in enum_values and string_value:
                        found_mappings[enum_value] = string_value

            # Pattern 4: Look for to_string_view() or to_string() standalone functions
            # Handles: constexpr std::string_view to_string_view(enum_name v) { switch(v) { case enum_name::value: return "string"; } }
            to_string_view_pattern = rf'(?:constexpr\s+)?(?:std::string_view|const\s+char\*|ss::sstring)\s+to_string(?:_view)?\s*\(\s*{enum_name}\s+\w+\s*\)\s*\{{([^}}]+(?:\{{[^}}]*\}}[^}}]*)*)\}}'
            match = re.search(to_string_view_pattern, search_content, re.MULTILINE | re.DOTALL)
            if match:
                function_body = match.group(1)
                # Match: case enum_name::value: return "string";
                case_pattern = rf'case\s+{enum_name}::(\w+)\s*:\s*return\s+"([^"]+)"'
                for case_match in re.finditer(case_pattern, function_body, re.MULTILINE | re.DOTALL):
                    enum_value = case_match.group(1)
                    string_value = case_match.group(2)
                    if enum_value in enum_values and string_value:
                        found_mappings[enum_value] = string_value

            return found_mappings

        # First try the current file content
        mappings = search_content(content)

        # If no mappings found and we have a file path, search related files
        if not mappings and file_path:
            files_to_search = []

            # If this is a .h file, look for corresponding .cc file
            if file_path.suffix == '.h':
                cc_path = file_path.with_suffix('.cc')
                if cc_path.exists():
                    files_to_search.append(cc_path)

                # Also look for parent directory's main .cc file (for example, model/model.cc)
                parent_dir = file_path.parent
                parent_cc = parent_dir / f"{parent_dir.name}.cc"
                if parent_cc.exists() and parent_cc != cc_path:
                    files_to_search.append(parent_cc)

            # Search each related file
            for search_file in files_to_search:
                try:
                    with open(search_file, 'r', encoding='utf-8', errors='ignore') as f:
                        file_content = f.read()
                        file_mappings = search_content(file_content)
                        if file_mappings:
                            mappings.update(file_mappings)
                            logger.debug(f"Found {len(file_mappings)} string mappings for {enum_name} in {search_file.name}")
                            break  # Stop after finding mappings
                except Exception as e:
                    logger.debug(f"Could not read {search_file}: {e}")

        # Log the found mappings
        for enum_value, string_value in mappings.items():
            logger.debug(f"Mapped {enum_name}::{enum_value} -> \"{string_value}\"")

        return mappings

    def _extract_type_aliases(self, content, file_path, relative_path):
        """
        Extract type aliases (using/typedef declarations).

        Pattern matches:
        - using name = type;
        - using name = named_type<underlying_type, ...>;
        - typedef type name;
        """
        # Pattern for 'using' declarations
        # Matches: using node_id = named_type<int32_t, ...>;
        #          using my_type = std::string;
        using_pattern = re.compile(
            r'using\s+(\w+)\s*=\s*(.+?);',
            re.MULTILINE
        )

        for match in using_pattern.finditer(content):
            alias_name = match.group(1)
            alias_type = match.group(2).strip()

            # Try to determine the underlying type
            json_type = self._resolve_alias_type(alias_type)

            if json_type:
                # Try to determine the namespace/qualified name
                namespace = self._extract_namespace(content, match.start())
                qualified_name = f"{namespace}::{alias_name}" if namespace else alias_name

                definition = {
                    "type": json_type,
                    "defined_in": str(file_path.relative_to(self.source_path)),
                    "alias_for": alias_type
                }

                # Add min/max for integer types
                if json_type == "integer":
                    if "int32_t" in alias_type:
                        definition["minimum"] = -2147483648
                        definition["maximum"] = 2147483647
                    elif "int64_t" in alias_type:
                        definition["minimum"] = -9223372036854775808
                        definition["maximum"] = 9223372036854775807
                    elif "uint32_t" in alias_type:
                        definition["minimum"] = 0
                        definition["maximum"] = 4294967295
                    elif "uint64_t" in alias_type:
                        definition["minimum"] = 0
                        definition["maximum"] = 18446744073709551615

                self.definitions[qualified_name] = definition
                logger.debug(f"Found type alias: {qualified_name} = {alias_type} → {json_type}")

    def _resolve_alias_type(self, alias_type):
        """
        Resolve a C++ type alias to a JSON schema type.

        Args:
            alias_type (str): The C++ type expression (for example, "named_type<int32_t, ...>")

        Returns:
            str: JSON schema type (integer, string, etc.) or None if unknown
        """
        alias_type = alias_type.strip()

        # Handle named_type<T, ...> pattern - extract the underlying type
        named_type_match = re.match(r'named_type<\s*([^,>]+)', alias_type)
        if named_type_match:
            underlying_type = named_type_match.group(1).strip()
            return self._cpp_type_to_json_type(underlying_type)

        # Handle direct type aliases
        return self._cpp_type_to_json_type(alias_type)

    def _extract_structs(self, content, file_path, relative_path):
        """
        Extract struct/class definitions and their fields.

        Pattern matches:
        - struct name { field_type field_name; ... };
        - class name { public: field_type field_name; ... };
        """
        # Pattern for struct/class declaration (without capturing body)
        # Handles: struct name { ... }, class name { ... }
        # With optional: final, override keywords and inheritance
        struct_decl_pattern = re.compile(
            r'(?:struct|class)\s+(\w+)\s*(?:final|override)?\s*(?::\s*[^{]+)?\s*\{',
            re.MULTILINE
        )

        for match in struct_decl_pattern.finditer(content):
            struct_name = match.group(1)

            # Skip template definitions (too complex for now)
            if '<' in struct_name or 'template' in content[max(0, match.start()-50):match.start()]:
                continue

            # Use brace-counting to extract the complete body
            body_start = match.end()
            struct_body = self._extract_braced_content(content, body_start)

            if not struct_body:
                continue

            # Extract fields
            properties = self._extract_fields(struct_body)

            if properties:
                # Try to determine the namespace/qualified name
                namespace = self._extract_namespace(content, match.start())
                qualified_name = f"{namespace}::{struct_name}" if namespace else struct_name

                definition = {
                    "type": "object",
                    "properties": properties,
                    "defined_in": str(file_path.relative_to(self.source_path))
                }

                self.definitions[qualified_name] = definition
                self.struct_cache[qualified_name] = properties

                logger.debug(f"Found struct: {qualified_name} with {len(properties)} fields")

    def _extract_braced_content(self, content, start_pos):
        """
        Extract content within matching braces using brace-counting.

        Args:
            content (str): Full file content
            start_pos (int): Position right after opening brace

        Returns:
            str: Content between braces (not including the braces themselves)
        """
        brace_count = 1
        pos = start_pos

        while brace_count > 0 and pos < len(content):
            if content[pos] == '{':
                brace_count += 1
            elif content[pos] == '}':
                brace_count -= 1
            pos += 1

        if brace_count == 0:
            # Successfully found matching brace
            return content[start_pos:pos-1]

        return ""

    def _extract_fields(self, struct_body):
        """
        Extract field definitions from a struct/class body.
        Extracts all fields (including private) and public accessor methods.
        Private fields will be filtered out when outputting to JSON.

        Extracts:
        - All data members (including private fields starting with _)
        - Public const methods that return a value (simple accessors like `host()`, `port()`)

        Returns:
            dict: {field_name: field_definition}
        """
        properties = {}

        # Track current access level (structs default to public, classes to private)
        # We'll assume public for simplicity since most config types use structs
        current_access = 'public'

        # Split body into lines to track access specifiers
        lines = struct_body.split('\n')

        # Pattern for access specifiers
        access_pattern = re.compile(r'^\s*(public|private|protected)\s*:')

        # Pattern for field declarations
        # Matches: type field_name; or type field_name{default};
        field_pattern = re.compile(
            r'([\w:]+(?:<[^>]+>)?)\s+(\w+)\s*(?:\{[^}]*\})?;'
        )

        # Pattern for getter methods (accessor methods)
        # Matches: type name() const { return _name; } or const type& name() const;
        getter_pattern = re.compile(
            r'(?:const\s+)?([\w:]+(?:<[^>]+>)?)\s*(?:&)?\s+(\w+)\s*\(\s*\)\s*const'
        )

        for line in lines:
            # Check for access specifier
            access_match = access_pattern.match(line)
            if access_match:
                current_access = access_match.group(1)
                continue

            # Extract getter methods only from public sections
            if current_access == 'public':
                # Skip lines with friend or operator declarations
                if 'friend' in line or 'operator' in line:
                    continue

                # Look for getter methods (public accessor methods)
                getter_match = getter_pattern.search(line)
                if getter_match:
                    return_type = getter_match.group(1).strip()
                    method_name = getter_match.group(2).strip()

                    # Skip special methods and single-letter names (likely from multiline parsing)
                    if method_name in ('operator', 'get', 'begin', 'end', 'size', 'empty') or len(method_name) == 1:
                        continue

                    # Skip methods with common getter prefixes (get_, is_, has_, can_, should_)
                    # We only want simple accessors like host(), port(), family()
                    # Not complex getters like get_crl_file(), is_enabled(), etc.
                    if any(method_name.startswith(prefix) for prefix in ['get_', 'is_', 'has_', 'can_', 'should_']):
                        continue

                    # Convert C++ type to JSON schema type
                    json_type = self._cpp_type_to_json_type(return_type)

                    # Use method name as field name (for example, host() becomes "host")
                    properties[method_name] = {"type": json_type}
                    continue

            # Extract field declarations from all sections (public and private)
            field_match = field_pattern.search(line)
            if field_match:
                field_type = field_match.group(1).strip()
                field_name = field_match.group(2).strip()

                # Skip non-data members
                if field_name in ('public', 'private', 'protected', 'static', 'const'):
                    continue

                # Convert C++ type to JSON schema type
                json_type = self._cpp_type_to_json_type(field_type)

                properties[field_name] = {"type": json_type}

        return properties

    def _extract_namespace(self, content, position):
        """
        Extract the namespace at a given position in the file.

        Args:
            content (str): File content
            position (int): Position in the file

        Returns:
            str: Namespace (for example, "model" or "config::tls")
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

    def _cpp_type_to_json_type(self, cpp_type):
        """
        Convert a C++ type to a JSON schema type.

        Args:
            cpp_type (str): C++ type name

        Returns:
            str: JSON schema type (object, string, integer, boolean, array)
        """
        cpp_type = cpp_type.strip()

        # Remove const, reference, pointer qualifiers
        cpp_type = re.sub(r'\bconst\b', '', cpp_type)
        cpp_type = re.sub(r'[&*]', '', cpp_type)
        cpp_type = cpp_type.strip()

        # Map common C++ types to JSON types
        if cpp_type in ('bool', 'boolean'):
            return 'boolean'

        if cpp_type in ('int', 'int32_t', 'int64_t', 'uint32_t', 'uint64_t',
                       'size_t', 'long', 'short', 'unsigned'):
            return 'integer'

        if cpp_type in ('float', 'double'):
            return 'number'

        if 'string' in cpp_type.lower() or cpp_type == 'ss::sstring':
            return 'string'

        if 'vector' in cpp_type or 'array' in cpp_type:
            return 'array'

        if 'optional' in cpp_type:
            # Extract inner type from std::optional<T>
            inner_match = re.match(r'std::optional<(.+)>', cpp_type)
            if inner_match:
                inner_type = inner_match.group(1)
                return self._cpp_type_to_json_type(inner_type)

        # Handle empty types (edge case from complex parsing)
        if not cpp_type:
            return 'string'

        # Default to object for complex types
        if '::' in cpp_type or cpp_type[0].isupper():
            return 'object'

        # Unknown type - default to string
        return 'string'


def extract_definitions_from_source(source_path):
    """
    Convenience function to extract all type definitions from Redpanda source.

    Args:
        source_path (str): Path to Redpanda source directory

    Returns:
        dict: Dictionary of type definitions in JSON schema format
    """
    extractor = TypeDefinitionExtractor(source_path)
    return extractor.extract_all_definitions()


if __name__ == "__main__":
    import sys
    import json

    if len(sys.argv) < 2:
        print("Usage: python3 type_definition_extractor.py <redpanda_source_path>")
        sys.exit(1)

    logging.basicConfig(level=logging.INFO)

    source_path = sys.argv[1]
    definitions = extract_definitions_from_source(source_path)

    print(json.dumps(definitions, indent=2))
