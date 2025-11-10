import os
from tree_sitter import Language, Parser

class FilePair:
    def __init__(self, header, implementation) -> None:
        self.header = header
        self.implementation = implementation

    def __repr__(self) -> str:
        return f"(header={self.header}, implementation={self.implementation})"


def get_files_with_properties(src_dir, cpp_language_lib_path):
    """
    Find matching C++ header/implementation pairs and extract properties from them.
    Returns a list of (FilePair, PropertyBag) tuples.
    """
    # 🔄 lazy import here to break circular dependency
    from parser import extract_properties_from_file_pair  

    cpp_language = Language(cpp_language_lib_path, "cpp")
    parser = Parser()
    parser.set_language(cpp_language)

    files_with_properties = []

    for root, _, files in os.walk(src_dir):
        for file in files:
            if not file.endswith(".h"):
                continue

            header_path = os.path.join(root, file)
            base = os.path.splitext(file)[0]

            # Look for a matching implementation file
            impl_candidates = [f"{base}.cc", f"{base}.cpp"]
            impl_path = next((os.path.join(root, c) for c in impl_candidates if c in files), None)
            if not impl_path:
                continue

            pair = FilePair(header_path, impl_path)

            try:
                props = extract_properties_from_file_pair(parser, cpp_language, pair)
                if props and len(props) > 0:
                    files_with_properties.append((pair, props))
            except Exception as e:
                print(f"[WARN] Failed to extract from {pair}: {e}")

    return files_with_properties
