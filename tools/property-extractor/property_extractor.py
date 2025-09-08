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

3. **Documentation Generation** (generate_docs.py):
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

from pathlib import Path
from file_pair import FilePair
from tree_sitter import Language, Parser

from parser import build_treesitter_cpp_library, extract_properties_from_file_pair
from property_bag import PropertyBag
from transformers import *

logger = logging.getLogger("viewer")


def resolve_cpp_function_call(function_name):
    """
    Dynamically resolve C++ function calls to their return values by searching the source code.
    
    Args:
        function_name: The C++ function name (e.g., "model::kafka_audit_logging_topic")
    
    Returns:
        The resolved string value or None if not found
    """
    # Map function names to likely search patterns and file locations
    search_patterns = {
        'model::kafka_audit_logging_topic': {
            'patterns': [
                r'inline\s+const\s+model::topic\s+kafka_audit_logging_topic\s*\(\s*"([^"]+)"\s*\)',
                r'const\s+model::topic\s+kafka_audit_logging_topic\s*\(\s*"([^"]+)"\s*\)',
                r'model::topic\s+kafka_audit_logging_topic\s*\(\s*"([^"]+)"\s*\)',
                r'std::string_view\s+kafka_audit_logging_topic\s*\(\s*\)\s*\{\s*return\s*"([^"]+)"',
                r'inline\s+std::string_view\s+kafka_audit_logging_topic\s*\(\s*\)\s*\{\s*return\s*"([^"]+)"'
            ],
            'files': ['src/v/model/namespace.h', 'src/v/model/namespace.cc', 'src/v/model/kafka_namespace.h']
        },
        'model::kafka_consumer_offsets_topic': {
            'patterns': [
                r'inline\s+const\s+model::topic\s+kafka_consumer_offsets_topic\s*\(\s*"([^"]+)"\s*\)',
                r'const\s+model::topic\s+kafka_consumer_offsets_topic\s*\(\s*"([^"]+)"\s*\)',
                r'model::topic\s+kafka_consumer_offsets_topic\s*\(\s*"([^"]+)"\s*\)',
                r'std::string_view\s+kafka_consumer_offsets_topic\s*\(\s*\)\s*\{\s*return\s*"([^"]+)"',
                r'inline\s+std::string_view\s+kafka_consumer_offsets_topic\s*\(\s*\)\s*\{\s*return\s*"([^"]+)"'
            ],
            'files': ['src/v/model/namespace.h', 'src/v/model/namespace.cc', 'src/v/model/kafka_namespace.h']
        },
        'model::kafka_internal_namespace': {
            'patterns': [
                r'inline\s+const\s+model::ns\s+kafka_internal_namespace\s*\(\s*"([^"]+)"\s*\)',
                r'const\s+model::ns\s+kafka_internal_namespace\s*\(\s*"([^"]+)"\s*\)',
                r'model::ns\s+kafka_internal_namespace\s*\(\s*"([^"]+)"\s*\)',
                r'std::string_view\s+kafka_internal_namespace\s*\(\s*\)\s*\{\s*return\s*"([^"]+)"',
                r'inline\s+std::string_view\s+kafka_internal_namespace\s*\(\s*\)\s*\{\s*return\s*"([^"]+)"'
            ],
            'files': ['src/v/model/namespace.h', 'src/v/model/namespace.cc', 'src/v/model/kafka_namespace.h']
        }
    }
    
    # Check if we have search patterns for this function
    if function_name not in search_patterns:
        logger.debug(f"No search patterns defined for function: {function_name}")
        return None
    
    config = search_patterns[function_name]
    
    # Try to find the Redpanda source directory
    # Look for it in the standard locations used by the property extractor
    redpanda_source_paths = [
        'tmp/redpanda',  # Current directory
        '../tmp/redpanda',  # Parent directory  
        'tools/property-extractor/tmp/redpanda',  # From project root
        os.path.join(os.getcwd(), 'tools', 'property-extractor', 'tmp', 'redpanda')
    ]
    
    redpanda_source = None
    for path in redpanda_source_paths:
        if os.path.exists(path):
            redpanda_source = path
            break
    
    if not redpanda_source:
        logger.warning(f"Could not find Redpanda source directory to resolve function: {function_name}")
        return None
    
    # Search in the specified files
    for file_path in config['files']:
        full_path = os.path.join(redpanda_source, file_path)
        if not os.path.exists(full_path):
            continue
            
        try:
            with open(full_path, 'r', encoding='utf-8') as f:
                content = f.read()
                
            # Try each pattern
            for pattern in config['patterns']:
                match = re.search(pattern, content, re.MULTILINE | re.DOTALL)
                if match:
                    resolved_value = match.group(1)
                    logger.debug(f"Resolved {function_name}() -> '{resolved_value}' from {file_path}")
                    return resolved_value
                    
        except Exception as e:
            logger.debug(f"Error reading {full_path}: {e}")
            continue
    
    # If not found in specific files, do a broader search
    logger.debug(f"Function {function_name} not found in expected files, doing broader search...")
    
    # Search more broadly in the model directory
    model_dir = os.path.join(redpanda_source, 'src', 'v', 'model')
    if os.path.exists(model_dir):
        for root, dirs, files in os.walk(model_dir):
            for file in files:
                if file.endswith('.h') or file.endswith('.cc'):
                    file_path = os.path.join(root, file)
                    try:
                        with open(file_path, 'r', encoding='utf-8') as f:
                            content = f.read()
                        
                        # Try patterns for this file
                        for pattern in config['patterns']:
                            match = re.search(pattern, content, re.MULTILINE | re.DOTALL)
                            if match:
                                resolved_value = match.group(1)
                                logger.debug(f"Resolved {function_name}() -> '{resolved_value}' from {file_path}")
                                return resolved_value
                                
                    except Exception as e:
                        logger.debug(f"Error reading {file_path}: {e}")
                        continue
    
    logger.warning(f"Could not resolve function call: {function_name}()")
    return None


