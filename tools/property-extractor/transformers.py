import re
import logging
from property_bag import PropertyBag
from parser import normalize_string

# Get logger for this module
logger = logging.getLogger(__name__)

# Import the process_enterprise_value function from property_extractor
# Note: We import at function level to avoid circular imports since property_extractor
# imports transformers.py. This pattern allows the EnterpriseTransformer to access
# the centralized enterprise value processing logic without creating import cycles.
def get_process_enterprise_value():
    """
    Lazily load the centralized process_enterprise_value function from property_extractor.
    
    Attempts to import and return the `process_enterprise_value` callable; logs an error and returns `None` if the import fails.
    
    Returns:
        The `process_enterprise_value` callable if available, `None` otherwise.
    """
    try:
        from property_extractor import process_enterprise_value
        return process_enterprise_value
    except ImportError as e:
        logger.error("Cannot import process_enterprise_value from property_extractor: %s", e)
        return None


def get_resolve_constexpr_identifier():
    """
    Lazily import and return the `resolve_constexpr_identifier` function from `property_extractor`.
    
    Attempts to import `resolve_constexpr_identifier` and return it to avoid circular-import issues.
    
    Returns:
        Callable or None: The `resolve_constexpr_identifier` callable when available, otherwise `None`.
    """
    try:
        from property_extractor import resolve_constexpr_identifier
        return resolve_constexpr_identifier
    except ImportError as e:
        logger.exception("Cannot import resolve_constexpr_identifier from property_extractor: %s", e)
        return None


class BasicInfoTransformer:
    def accepts(self, info, file_pair):
        """
        Always accepts the provided info and file_pair.
        
        Parameters:
        	info (dict): Parsed metadata for a property (annotation/params/declaration).
        	file_pair (object): Pair of source/implementation file metadata used by transformers.
        
        Returns:
        	bool: Always returns True, indicating this transformer should be applied.
        """
        return True

    def parse(self, property, info, file_pair):
        if not info.get("params") or len(info["params"]) == 0:
            return property
            
        property["name"] = info["params"][0]["value"]
        property["defined_in"] = re.sub(
            r"^.*src/", "src/", str(file_pair.implementation)
        )
        property["description"] = (
            info["params"][1]["value"] if len(info["params"]) > 1 else None
        )


class IsNullableTransformer:
    def accepts(self, info, file_pair):
        return True

    def parse(self, property, info, file_pair):
        if len(info["params"]) > 2 and "required" in info["params"][2]["value"]:
            is_required = (
                re.sub(r"^.*::", "", info["params"][2]["value"]["required"]) == "yes"
            )
            property["nullable"] = not is_required
        elif "std::optional" in info["declaration"]:
            property["nullable"] = True
        else:
            property["nullable"] = False

        return property


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


class NeedsRestartTransformer:
    def accepts(self, info, file_pair):
        return True
    
    def parse(self, property, info, file_pair):
        needs_restart = "yes"
        if len(info["params"]) > 2 and "needs_restart" in info["params"][2]["value"]:
            needs_restart = re.sub(
                r"^.*::", "", info["params"][2]["value"]["needs_restart"]
            )
        property["needs_restart"] = needs_restart != "no"  # True by default, unless we find "no"

class GetsRestoredTransformer:
    def accepts(self, info, file_pair):
        # only run if the third param blob exists and has our flag
        return (
            len(info.get("params", [])) > 2
            and isinstance(info["params"][2].get("value"), dict)
            and "gets_restored" in info["params"][2]["value"]
        )

    def parse(self, property, info, file_pair):
        raw = info["params"][2]["value"]["gets_restored"]
        # strip off e.g. "gets_restored::no" → "no"
        flag = re.sub(r"^.*::", "", raw)
        # store as boolean
        property["gets_restored"] = (flag != "no")


class VisibilityTransformer:
    def accepts(self, info, file_pair):
        return (
            True
            if len(info["params"]) > 2 and "visibility" in info["params"][2]["value"]
            else False
        )

    def parse(self, property, info, file_pair):
        property["visibility"] = re.sub(
            r"^.*::", "", info["params"][2]["value"]["visibility"]
        )


