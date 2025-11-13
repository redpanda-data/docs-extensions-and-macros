from file_pair import FilePair
from tree_sitter import Language
from property_bag import PropertyBag
from copy import deepcopy
import itertools as it
import re
import logging

logger = logging.getLogger(__name__)

def _is_config_property_type(type_str):
    """
    Check if a C++ type is a Redpanda configuration property.

    Returns True only for property wrapper types like:
    - property<T>
    - bounded_property<T>
    - deprecated_property<T>
    - one_or_many_property<T>
    - enum_property<T>
    - enterprise<property<T>>
    - enterprise<bounded_property<T>>

    Returns False for internal structs like:
    - connection_cfg, consumer_cfg, ack_level, proxy_request, etc.
    - Primitive types: ss::sstring, iobuf, std::vector<T>, etc.
    """
    if not type_str:
        return False

    type_str = type_str.strip()

    # Known property wrapper types (defined first for exclusion check)
    PROPERTY_WRAPPERS = [
        'property<',
        'bounded_property<',
        'deprecated_property<',
        'one_or_many_property<',
        'enum_property<',
        'retention_duration_property',
        'development_feature_property<',
        'hidden_when_default_property<',
    ]

    # Explicitly exclude common non-property types
    # (unless they're wrapped in a property type)
    NON_PROPERTY_TYPES = [
        'ss::sstring',
        'sstring',
        'iobuf',
        'std::string',
        'std::vector<',
        'std::optional<',
        'std::chrono::',
        'model::node_id',
        'net::unresolved_address',
        'serde::envelope<',
    ]

    # Check if type contains any property wrapper
    has_property_wrapper = any(
        wrapper in type_str or type_str.startswith(wrapper.replace('<', ''))
        for wrapper in PROPERTY_WRAPPERS
    )

    # Quick rejection of known non-property types (unless wrapped in property)
    if not has_property_wrapper:
        for non_prop in NON_PROPERTY_TYPES:
            if non_prop in type_str:
                return False

    # Check for direct property wrapper usage
    if any(type_str.startswith(wrapper.replace('<', '')) or wrapper in type_str
           for wrapper in PROPERTY_WRAPPERS):
        return True

    # Check for enterprise wrapper containing property types
    if type_str.startswith('enterprise<'):
        return any(wrapper in type_str for wrapper in PROPERTY_WRAPPERS)

    return False



HEADER_QUERY = """
(field_declaration
    type: [
        (type_identifier)
        (template_type)
        (qualified_identifier)
    ] @type
    declarator: (field_identifier) @name
) @declaration
"""


# Tree-sitter query for extracting C++ property constructor arguments and enterprise values
#
# - Capture all expression types including:
#   * call_expression: Handles function calls like model::kafka_audit_logging_topic()
#   * template_instantiation: Handles template syntax like std::vector<ss::sstring>{...}
#   * concatenated_string: Handles C++ string concatenation with +
#   * qualified_identifier: Handles namespaced identifiers like model::partition_autobalancing_mode::continuous
#   * (_) @argument: Fallback to capture any other expression types
#
# This ensures enterprise values are captured in their complete form for proper
# processing by the process_enterprise_value function.
SOURCE_QUERY = """
(field_initializer_list
    (field_initializer
        (field_identifier) @field
        (argument_list 
            [
                (call_expression) @argument
                (initializer_list) @argument
                (template_instantiation) @argument
                (concatenated_string) @argument
                (string_literal) @argument
                (raw_string_literal) @argument
                (identifier) @argument
                (qualified_identifier) @argument
                (number_literal) @argument
                (true) @argument
                (false) @argument
                (_) @argument
            ]
        )? @arguments
    ) @field
)
"""

INITIALIZER_LIST_QUERY = """
(initializer_list
  (initializer_pair
    designator: (_
      (field_identifier) @name)
    value: (_) @value
))
"""

MAX_INITIALIZER_LIST_DEPTH = 10


def get_file_contents(path):
    contents = ""

    with open(path, "rb") as f:
        contents = f.read()

    return contents


