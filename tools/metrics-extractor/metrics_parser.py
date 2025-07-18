import os
import re
import subprocess
import logging
from pathlib import Path
from metrics_bag import MetricsBag

logger = logging.getLogger("metrics_parser")

# Tree-sitter queries for different metric constructors
METRICS_QUERIES = {
    'sm_make_gauge': """
    (call_expression
        function: (qualified_identifier
            scope: (namespace_identifier) @namespace
            name: (identifier) @function_name)
        arguments: (argument_list
            (string_literal) @metric_name
            . *
            (call_expression
                function: (qualified_identifier
                    scope: (namespace_identifier)
                    name: (identifier))
                arguments: (argument_list
                    (string_literal) @description))?))
    """,
    
    'ss_metrics_make_current_bytes': """
    (call_expression
        function: (qualified_identifier
            scope: (qualified_identifier
                scope: (namespace_identifier) @outer_namespace
                name: (namespace_identifier) @inner_namespace)
            name: (identifier) @function_name)
        arguments: (argument_list
            (string_literal) @metric_name
            . *
            (call_expression
                function: (qualified_identifier
                    scope: (qualified_identifier
                        scope: (namespace_identifier)
                        name: (namespace_identifier))
                    name: (identifier))
                arguments: (argument_list
                    (string_literal) @description))?))
    """
}

# Map function names to metric types
FUNCTION_TO_TYPE = {
    'make_gauge': 'gauge',
    'make_counter': 'counter', 
    'make_histogram': 'histogram',
    'make_total_bytes': 'counter',
    'make_derive': 'counter',
    'make_total_operations': 'counter',
    'make_current_bytes': 'gauge'
}


def build_treesitter_cpp_library(treesitter_dir, destination_path):
    """Build tree-sitter C++ library - expects parser to be already generated"""
    from tree_sitter import Language
    Language.build_library(destination_path, [treesitter_dir])


def get_file_contents(path):
    """Read file contents as bytes"""
    try:
        with open(path, "rb") as f:
            return f.read()
    except Exception as e:
        logger.warning(f"Could not read file {path}: {e}")
        return b""


def unquote_string(value):
    """Remove quotes from string literals and handle escape sequences"""
    if not value:
        return ""
    
    # Remove outer quotes and handle raw strings
    value = value.strip()
    if value.startswith('R"') and value.endswith('"'):
        # Raw string literal: R"delimiter(content)delimiter"
        match = re.match(r'R"([^(]*)\((.*)\)\1"', value, re.DOTALL)
        if match:
            return match.group(2)
    elif value.startswith('"') and value.endswith('"'):
        # Regular string literal
        value = value[1:-1]
        # Handle basic escape sequences
        value = value.replace('\\"', '"')
        value = value.replace('\\\\', '\\')
        value = value.replace('\\n', '\n')
        value = value.replace('\\t', '\t')
    
    return value


def extract_labels_from_code(code_context):
    """Extract potential label names from code context around metrics"""
    labels = set()
    
    # Look for common label patterns
    label_patterns = [
        r'\.aggregate\s*\(\s*([^)]+)\s*\)',  # .aggregate(aggregate_labels)
        r'auto\s+(\w*labels\w*)\s*=',        # auto aggregate_labels =
        r'std::vector<[^>]*>\s*{([^}]+)}',   # std::vector<sm::label>{sm::shard_label}
        r'sm::([a-z_]*label[a-z_]*)',        # sm::shard_label, sm::topic_label, etc.
        r'"([^"]+)"\s*:\s*[^,}]+',            # key-value pairs
    ]
    
    for pattern in label_patterns:
        matches = re.findall(pattern, code_context)
        for match in matches:
            if isinstance(match, str):
                # Clean up label names
                cleaned = match.strip().replace('sm::', '').replace('_label', '')
                if cleaned and not cleaned.isspace():
                    labels.add(cleaned)
            elif isinstance(match, tuple):
                for submatch in match:
                    cleaned = submatch.strip().replace('sm::', '').replace('_label', '')
                    if cleaned and not cleaned.isspace():
                        labels.add(cleaned)
    
    return sorted(list(labels))


def find_group_name_from_ast(metric_call_expr_node):
    """
    Traverse up the AST from a metric definition to find the enclosing 
    add_group call and extract its name. This is more reliable than regex.
    """
    current_node = metric_call_expr_node
    while current_node:
        # We are looking for a call expression, e.g., _metrics.add_group(...)
        if current_node.type == 'call_expression':
            function_node = current_node.child_by_field_name('function')
            if function_node and function_node.text.decode('utf-8').endswith('.add_group'):
                # This is an add_group call. Now, get its arguments.
                args_node = current_node.child_by_field_name('arguments')
                if not args_node or args_node.named_child_count == 0:
                    continue

                # The first argument should be prometheus_sanitize::metrics_name(...)
                first_arg_node = args_node.named_children[0]
                
                # Check if this argument is a call to prometheus_sanitize::metrics_name
                if first_arg_node.type == 'call_expression':
                    inner_function = first_arg_node.child_by_field_name('function')
                    inner_args = first_arg_node.child_by_field_name('arguments')
                    
                    if inner_function and '::metrics_name' in inner_function.text.decode('utf-8'):
                        # Found it. Extract the string literal from its arguments.
                        if inner_args and inner_args.named_child_count > 0:
                            group_name_node = inner_args.named_children[0]
                            if group_name_node.type == 'string_literal':
                                return unquote_string(group_name_node.text.decode('utf-8'))
                # Handle simple string literal as group name
                elif first_arg_node.type == 'string_literal':
                    return unquote_string(first_arg_node.text.decode('utf-8'))

        current_node = current_node.parent
    return None


