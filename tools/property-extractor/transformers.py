import re
from property_bag import PropertyBag
from parser import normalize_string

# Import the process_enterprise_value function from property_extractor
# Note: We import at function level to avoid circular imports since property_extractor
# imports transformers.py. This pattern allows the EnterpriseTransformer to access
# the centralized enterprise value processing logic without creating import cycles.
def get_process_enterprise_value():
    try:
        from property_extractor import process_enterprise_value
        return process_enterprise_value
    except ImportError as e:
        print(f"ERROR: Cannot import process_enterprise_value: {e}")
        return None


class BasicInfoTransformer:
    def accepts(self, info, file_pair):
        return True

    def parse(self, property, info, file_pair):
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
        Extract the inner type from C++ property declarations.
        
        This method handles various C++ template types and extracts the core type T from:
        - property<T> -> T
        - std::optional<T> -> T
        - std::vector<T> -> T  
        - one_or_many_property<T> -> T (Redpanda's flexible array type)
        
        For one_or_many_property, this is crucial because it allows the same property
        to accept either a single value or an array of values in the configuration.
        Examples:
        - one_or_many_property<model::broker_endpoint> -> model::broker_endpoint
        - one_or_many_property<endpoint_tls_config> -> endpoint_tls_config
        
        The extracted type is then used to determine the JSON schema type and
        for resolving default values from the definitions.
        """
        one_line_declaration = declaration.replace("\n", "").strip()
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

        return raw_type

    def parse(self, property, info, file_pair):
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
    
    def accepts(self, info, file_pair):
        return info.get("params") and len(info["params"]) > 3

    def parse(self, property, info, file_pair):
        default = info["params"][3]["value"]

        # Transform std::nullopt into None.
        if "std::nullopt" in default:
            property["default"] = None
            return property

        # Transform std::numeric_limits expressions.
        if "std::numeric_limits" in default:
            property["default"] = "Maximum value"
            return property

        # Transform std::chrono durations.
        if "std::chrono" in default:
            m = re.search(r"std::chrono::(\w+)\(([^)]+)\)", default)
            if m:
                unit = m.group(1)
                value = m.group(2).strip()
                property["default"] = f"{value} {unit}"
                return property

        # Transform std::vector defaults.
        if self.ARRAY_PATTERN_STD_VECTOR in default:
            m = re.search(r'\{([^}]+)\}', default)
            if m:
                contents = m.group(1).strip()
                items = [item.strip(' "\'') for item in contents.split(',')]
                property["default"] = items
                return property

        # Otherwise, leave the default as-is.
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
        return bool(info.get('type') and 'enterprise' in info['type'])

    def parse(self, property, info, file_pair):
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
            except Exception as e:
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
                meta_content = param['value'].strip("meta{ }").strip()
                meta_dict = {}
                for item in meta_content.split(','):
                    item = item.strip()
                    if '=' in item:
                        key, value = item.split('=')
                        meta_dict[key.strip().replace('.', '')] = value.strip()
                        meta_dict['type'] = 'initializer_list'  # Enforce required type
                param['value'] = meta_dict