def validate_paths(options):
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

    file_iter = path.rglob("*.h") if options.recursive else path.rglob("*.h")

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
    transformers = [
        EnterpriseTransformer(), ## this must be the first, as it modifies current data
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
        NumericBoundsTransformer(type_transformer),
        DurationBoundsTransformer(type_transformer),
        SimpleDefaultValuesTransformer(),
        FriendlyDefaultTransformer(),
        ExperimentalTransformer(),
        AliasTransformer(),
    ]

    all_properties = PropertyBag()

    for fp, properties in files_with_properties:
        for name in properties:
            # ignore private properties
            if re.match(r"^_", name):
                continue

            property_definition = PropertyBag()

            for transformer in transformers:
                if transformer.accepts(properties[name], fp):
                    transformer.parse(property_definition, properties[name], fp)

            if len(property_definition) > 0:
                all_properties[name] = property_definition

    return all_properties


# The definitions.json file contains type definitions that the extractor uses to standardize and centralize type information. After extracting and transforming the properties from the source code, the function merge_properties_and_definitions looks up each property's type in the definitions. If a property's type (or the type of its items, in the case of arrays) matches one of the definitions, the transformer replaces that type with a JSON pointer ( such as #/definitions/<type>) to the corresponding entry in definitions.json. The final JSON output then includes both a properties section (with types now referencing the definitions) and a definitions section, so that consumers of the output can easily resolve the full type information.
def merge_properties_and_definitions(properties, definitions):
    # Do not overwrite the resolved type/default with a reference. Just return the resolved properties and definitions.
    return dict(properties=properties, definitions=definitions)


