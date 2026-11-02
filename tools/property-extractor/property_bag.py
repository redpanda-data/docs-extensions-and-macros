class PropertyBag(dict):
    """
    A recursive, auto-expanding dictionary used throughout the configuration parser.

    This class behaves like a normal Python `dict`, but when you access a missing key,
    it automatically creates and inserts another `PropertyBag` at that key instead of
    raising a `KeyError`.

    This makes it convenient for building up deeply nested structures incrementally
    without having to check whether intermediate keys already exist.

    Example
    -------
    >>> props = PropertyBag()
    >>> props["core_balancing_continuous"]["params"].append("true")
    >>> props
    {'core_balancing_continuous': {'params': ['true']}}

    How it works
    ------------
    - The __missing__ method is called automatically by dict.__getitem__()
      when a requested key is not present.
    - Instead of raising KeyError, we insert and return a new PropertyBag(),
      enabling seamless nested assignment.

    Typical usage in the parser
    ----------------------------
    PropertyBag is used to accumulate data while parsing:
      - Configuration property declarations from the header file.
      - Constructor argument lists from the C++ source file.
      - Metadata fields from nested initializer lists.

    Because the parser doesn’t know in advance which keys will appear,
    this auto-expanding structure keeps the code simple and robust:

        parameters[field]["params"].append(param)
        header_properties[name]["type"] = cpp_type

    Both of these lines work safely even if `field` or `name` did not previously exist.
    """

    def __missing__(self, key):
        self[key] = PropertyBag()
        return self[key]