def parse_cpp_header(treesitter_parser, cpp_language, source_code):
    """
    Parses a C++ configuration header file to extract property declarations
    and classify them by type (enterprise, deprecated, bounded, etc.).

    Detects and annotates:
      - is_enterprise
      - is_deprecated
      - is_bounded
      - is_enum
      - is_one_or_many
      - is_enterprise_wrapper
      - base_property_type (the inner C++ type, if extractable)
      - property_kinds (list of wrapper kinds, e.g. ['enterprise', 'bounded'])
    """

    query = cpp_language.query(HEADER_QUERY)
    tree = treesitter_parser.parse(source_code)

    captures = query.captures(tree.root_node)
    properties = PropertyBag()

    current_declaration = None
    current_type = None

    for node, label in captures:
        if label == "name":
            property_name = node.text.decode("utf-8")
            
            # Validate this is a config property type - skip internal structs
            if not _is_config_property_type(current_type):
                logger.debug(f"Skipping non-property field '{property_name}' with type '{current_type}'")
                current_type = None
                current_declaration = None
                continue
                
            properties[property_name]["name_in_file"] = property_name
            properties[property_name]["type"] = current_type
            properties[property_name]["declaration"] = current_declaration

            t = current_type or ""

            # --- Detect property wrapper kinds dynamically ---
            wrapper_kinds = [
                "enterprise",
                "deprecated_property",
                "bounded_property",
                "enum_property",
                "one_or_many_property",
                "property",
            ]

            property_kinds = [k for k in wrapper_kinds if k in t]

            # --- Flags for common wrappers ---
            properties[property_name]["is_enterprise"] = "enterprise<" in t
            properties[property_name]["is_deprecated"] = "deprecated_property" in t
            properties[property_name]["is_bounded"] = "bounded_property" in t
            properties[property_name]["is_enum"] = "enum_property" in t
            properties[property_name]["is_one_or_many"] = "one_or_many_property" in t
            properties[property_name]["is_enterprise_wrapper"] = t.strip().startswith("enterprise<")
            properties[property_name]["property_kinds"] = property_kinds

            # --- Extract inner property type (recursively handles nesting) ---
            base_match = re.search(r'property<\s*([^>]+)\s*>', t)
            if base_match:
                properties[property_name]["base_property_type"] = base_match.group(1).strip()
            else:
                properties[property_name]["base_property_type"] = None

            current_type = None
            current_declaration = None

        elif label == "type":
            current_type = node.text.decode("utf-8")
        elif label == "declaration":
            current_declaration = node.text.decode("utf-8")

    return properties


def __unquote_string(value):
    # placeholder to keep escaped double quotes (e.g. \"name\")
    escaped_quotes_placeholder = "$$$___quote___$$$"
    
    # Handle C++ raw string literals: R"(content)" or R"delimiter(content)delimiter"
    # First try simple case without delimiter: R"(content)"
    simple_raw_match = re.match(r'^R"[(](.*)[)]"\s*$', value.strip(), re.DOTALL)
    if simple_raw_match:
        return simple_raw_match.group(1)
    
    # Handle raw string with custom delimiter: R"delimiter(content)delimiter"  
    delimited_raw_match = re.match(r'^R"([^(]+)[(](.*)[)]\1"\s*$', value.strip(), re.DOTALL)
    if delimited_raw_match:
        return delimited_raw_match.group(2)
    
    # Handle regular quoted strings
    return re.sub(
        r'^"([^"]*)"\s*$',
        "\\1",
        re.sub(
            '\\\\"',
            escaped_quotes_placeholder,
            value.strip().replace('\\\\"', escaped_quotes_placeholder),
        ),
    ).replace(escaped_quotes_placeholder, '"')


def normalize_string(value):
    return __unquote_string(value)


def __normalize_concatenated_string(value):
    return "".join(
        __unquote_string(s)
        for s in it.filterfalse(lambda r: re.search("^//", r), value.split("\n"))
    )


def __normalize_initializer_list(
    value, node, treesitter_parser, cpp_language, source_code
):
    query = cpp_language.query(INITIALIZER_LIST_QUERY)
    tree = treesitter_parser.parse(source_code)

    captures = query.captures(
        tree.root_node, start_point=node.start_point, end_point=node.end_point
    )

    if len(captures) == 0:
        return value.replace("\n", "")

    current_field = None
    fields = PropertyBag()
    for c in captures:
        list_node = c[0]
        capture_label = c[1]

        if capture_label == "name":
            current_field = list_node.text.decode("utf-8")
        else:
            param = dict(value=list_node.text.decode("utf-8"), type=list_node.type)
            fields[current_field] = (
                __normalize_param(
                    param, list_node, treesitter_parser, cpp_language, source_code
                )["value"]
                if current_field
                else node.text.decode("utf-8")
            )
            current_field = None

    return fields