def construct_full_metric_name(group_name, metric_name):
    """Construct the full Prometheus metric name from group and metric name"""
    if not group_name or group_name == "unknown":
        # Fallback if group name is not found
        return f"redpanda_{metric_name}"
    
    # Sanitize the group name: replace special characters with underscores.
    sanitized_group = group_name.replace(':', '_').replace('-', '_')
    
    # Ensure the 'redpanda' prefix is present. The group name from prometheus_sanitize
    # might or might not have it.
    if not sanitized_group.startswith('redpanda_'):
        full_group_name = f"redpanda_{sanitized_group}"
    else:
        full_group_name = sanitized_group
    
    # The full metric name is: <full_group_name>_<metric_name>
    return f"{full_group_name}_{metric_name}"


def parse_cpp_file(file_path, treesitter_parser, cpp_language, filter_namespace=None):
    """Parse a single C++ file for metrics definitions"""
    # Only show debug info in verbose mode
    # logger.debug(f"Parsing file: {file_path}")
    
    source_code = get_file_contents(file_path)
    if not source_code:
        return MetricsBag()
    
    try:
        tree = treesitter_parser.parse(source_code)
    except Exception as e:
        logger.warning(f"Failed to parse {file_path}: {e}")
        return MetricsBag()
    
    metrics_bag = MetricsBag()
    
    # A general query to find all function calls
    simple_query = cpp_language.query("(call_expression) @call")
    
    try:
        captures = simple_query.captures(tree.root_node)
        
        for node, _ in captures:
            call_expr = node
            function_identifier_node = call_expr.child_by_field_name("function")
            if not function_identifier_node:
                continue

            function_text = function_identifier_node.text.decode("utf-8", errors="ignore")
            
            metric_type = None
            constructor = None
            
            # Check if this is a metrics function we're interested in
            for func, m_type in FUNCTION_TO_TYPE.items():
                if func in function_text:
                    metric_type = m_type
                    constructor = func
                    break

            if metric_type:
                # Found a metrics function, now extract its details
                args_node = call_expr.child_by_field_name("arguments")
                if args_node:
                    metric_name, description = extract_metric_details(args_node, source_code)
                    
                    if metric_name:
                        # Apply namespace filter if specified
                        if filter_namespace and not metric_name.startswith(filter_namespace):
                            continue
                        
                        # Use robust AST traversal to find the group name
                        group_name = find_group_name_from_ast(call_expr)

                        # Only show warnings for missing groups in verbose mode
                        # if group_name:
                        #     logger.debug(f"Found group_name: {group_name} for metric: {metric_name}")
                        # else:
                        #     logger.warning(f"Could not find group_name for metric '{metric_name}' at line {call_expr.start_point[0] + 1}")

                        full_metric_name = construct_full_metric_name(group_name, metric_name)
                        
                        # Commented out to reduce debug noise
                        # logger.debug(f"Processing metric '{metric_name}': group_name='{group_name}', full_name='{full_metric_name}'")
                        
                        # Get code context for labels
                        start_byte = call_expr.start_byte
                        end_byte = call_expr.end_byte
                        context_start = max(0, start_byte - 500)
                        context_end = min(len(source_code), end_byte + 500)
                        code_context = source_code[context_start:context_end].decode("utf-8", errors="ignore")
                        
                        labels = extract_labels_from_code(code_context)
                        
                        metrics_bag.add_metric(
                            name=metric_name,
                            metric_type=metric_type,
                            description=description,
                            labels=labels,
                            file=str(file_path.relative_to(Path.cwd()) if file_path.is_absolute() else file_path),
                            constructor=constructor,
                            line_number=call_expr.start_point[0] + 1,
                            group_name=group_name,
                            full_name=full_metric_name
                        )
                        
                        # Commented out to reduce noise
                        # logger.debug(f"Found metric: {metric_name} ({metric_type}) -> {full_metric_name}")
    
    except Exception as e:
        logger.warning(f"Query failed on {file_path}: {e}")
    
    return metrics_bag


def extract_metric_details(args_node, source_code):
    """Extract metric name and description from argument list"""
    metric_name = ""
    description = ""
    
    string_literals = []
    
    def collect_strings(node):
        # Recursively find all string literals within the arguments
        if node.type == "string_literal":
            text = node.text.decode("utf-8", errors="ignore")
            string_literals.append(unquote_string(text))
        for child in node.children:
            collect_strings(child)
    
    collect_strings(args_node)
    
    # First string literal is the metric name
    if string_literals:
        metric_name = string_literals[0]
    
    # The second string literal is usually the description.
    # This is a simplification; a more complex heuristic could be needed if
    # the description isn't the second string.
    if len(string_literals) > 1:
        # A simple check to see if the argument list contains "description"
        # to be more certain.
        args_text = args_node.text.decode("utf-8", errors="ignore")
        if "description" in args_text:
             description = string_literals[1]

    return metric_name, description


def extract_metrics_from_files(cpp_files, treesitter_parser, cpp_language, filter_namespace=None):
    """Extract metrics from multiple C++ files"""
    all_metrics = MetricsBag()
    
    for file_path in cpp_files:
        try:
            file_metrics = parse_cpp_file(file_path, treesitter_parser, cpp_language, filter_namespace)
            all_metrics.merge(file_metrics)
        except Exception as e:
            logger.warning(f"Failed to process {file_path}: {e}")
            continue
    
    return all_metrics