def apply_property_overrides(properties, overrides, overrides_file_path=None):
    """
    Apply property overrides from the overrides JSON file to enhance property documentation.
    
    This function allows customizing property documentation by providing overrides for:
    
    1. description: Override the auto-extracted property description with custom text
    2. version: Add version information showing when the property was introduced
    3. example: Add AsciiDoc example sections with flexible input formats (see below)
    4. default: Override the auto-extracted default value
    
    Multiple example input formats are supported for user convenience:
    
    1. Direct AsciiDoc string:
       "example": ".Example\n[,yaml]\n----\nredpanda:\n  property_name: value\n----"
    
    2. Multi-line array (each element becomes a line):
       "example": [
         ".Example",
         "[,yaml]",
         "----",
         "redpanda:",
         "  property_name: value",
         "----"
       ]
    
    3. External file reference:
       "example_file": "examples/property_name.adoc"
    
    4. Auto-formatted YAML with title and description:
       "example_yaml": {
         "title": "Example Configuration",
         "description": "This shows how to configure the property.",
         "config": {
           "redpanda": {
             "property_name": "value"
           }
         }
       }
    
    Args:
        properties: Dictionary of extracted properties from C++ source
        overrides: Dictionary loaded from overrides JSON file
        overrides_file_path: Path to the overrides file (for resolving relative example_file paths)
    
    Returns:
        Updated properties dictionary with overrides applied
    """
    if overrides and "properties" in overrides:
        for prop, override in overrides["properties"].items():
            if prop in properties:
                # Apply description override
                if "description" in override:
                    properties[prop]["description"] = override["description"]
                
                # Apply version override (introduced in version)
                if "version" in override:
                    properties[prop]["version"] = override["version"]
                
                # Apply example override with multiple input format support
                example_content = _process_example_override(override, overrides_file_path)
                if example_content:
                    properties[prop]["example"] = example_content
                
                # Apply default override
                if "default" in override:
                    properties[prop]["default"] = override["default"]
    return properties


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
                print(f"Warning: Example file not found: {override['example_file']}")
                print(f"Searched in: {', '.join(search_paths)}")
                return None
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return f.read().strip()
        except Exception as e:
            print(f"Error reading example file {file_path}: {e}")
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
    Add a config_scope field to each property based on its defined_in value.
    'cluster' if defined_in == src/v/config/configuration.cc
    'broker' if defined_in == src/v/config/node_config.cc
    """
    for prop in properties.values():
        defined_in = prop.get("defined_in", "")
        if defined_in == "src/v/config/configuration.cc":
            prop["config_scope"] = "cluster"
        elif defined_in == "src/v/config/node_config.cc":
            prop["config_scope"] = "broker"
        else:
            prop["config_scope"] = None
    return properties


def resolve_type_and_default(properties, definitions):
    """
    Resolve type references and expand default values for all properties.
    
    This function performs several critical transformations:
    
    1. **Type Resolution**: Converts C++ type names to JSON schema types
       - model::broker_endpoint -> "object"
       - std::string -> "string"
       - Handles both direct type names and JSON pointer references (#/definitions/...)
    
    2. **Default Value Expansion**: Transforms C++ constructor syntax to JSON objects
       - model::broker_endpoint(net::unresolved_address("127.0.0.1", 9644)) 
         -> {address: "127.0.0.1", port: 9644}
    
    3. **Array Default Handling**: Ensures one_or_many_property defaults are arrays
       - For properties with type="array", wraps single object defaults in arrays
       - Converts empty object strings "{}" to empty arrays []
       
    This is essential for one_or_many_property types like 'admin' which should show:
    - Type: array
    - Default: [{address: "127.0.0.1", port: 9644}] (not just {address: ...})
    """
    import ast
    import re

    def resolve_definition_type(defn):
        """Recursively resolve $ref pointers to get the actual type definition."""
        # Recursively resolve $ref
        while isinstance(defn, dict) and "$ref" in defn:
            ref = defn["$ref"]
            ref_name = ref.split("/")[-1]
            defn = definitions.get(ref_name, defn)
        return defn

    def parse_constructor(s):
        """Parse C++ constructor syntax into type name and arguments."""
        s = s.strip()
        if s.startswith("{") and s.endswith("}"):
            s = s[1:-1].strip()
        match = re.match(r'([a-zA-Z0-9_:]+)\((.*)\)', s)
        if not match:
            # Primitive or enum
            if s.startswith('"') and s.endswith('"'):
                return None, [ast.literal_eval(s)]
            try:
                return None, [int(s)]
            except Exception:
                return None, [s]
        type_name, arg_str = match.groups()
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
                if c == '(' and not in_string:
                    depth += 1
                elif c == ')' and not in_string:
                    depth -= 1
                current += c
        if current.strip():
            args.append(current.strip())
        return type_name, args

    def process_cpp_patterns(arg_str):
        """
        Process specific C++ patterns to user-friendly values.
        
        Handles:
        - net::unresolved_address("127.0.0.1", 9092) -> expands based on type definition
        - std::nullopt -> null
        - fips_mode_flag::disabled -> "disabled"
        - model::kafka_audit_logging_topic() -> dynamically looked up from source
        """
        arg_str = arg_str.strip()
        
        # Handle std::nullopt -> null
        if arg_str == "std::nullopt":
            return "null"
        
        # Handle C++ function calls that return constant values
        # Dynamically look up function return values from the source code
        function_call_match = re.match(r'([a-zA-Z0-9_:]+)\(\)', arg_str)
        if function_call_match:
            function_name = function_call_match.group(1)
            resolved_value = resolve_cpp_function_call(function_name)
            if resolved_value is not None:
                return f'"{resolved_value}"'
        
        # Handle enum-like patterns (such as fips_mode_flag::disabled -> "disabled")
        enum_match = re.match(r'[a-zA-Z0-9_:]+::([a-zA-Z0-9_]+)', arg_str)
        if enum_match:
            enum_value = enum_match.group(1)
            return f'"{enum_value}"'
        
        # Handle default constructors and their default values
        # This handles cases where C++ default constructors are used but should map to specific values
        
        # Pattern 1: Full constructor syntax like config::leaders_preference{}
        constructor_patterns = {
            r'config::leaders_preference\{\}': '"none"',  # Based on C++ code analysis
            r'std::chrono::seconds\{0\}': '0',
            r'std::chrono::milliseconds\{0\}': '0',
            r'model::timeout_clock::duration\{\}': '0',
            r'config::data_directory_path\{\}': '""',
            r'std::optional<[^>]+>\{\}': 'null',  # Empty optional
        }
        
        for pattern, replacement in constructor_patterns.items():
            if re.match(pattern, arg_str):
                return replacement
        
        # Pattern 2: Truncated type names that likely came from default constructors
        # These are cases where tree-sitter parsing truncated "config::type{}" to just "type"
        truncated_patterns = {
            'leaders_preference': '"none"',  # config::leaders_preference{} -> none
            'data_directory_path': '""',     # config::data_directory_path{} -> empty string
            'timeout_clock_duration': '0',   # model::timeout_clock::duration{} -> 0
            'log_level': '"info"',           # Default log level
            'compression_type': '"none"',    # Default compression
        }
        
        # Check if arg_str is exactly one of these truncated patterns
        if arg_str in truncated_patterns:
            return truncated_patterns[arg_str]
        
        # Pattern 3: Handle remaining default constructor syntax generically
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
        Expand C++ default values into structured JSON objects.
        
        For array types with initializer list syntax like:
        {model::broker_endpoint(net::unresolved_address("127.0.0.1", 9644))}
        
        This creates: [{address: "127.0.0.1", port: 9644}]
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
            
        type_def = resolve_definition_type(definitions.get(type_name, {}))
        if "enum" in type_def:
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
                                if j < len(nested_args):
                                    nested_arg = nested_args[j]
                                    # Apply simple C++ pattern processing to the argument
                                    processed_nested_arg = process_cpp_patterns(nested_arg)
                                    
                                    # Convert the processed argument based on the property type
                                    if nested_prop_def.get("type") == "string":
                                        if processed_nested_arg.startswith('"') and processed_nested_arg.endswith('"'):
                                            nested_result[nested_prop] = ast.literal_eval(processed_nested_arg)
                                        else:
                                            nested_result[nested_prop] = processed_nested_arg
                                    elif nested_prop_def.get("type") == "integer":
                                        try:
                                            nested_result[nested_prop] = int(processed_nested_arg)
                                        except ValueError:
                                            nested_result[nested_prop] = processed_nested_arg
                                    elif nested_prop_def.get("type") == "boolean":
                                        nested_result[nested_prop] = processed_nested_arg.lower() == "true"
                                    else:
                                        nested_result[nested_prop] = processed_nested_arg
                                else:
                                    nested_result[nested_prop] = None
                            
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
                                        if remaining_prop not in result:
                                            result[remaining_prop] = None
                                    break
                                else:
                                    # Map the nested object to the current property
                                    result[prop] = nested_result
                        else:
                            # Fallback: recursively expand with the expected property type
                            expanded_arg = expand_default(sub_type, arg)
                            result[prop] = expanded_arg
                    else:
                        # Simple value, parse based on the property type
                        # First apply C++ pattern processing
                        processed_arg = process_cpp_patterns(arg)
                        
                        if sub_type == "string":
                            # If processed_arg is already quoted, use ast.literal_eval, otherwise keep as is
                            if processed_arg.startswith('"') and processed_arg.endswith('"'):
                                result[prop] = ast.literal_eval(processed_arg)
                            else:
                                result[prop] = processed_arg
                        elif sub_type == "integer":
                            try:
                                result[prop] = int(processed_arg)
                            except ValueError:
                                # If conversion fails, keep as string (might be processed C++ pattern)
                                result[prop] = processed_arg
                        elif sub_type == "boolean":
                            result[prop] = processed_arg.lower() == "true"
                        else:
                            result[prop] = processed_arg
                else:
                    result[prop] = None
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
        
        # Handle both JSON pointer references and direct type names
        if isinstance(t, str):
            if t.startswith("#/definitions/"):
                ref_name = t.split("/")[-1]
            elif t in definitions:
                ref_name = t
        
        if ref_name and ref_name in definitions:
            defn = definitions.get(ref_name)
            if defn:
                resolved = resolve_definition_type(defn)
                # Always set type to the resolved type string (object, string, etc.)
                resolved_type = resolved.get("type")
                if resolved_type in ("object", "string", "integer", "boolean", "array", "number"):
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
        
        # Also handle array item types
        if prop.get("type") == "array" and "items" in prop:
            items_type = prop["items"].get("type")
            if isinstance(items_type, str) and items_type in definitions:
                item_defn = definitions.get(items_type)
                if item_defn:
                    resolved_item = resolve_definition_type(item_defn)
                    resolved_item_type = resolved_item.get("type")
                    if resolved_item_type in ("object", "string", "integer", "boolean", "array", "number"):
                        prop["items"]["type"] = resolved_item_type
                    else:
                        prop["items"]["type"] = "object"  # fallback for complex types
    
    # Final pass: apply C++ pattern processing to any remaining unprocessed defaults
    for prop in properties.values():
        if "default" in prop:
            default_value = prop["default"]
            
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
                                            if j < len(args):
                                                nested_arg = args[j]
                                                processed_nested_arg = process_cpp_patterns(nested_arg)
                                                
                                                # Convert based on property type
                                                if nested_prop_def.get("type") == "string":
                                                    if processed_nested_arg.startswith('"') and processed_nested_arg.endswith('"'):
                                                        nested_result[nested_prop] = ast.literal_eval(processed_nested_arg)
                                                    else:
                                                        nested_result[nested_prop] = processed_nested_arg
                                                elif nested_prop_def.get("type") == "integer":
                                                    try:
                                                        nested_result[nested_prop] = int(processed_nested_arg)
                                                    except ValueError:
                                                        nested_result[nested_prop] = processed_nested_arg
                                                elif nested_prop_def.get("type") == "boolean":
                                                    nested_result[nested_prop] = processed_nested_arg.lower() == "true"
                                                else:
                                                    nested_result[nested_prop] = processed_nested_arg
                                            else:
                                                nested_result[nested_prop] = None
                                        
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
                        
    return properties


def main():
    import argparse

    def generate_options():
        arg_parser = argparse.ArgumentParser(
            description="Extract all properties from the Redpanda's source code and generate a JSON output with their definitions"
        )
        arg_parser.add_argument(
            "--path",
            type=str,
            required=True,
            help="Path to the Redpanda's source dir to extract the properties",
        )

        arg_parser.add_argument(
            "--recursive", action="store_true", help="Scan the path recursively"
        )

        arg_parser.add_argument(
            "--output",
            type=str,
            required=False,
            help="File to store the JSON output. If no file is provided, the JSON will be printed to the standard output",
        )

        arg_parser.add_argument(
            "--enhanced-output",
            type=str,
            required=False,
            help="File to store the enhanced JSON output with overrides applied (such as 'dev-properties.json')",
        )

        arg_parser.add_argument(
            "--definitions",
            type=str,
            required=False,
            default=os.path.dirname(os.path.realpath(__file__)) + "/definitions.json",
            help='JSON file with the type definitions. This file will be merged in the output under the "definitions" field',
        )

        arg_parser.add_argument(
            "--overrides",
            type=str,
            required=False,
            help='Optional JSON file with property description overrides',
        )

        arg_parser.add_argument("-v", "--verbose", action="store_true")

        return arg_parser

    arg_parser = generate_options()
    options, _ = arg_parser.parse_known_args()

    if options.verbose:
        logging.basicConfig(level="DEBUG")
    else:
        logging.basicConfig(level="INFO")

    validate_paths(options)

    file_pairs = get_file_pairs(options)

    if not file_pairs:
        logging.error("No h/cc file pairs were found")
        sys.exit(-1)

    definitions = None

    if options.definitions:
        try:
            with open(options.definitions) as json_file:
                definitions = json.load(json_file)
        except json.JSONDecodeError as e:
            logging.error(f"Failed to parse definitions file: {e}")
            sys.exit(1)

    # Load property overrides if provided
    overrides = None
    if options.overrides:
        try:
            with open(options.overrides) as f:
                overrides = json.load(f)
        except Exception as e:
            logging.error(f"Failed to load overrides file: {e}")
            sys.exit(1)

    treesitter_dir = os.path.join(os.getcwd(), "tree-sitter/tree-sitter-cpp")
    destination_path = os.path.join(treesitter_dir, "tree-sitter-cpp.so")

    if not os.path.exists(os.path.join(treesitter_dir, "src/parser.c")):
        logging.error("Missing parser.c. Ensure Tree-sitter submodules are initialized.")
        sys.exit(1)

    treesitter_parser, cpp_language = get_treesitter_cpp_parser_and_language(
        treesitter_dir, destination_path
    )


    files_with_properties = get_files_with_properties(
        file_pairs, treesitter_parser, cpp_language
    )
    properties = transform_files_with_properties(files_with_properties)

    # First, create the original properties without overrides for the base JSON output
    # 1. Add config_scope field based on which source file defines the property
    original_properties = add_config_scope(properties.copy())
    
    # 2. Resolve type references and expand default values for original properties
    original_properties = resolve_type_and_default(original_properties, definitions)
    
    # Generate original properties JSON (without overrides)
    original_properties_and_definitions = merge_properties_and_definitions(
        original_properties, definitions
    )
    original_json_output = json.dumps(original_properties_and_definitions, indent=4, sort_keys=True)

    # Now create enhanced properties with overrides applied
    # 1. Apply any description overrides from external override files
    enhanced_properties = apply_property_overrides(properties, overrides, options.overrides)
    
    # 2. Add config_scope field based on which source file defines the property
    enhanced_properties = add_config_scope(enhanced_properties)
    
    # 3. Resolve type references and expand default values
    # This step converts:
    # - C++ type names (model::broker_endpoint) to JSON schema types (object)  
    # - C++ constructor defaults to structured JSON objects
    # - Single object defaults to arrays for one_or_many_property types
    enhanced_properties = resolve_type_and_default(enhanced_properties, definitions)

    # Generate enhanced properties JSON (with overrides)
    enhanced_properties_and_definitions = merge_properties_and_definitions(
        enhanced_properties, definitions
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
