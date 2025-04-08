import re
from property_bag import PropertyBag
from parser import normalize_string


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
    def __init__(self, type_transformer):
        self.type_transformer = type_transformer

    def accepts(self, info, file_pair):
        return "std::vector" in info["declaration"]

    def parse(self, property, info, file_pair):
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
    def accepts(self, info, file_pair):
        return True

    def get_cpp_type_from_declaration(self, declaration):
        one_line_declaration = declaration.replace("\n", "").strip()
        raw_type = (
            re.sub(r"^.*property<(.+)>.*", "\\1", one_line_declaration)
            .split()[0]
            .replace(",", "")
        )

        if "std::optional" in raw_type:
            raw_type = re.sub(".*std::optional<(.+)>.*", "\\1", raw_type)

        if "std::vector" in raw_type:
            raw_type = re.sub(".*std::vector<(.+)>.*", "\\1", raw_type)

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
        elif re.search("^-?[0-9][0-9']*$", default):  # integers
            property["default"] = int(default.replace("[^0-9-]", ""))
        elif re.search(r"^-?[0-9]+(\.[0-9]+)$", default):  # floats
            property["default"] = float(default.replace("[^0-9]", ""))
        elif re.search("^(true|false)$", default):  # booleans
            property["default"] = True if default == "true" else False
        elif re.search("^{[^:]+$", default):  # string lists
            property["default"] = [
                normalize_string(s)
                for s in re.sub("{([^}]+)}", "\\1", default).split(",")
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
        if "std::vector" in default:
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
        if info.get("type") is not None:
            return info["type"].startswith(("development_", "hidden_when_default_"))
    def parse(self, property, info, file_pair):
        property["is_experimental_property"] = True


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
    def accepts(self, property, file_pair):
        if property['type'] is not None and 'enterprise' in property['type']:
            return True
        return False
    
    def parse(self, property, info, file_pair):
        if info['params'] is not None:
            enterpriseValue = info['params'][0]['value']
            property['enterprise_value'] = enterpriseValue
            property['is_enterprise'] = True
            del info['params'][0]


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
            return

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