class TypeTransformer:
    
    # Class-level constants for type pattern matching
    # Shared with IsArrayTransformer for consistency
    ARRAY_PATTERN_STD_VECTOR = "std::vector"
    ARRAY_PATTERN_ONE_OR_MANY = "one_or_many_property"
    OPTIONAL_PATTERN = "std::optional"
    
    def accepts(self, info, file_pair):
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
                re.sub(r"^.*property<(.+)>.*", "\\1", one_line_declaration)
                .split()[0]
                .replace(",", "")
            )

        if self.OPTIONAL_PATTERN in raw_type:
            raw_type = re.sub(".*std::optional<(.+)>.*", "\\1", raw_type)

        if self.ARRAY_PATTERN_STD_VECTOR in raw_type:
            raw_type = re.sub(".*std::vector<(.+)>.*", "\\1", raw_type)
        
        # Handle one_or_many_property<T> - extract the inner type T
        # This is essential for Redpanda's flexible configuration properties
        # that can accept either single values or arrays
        # Check and extract from raw_type for consistency with other type extractors
        if self.ARRAY_PATTERN_ONE_OR_MANY in raw_type:
            raw_type = re.sub(".*one_or_many_property<(.+)>.*", "\\1", raw_type)
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
        Set the property's "type" field to the JSON schema type derived from the C++ declaration.
        
        Parameters:
        	property (dict): Mutable property bag to be updated.
        	info (dict): Parsed property metadata; its "declaration" field is used to determine the type.
        	file_pair: Unused here; present for transformer interface compatibility.
        
        Returns:
        	property (dict): The same property bag with "type" set to the derived type string.
        """
        property["type"] = self.get_type_from_declaration(info["declaration"])
        return property


class DeprecatedTransformer:
    def accepts(self, info, file_pair):
        return "deprecated_property" in info["declaration"] or (
            len(info["params"]) > 2
            and "visibility" in info["params"][2]["value"]
            and "deprecated" in info["params"][2]["value"]["visibility"]
        )

    def parse(self, property, info, file_pair):
        property["is_deprecated"] = True
        property["type"] = None


class IsSecretTransformer:
    def accepts(self, info, file_pair):
        return (
            True
            if len(info["params"]) > 2 and "secret" in info["params"][2]["value"]
            else False
        )

    def parse(self, property, info, file_pair):
        is_secret = re.sub(r"^.*::", "", info["params"][2]["value"]["secret"])
        property["is_secret"] = is_secret == "yes"


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


class SimpleDefaultValuesTransformer:
    def accepts(self, info, file_pair):
        # The default value is the 4th parameter.
        return info["params"] and len(info["params"]) > 3

    def parse(self, property, info, file_pair):
        default = info["params"][3]["value"]

        # Handle simple cases.
        if default == "std::nullopt":
            property["default"] = None
        elif default == "{}":
            pass
        elif isinstance(default, PropertyBag):
            property["default"] = default
        elif re.search(r"^-?[0-9][0-9']*$", default):  # integers (allow digit group separators)
           property["default"] = int(re.sub(r"[^0-9-]", "", default))
        elif re.search(r"^-?[0-9]+(\.[0-9]+)?$", default):  # floats
           property["default"] = float(re.sub(r"[^0-9.\-]", "", default))
        elif re.search("^(true|false)$", default):  # booleans
            property["default"] = True if default == "true" else False
        elif re.search(r"^\{[^:]+\}$", default):  # string lists
            property["default"] = [
                normalize_string(s)
                for s in re.sub(r"{([^}]+)}", r"\1", default).split(",")
            ]
        else:
            # File sizes.
            matches = re.search("^([0-9]+)_(.)iB$", default)
            if matches:
                size = int(matches.group(1))
                unit = matches.group(2)
                if unit == "K":
                    size = size * 1024
                elif unit == "M":
                    size = size * 1024**2
                elif unit == "G":
                    size = size * 1024**3
                elif unit == "T":
                    size = size * 1024**4
                elif unit == "P":
                    size = size * 1024**5
                property["default"] = size
            elif re.search("^(https|/[^/])", default):  # URLs and paths
                property["default"] = default
            else:
                # For durations, enums, or other default initializations.
                if not re.search("([0-9]|::|\\()", default):
                    property["default"] = default
                else:
                    property["default"] = default


class FriendlyDefaultTransformer:
    """
    Transforms C++ default expressions into a more user-friendly format for docs.
    Handles cases like:
      - std::numeric_limits<uint64_t>::max()
      - std::chrono::seconds(15min)
      - std::vector<ss::sstring>{"basic"}
      - std::chrono::milliseconds(10)
      - std::nullopt
    """
    
    # Class-level constants for pattern matching in default values
    ARRAY_PATTERN_STD_VECTOR = "std::vector"
    SSTRING_CONSTRUCTOR_PATTERN = r'ss::sstring\{([a-zA-Z_][a-zA-Z0-9_]*)\}'
    VECTOR_INITIALIZER_PATTERN = r'std::vector<[^>]+>\s*\{(.*)\}$'
    CHRONO_PATTERN = r"std::chrono::(\w+)\(([^)]+)\)"
    
    def __init__(self):
        """
        Initialize the transformer and set up a placeholder for a lazily-loaded resolver.
        
        Sets self._resolver to None to indicate the resolver has not been loaded yet.
        """
        self._resolver = None
    
    def accepts(self, info, file_pair):
        """
        Determine whether the transformer should run for the given property info by checking for a fourth parameter.
        
        Parameters:
        	info (dict): Parsed property metadata; expects a "params" list when present.
        	file_pair (tuple): Source/implementation file pair (unused by this check).
        
        Returns:
        	`true` if `info["params"]` exists and contains at least four items, `false` otherwise.
        """
        return info.get("params") and len(info["params"]) > 3

    def _get_resolver(self):
        """
        Lazily load and cache the constexpr identifier resolver.
        
        Returns:
            callable or None: The resolver function if available, or `None` if it could not be loaded.
        """
        if self._resolver is None:
            resolver = get_resolve_constexpr_identifier()
            self._resolver = resolver if resolver else False
        return self._resolver if self._resolver is not False else None

    def _resolve_identifier(self, identifier):
        """
        Resolve a constexpr identifier to its corresponding string value.
        
        Parameters:
            identifier (str): Identifier to resolve (for example, "scram" or "gssapi").
        
        Returns:
            str or None: The resolved string value if successful, `None` when the identifier is invalid or cannot be resolved.
        """
        if not identifier or not isinstance(identifier, str):
            logger.warning(f"Invalid identifier for resolution: {identifier}")
            return None
            
        resolver = self._get_resolver()
        if resolver:
            try:
                return resolver(identifier)
            except (AttributeError, TypeError, ValueError) as e:
                logger.debug(f"Failed to resolve identifier '{identifier}': {e}")
            except Exception as e:
                logger.exception(f"Unexpected error resolving identifier '{identifier}': {e}")
        
        return None
    
    def _process_sstring_constructor(self, item):
        """
        Convert an ss::sstring{identifier} constructor string to its resolved value when possible.
        
        If the input matches the ss::sstring{...} pattern, attempts to resolve the enclosed identifier and returns the resolved string. If resolution fails, returns the raw identifier. If the input does not match the pattern or is falsy, returns it unchanged.
        
        Parameters:
            item (str): The constructor expression or string to process.
        
        Returns:
            str: The resolved string when resolution succeeds, the extracted identifier if resolution fails, or the original input if it does not match.
        """
        if not item:
            return item
            
        match = re.match(self.SSTRING_CONSTRUCTOR_PATTERN, item)
        if not match:
            return item
            
        identifier = match.group(1)
        resolved = self._resolve_identifier(identifier)
        
        if resolved:
            logger.debug(f"Resolved ss::sstring{{{identifier}}} -> '{resolved}'")
            return resolved
        
        # Log warning but continue with original identifier
        logger.warning(f"Could not resolve identifier '{identifier}' in ss::sstring constructor")
        return identifier

    def _parse_vector_contents(self, contents):
        """
        Parse a comma-separated std::vector initializer string into a list of cleaned, processed items.
        
        Parameters:
            contents (str): The inner contents of a vector initializer (e.g. '\"a\", ss::sstring{ID}, \"b\"'); may be empty or None.
        
        Returns:
            list: Ordered list of processed, unquoted items with empty entries omitted.
        """
        if not contents:
            return []
            
        # Split by comma and process each item
        raw_items = [contents] if ',' not in contents else contents.split(',')
        
        processed_items = []
        for item in raw_items:
            item = item.strip(' "\'')
            if item:  # Skip empty items
                processed_item = self._process_sstring_constructor(item)
                processed_items.append(processed_item)
        
        return processed_items

    def parse(self, property, info, file_pair):
        """
        Convert a C++ default expression into a JSON-friendly value and store it on the property under the "default" key.
        
        Parameters:
            property (dict): Property dictionary to modify; updated in place with a "default" entry.
            info (dict): Parsed property information; the default expression is expected at info["params"][3]["value"].
            file_pair: File pair context (ignored by this function).
        
        Returns:
            dict: The modified property dictionary with a normalized "default" value.
        """
        default = info["params"][3]["value"]
        
        # Handle null/empty defaults
        if not default:
            return property

        # Transform std::nullopt into None
        if "std::nullopt" in default:
            property["default"] = None
            return property

        # Transform std::numeric_limits expressions
        if "std::numeric_limits" in default:
            property["default"] = "Maximum value"
            return property

        # Transform std::chrono durations
        if "std::chrono" in default:
            match = re.search(self.CHRONO_PATTERN, default)
            if match:
                unit = match.group(1)
                value = match.group(2).strip()
                property["default"] = f"{value} {unit}"
                return property

        # Transform std::vector defaults
        if self.ARRAY_PATTERN_STD_VECTOR in default:
            vector_match = re.search(self.VECTOR_INITIALIZER_PATTERN, default)
            if vector_match:
                contents = vector_match.group(1).strip()
                items = self._parse_vector_contents(contents)
                property["default"] = items
                return property

        # For all other cases, leave the default as-is
        property["default"] = default
        return property


class ExperimentalTransformer:
    def accepts(self, info, file_pair):
        return info.get("type") is not None and info["type"].startswith(("development_", "hidden_when_default_"))
    def parse(self, property, info, file_pair):
        property["is_experimental_property"] = True
        return property


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


class EnterpriseTransformer:
    """
    Transforms enterprise property values from C++ expressions to user-friendly JSON.

    This transformer processes enterprise values by delegating to the
    centralized process_enterprise_value function which handles the full range of
    C++ expression types found in enterprise property definitions.
    """
    def accepts(self, info, file_pair):
        """
        Return True if the provided info indicates an enterprise-only property.
        
        Parameters:
            info (dict): The metadata dictionary for a property. This function checks for a 'type' key whose string contains 'enterprise'.
            file_pair: Unused; present for transformer interface compatibility.
        
        Returns:
            bool: True when info contains a 'type' that includes 'enterprise', otherwise False.
        """
        return bool(info.get('type') and 'enterprise' in info['type'])

    def parse(self, property, info, file_pair):
        """
        Mark a property as enterprise-only and attach its enterprise value.
        
        If an enterprise value is present in info['params'][0]['value'], this method attempts to process it using the shared
        process_enterprise_value helper (loaded via get_process_enterprise_value()). If the processor is unavailable or raises
        an exception, the raw enterprise value is used.
        
        Side effects:
        - Sets property["enterprise_value"] to the processed or raw value.
        - Sets property["is_enterprise"] = True.
        - Removes the first element from info['params'].
        
        Parameters:
            property (dict): Property bag to modify and return.
            info (dict): Parsed metadata; must have a non-None 'params' list for processing.
            file_pair: Unused here but accepted for transformer API compatibility.
        
        Returns:
            dict: The updated property bag.
        """
        if info['params'] is not None:
            enterpriseValue = info['params'][0]['value']
            
            # Get the processing function
            process_enterprise_value = get_process_enterprise_value()
            if process_enterprise_value is None:
                property["enterprise_value"] = enterpriseValue
                property['is_enterprise'] = True
                del info['params'][0]
                return property
            
            try:
                processed_value = process_enterprise_value(enterpriseValue)
                property["enterprise_value"] = processed_value
            except Exception:
                # Fallback to raw value if processing fails
                property["enterprise_value"] = enterpriseValue

            property['is_enterprise'] = True
            del info['params'][0]
            return property


class MetaParamTransformer:
    def accepts(self, info, file_pair):
        """
        Check if the given info contains parameters that include a meta{...} value.
        """
        if 'params' in info:
            for param in info['params']:
                if isinstance(param, dict) and 'value' in param:
                    value = param['value']
                    if isinstance(value, str) and value.startswith("meta{"):
                        return True
        return False

    def parse(self, property, info, file_pair):
        """
        Transform into a structured dictionary.
        """
        if 'params' not in info or info['params'] is None:
            return property

        iterable_params = info['params']
        for param in iterable_params:
            if isinstance(param['value'], str) and param['value'].startswith("meta{"):
                # Extract content between meta{ and } using explicit slicing
                param_value = param['value']
                if param_value.endswith('}'):
                    meta_content = param_value[5:-1].strip()  # Remove "meta{" and "}"
                else:
                    # Handle malformed meta{ without closing }
                    meta_content = param_value[5:].strip()  # Remove "meta{" only
                
                meta_dict = {}
                for item in meta_content.split(','):
                    item = item.strip()
                    if '=' in item:
                        key, value = item.split('=')
                        meta_dict[key.strip().replace('.', '')] = value.strip()
                        meta_dict['type'] = 'initializer_list'  # Enforce required type
                param['value'] = meta_dict