def __normalize_param(param, node, treesitter_parser, cpp_language, source_code):
    if param["type"] == "comment":
        return

    if param["type"] == "string_literal" or param["type"] == "raw_string_literal":
        param["value"] = normalize_string(param["value"])
    elif param["type"] == "concatenated_string":
        param["value"] = __normalize_concatenated_string(param["value"])
        param["type"] = "string_literal"
    elif param["type"] == "initializer_list":
        param["value"] = __normalize_initializer_list(
            param["value"], node, treesitter_parser, cpp_language, source_code
        )
    else:
        param["value"] = param["value"].replace("\n", "")

    return param


def parse_cpp_source(treesitter_parser, cpp_language, source_code):
    """
    Parse C++ source file and extract constructor arguments for each config field.

    For each field initializer like:

        core_balancing_continuous(
            *this,
            true,
            false,
            "core_balancing_continuous",
            "If set to ...",
            meta{ ... },
            true,
            property<bool>::noop_validator,
            legacy_default<bool>{false, legacy_version{16}})

    we produce:

        parameters["core_balancing_continuous"]["params"] = [
            { "value": "true",  "type": "true" },
            { "value": "false", "type": "false" },
            { "value": "core_balancing_continuous", "type": "string_literal" },
            { "value": "If set to ...", "type": "string_literal" },
            { "value": { ... }, "type": "initializer_list" },
            { "value": "true", "type": "true" },
            { "value": "property<bool>::noop_validator", "type": "call_expression" },
            { "value": "legacy_default<bool>{false, legacy_version{16}}", "type": "_" },
        ]

    (the initial `*this` is intentionally skipped).
    """
    query = cpp_language.query(SOURCE_QUERY)
    tree = treesitter_parser.parse(source_code)
    captures = query.captures(tree.root_node)

    parameters = PropertyBag()
    current_field = None
    seen_first_argument = False

    for node, label in captures:
        # Start of a new field initializer
        if label == "field" and node.type == "field_identifier":
            current_field = node.text.decode("utf-8")
            parameters[current_field] = PropertyBag()
            parameters[current_field]["params"] = []
            seen_first_argument = False
            continue

        # Individual arguments for the current field
        if label == "argument" and current_field is not None:
            raw_value = node.text.decode("utf-8").strip()

            # Skip the first argument if it's the context pointer (*this)
            if not seen_first_argument:
                seen_first_argument = True
                if raw_value == "*this":
                    continue  # do not store *this
                # If the first argument is not *this (weird edge case), fall through and record it.

            param = dict(value=raw_value, type=node.type or "_")
            normalized_param = __normalize_param(
                param, node, treesitter_parser, cpp_language, source_code
            )

            if normalized_param:
                parameters[current_field]["params"].append(normalized_param)

    return parameters



def __merge_header_and_source_properties(header_properties, source_properties):
    """
    Merge header-based property metadata (types, wrappers, flags)
    with source-based initialization parameters.

    This function ensures:
      - Header-only metadata like 'is_enterprise', 'base_property_type', etc.
        are always preserved.
      - Source-derived data like 'params' are merged without overwriting
        header metadata.
      - Missing source entries still return valid PropertyBags with only header info.
    """
    properties = deepcopy(header_properties)

    for key, header_entry in header_properties.items():
        merged = deepcopy(header_entry)

        if key in source_properties:
            # Merge parameter list
            source_entry = source_properties[key]
            for k, v in source_entry.items():
                # If the key doesn't exist in header, copy it over
                # Otherwise, keep header's metadata (type flags, etc.)
                if k not in merged:
                    merged[k] = v
                elif k == "params":
                    # Always take params from source
                    merged["params"] = v

        else:
            # No source info → ensure params is at least an empty list
            merged["params"] = merged.get("params", [])

        # Reinforce that header metadata should not be lost
        for meta_key in [
            "type",
            "declaration",
            "is_enterprise",
            "is_deprecated",
            "is_bounded",
            "is_enum",
            "is_one_or_many",
            "is_enterprise_wrapper",
            "base_property_type",
            "property_kinds",
        ]:
            if meta_key not in merged and meta_key in header_entry:
                merged[meta_key] = header_entry[meta_key]

        properties[key] = merged

    return properties

def extract_properties_from_file_pair(
    treesitter_parser, cpp_language, file_pair: FilePair
):
    header_properties = parse_cpp_header(
        treesitter_parser, cpp_language, get_file_contents(file_pair.header)
    )

    if len(header_properties) == 0:
        return PropertyBag()

    source_properties = parse_cpp_source(
        treesitter_parser, cpp_language, get_file_contents(file_pair.implementation)
    )

    if len(source_properties) == 0:
        return PropertyBag()

    return __merge_header_and_source_properties(header_properties, source_properties)


def build_treesitter_cpp_library(src_dir, destination_path):
    Language.build_library(destination_path, [src_dir])
