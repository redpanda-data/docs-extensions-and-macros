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


def find_group_end_line(group_start_line, lines):
    """Find where an add_group block ends by tracking brace nesting"""
    # First, we need to find the opening brace of the metrics list
    brace_count = 0
    paren_count = 0
    in_group = False
    found_opening_brace = False
    
    for i in range(group_start_line, min(len(lines), group_start_line + 200)):
        line = lines[i]
        
        for j, char in enumerate(line):
            if char == '(':
                paren_count += 1
            elif char == ')':
                paren_count -= 1
                if found_opening_brace and brace_count == 0 and paren_count == 0:
                    # We've closed all braces and parentheses
                    return i
            elif char == '{':
                if not found_opening_brace and paren_count > 0:
                    # This is the opening brace of the metrics list
                    found_opening_brace = True
                    brace_count = 1
                elif found_opening_brace:
                    brace_count += 1
            elif char == '}':
                if found_opening_brace and brace_count > 0:
                    brace_count -= 1
                    if brace_count == 0:
                        # We've closed the metrics list
                        # Now look for the closing parenthesis and semicolon
                        # Could be on this line or the next
                        remaining = line[j+1:].strip()
                        if ')' in remaining:
                            return i
                        elif i + 1 < len(lines):
                            next_line = lines[i + 1].strip()
                            if next_line.startswith(')'):
                                return i + 1
    
    return None


def extract_metrics_group_name(call_expr, source_code):
    """Extract the metrics group name from add_group or metric_group calls.
    
    This function checks if the metric is actually within the bounds of an add_group
    block by matching opening and closing braces.
    """
    current_line = call_expr.start_point[0]
    current_column = call_expr.start_point[1]
    source_text = source_code.decode('utf-8', errors='ignore')
    lines = source_text.split('\n')
    
    # Search backwards up to 300 lines for group declarations
    search_start = max(0, current_line - 300)
    
    # Find all potential group declarations with their positions and end lines
    all_groups = []
    
    for i in range(search_start, current_line + 1):
        line = lines[i]
        
        # Look for prometheus_sanitize::metrics_name patterns first (most accurate)
        prometheus_match = re.search(
            r'(?:_metrics|_public_metrics)\.add_group\s*\(\s*prometheus_sanitize::metrics_name\s*\(\s*["\']([^"\']+)["\']', 
            line
        )
        if prometheus_match:
            end_line = find_group_end_line(i, lines)
            if end_line is not None:
                all_groups.append({
                    'start': i,
                    'end': end_line,
                    'name': prometheus_match.group(1),
                    'type': "prometheus_add_group"
                })
                logger.debug(f"Found group '{prometheus_match.group(1)}' from line {i} to {end_line}")
            continue
            
        # Look for metric_group patterns
        metric_group_match = re.search(
            r'metric_group\s*\(\s*prometheus_sanitize::metrics_name\s*\(\s*["\']([^"\']+)["\']', 
            line
        )
        if metric_group_match:
            end_line = find_group_end_line(i, lines)
            if end_line is not None:
                all_groups.append({
                    'start': i,
                    'end': end_line,
                    'name': metric_group_match.group(1),
                    'type': "prometheus_metric_group"
                })
            continue
            
        # Fallback to simpler patterns
        simple_add_match = re.search(r'\.add_group\s*\(\s*["\']([^"\']+)["\']', line)
        if simple_add_match:
            end_line = find_group_end_line(i, lines)
            if end_line is not None:
                all_groups.append({
                    'start': i,
                    'end': end_line,
                    'name': simple_add_match.group(1),
                    'type': "simple_add_group"
                })
            continue
            
        simple_metric_match = re.search(r'metric_group\s*\(\s*["\']([^"\']+)["\']', line)
        if simple_metric_match:
            end_line = find_group_end_line(i, lines)
            if end_line is not None:
                all_groups.append({
                    'start': i,
                    'end': end_line,
                    'name': simple_metric_match.group(1),
                    'type': "simple_metric_group"
                })
    
    # Now find which group contains our metric
    # We need to find the innermost group that contains the metric
    containing_groups = []
    for group in all_groups:
        if group['start'] <= current_line <= group['end']:
            containing_groups.append(group)
    
    if containing_groups:
        # Sort by start line (descending) to get the innermost group
        containing_groups.sort(key=lambda g: g['start'], reverse=True)
        best_group = containing_groups[0]
        logger.debug(f"Metric at line {current_line} is in group '{best_group['name']}' (lines {best_group['start']}-{best_group['end']})")
        return best_group['name']
    
    logger.debug(f"No group name found for metric at line {current_line}")
    return None


def is_metric_within_group_bounds(group_line, metric_line, metric_column, lines):
    """Check if a metric is within the bounds of an add_group call by matching braces.
    
    This function is now deprecated in favor of find_group_end_line, but kept for reference.
    """
    group_end_line = find_group_end_line(group_line, lines)
    if group_end_line is not None:
        return group_line <= metric_line <= group_end_line
    return False


def find_metrics_group_context(call_expr, source_code, tree_root):
    """Find the metrics group by analyzing the containing function context"""
    current_line = call_expr.start_point[0]
    
    # Find the containing function or method
    current_node = call_expr
    while current_node:
        if current_node.type in ['function_definition', 'method_definition', 'constructor_definition']:
            # Found the containing function, search within it
            function_text = source_code[current_node.start_byte:current_node.end_byte].decode('utf-8', errors='ignore')
            
            # Look for add_group calls within this function
            add_group_match = re.search(
                r'(?:_metrics|_public_metrics)\.add_group\s*\(\s*prometheus_sanitize::metrics_name\s*\(\s*["\']([^"\']+)["\']', 
                function_text, 
                re.MULTILINE | re.DOTALL
            )
            if add_group_match:
                return add_group_match.group(1)
            
            # Also check for the pattern where add_group might be on multiple lines
            multiline_match = re.search(
                r'\.add_group\s*\(\s*\n?\s*prometheus_sanitize::metrics_name\s*\(\s*["\']([^"\']+)["\']',
                function_text,
                re.MULTILINE | re.DOTALL
            )
            if multiline_match:
                return multiline_match.group(1)
            
        current_node = current_node.parent
    
    return None


def construct_full_metric_name(group_name, metric_name):
    """Construct the full Prometheus metric name from group and metric name"""
    if not group_name or group_name == "unknown":
        return f"redpanda_{metric_name}"
    
    # Convert group name to Prometheus format
    # Replace colons with underscores and ensure redpanda prefix
    sanitized_group = group_name.replace(':', '_').replace('-', '_')
    
    # The group name might already have 'redpanda_' prefix or not
    if not sanitized_group.startswith('redpanda_'):
        sanitized_group = f"redpanda_{sanitized_group}"
    
    # The full metric name is: <sanitized_group>_<metric_name>
    return f"{sanitized_group}_{metric_name}"


def parse_cpp_file(file_path, treesitter_parser, cpp_language, filter_namespace=None):
    """Parse a single C++ file for metrics definitions"""
    logger.debug(f"Parsing file: {file_path}")
    
    source_code = get_file_contents(file_path)
    if not source_code:
        return MetricsBag()
    
    try:
        tree = treesitter_parser.parse(source_code)
    except Exception as e:
        logger.warning(f"Failed to parse {file_path}: {e}")
        return MetricsBag()
    
    metrics_bag = MetricsBag()
    
    # Simple query to find all call expressions
    simple_query = """
    (call_expression
        function: (qualified_identifier) @function
        arguments: (argument_list) @args)
    """
    
    try:
        query = cpp_language.query(simple_query)
        captures = query.captures(tree.root_node)
        
        for node, label in captures:
            if label == "function":
                function_text = node.text.decode("utf-8", errors="ignore")
                
                # Check if this is a metrics function we're interested in
                metric_type = None
                constructor = None
                
                if function_text in ["sm::make_gauge", "seastar::metrics::make_gauge"]:
                    metric_type = "gauge"
                    constructor = "make_gauge"
                elif function_text in ["sm::make_counter", "seastar::metrics::make_counter"]:
                    metric_type = "counter"
                    constructor = "make_counter"
                elif function_text in ["sm::make_histogram", "seastar::metrics::make_histogram"]:
                    metric_type = "histogram"
                    constructor = "make_histogram"
                elif function_text in ["sm::make_total_bytes", "seastar::metrics::make_total_bytes"]:
                    metric_type = "counter"
                    constructor = "make_total_bytes"
                elif function_text in ["sm::make_derive", "seastar::metrics::make_derive"]:
                    metric_type = "counter"
                    constructor = "make_derive"
                elif function_text in ["ss::metrics::make_total_operations", "seastar::metrics::make_total_operations"]:
                    metric_type = "counter"
                    constructor = "make_total_operations"
                elif function_text in ["ss::metrics::make_current_bytes", "seastar::metrics::make_current_bytes"]:
                    metric_type = "gauge"
                    constructor = "make_current_bytes"
                
                if metric_type:
                    # Found a metrics function, now extract the arguments
                    call_expr = node.parent
                    if call_expr and call_expr.type == "call_expression":
                        args_node = None
                        for child in call_expr.children:
                            if child.type == "argument_list":
                                args_node = child
                                break
                        
                        if args_node:
                            metric_name, description = extract_metric_details(args_node, source_code)
                            
                            if metric_name:
                                # Apply namespace filter if specified
                                if filter_namespace and not metric_name.startswith(filter_namespace):
                                    continue
                                
                                # In parse_cpp_file, update this section:
                                # Try to find the metrics group name by looking for add_group calls
                                group_name = extract_metrics_group_name(call_expr, source_code)
                                if not group_name:
                                    # Try alternative method
                                    group_name = find_metrics_group_context(call_expr, source_code, tree.root_node)

                                if group_name:
                                    logger.debug(f"Found group_name: {group_name} for metric: {metric_name}")
                                else:
                                    logger.warning(f"Could not find group_name for metric '{metric_name}' at line {call_expr.start_point[0] + 1}")

                                full_metric_name = construct_full_metric_name(group_name, metric_name)
                                
                                # Debug output
                                logger.debug(f"Processing metric '{metric_name}': group_name='{group_name}', full_name='{full_metric_name}'")
                                
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
                                
                                logger.debug(f"Found metric: {metric_name} ({metric_type}) -> {full_metric_name}")
    
    except Exception as e:
        logger.warning(f"Query failed on {file_path}: {e}")
    
    return metrics_bag


def extract_metric_details(args_node, source_code):
    """Extract metric name and description from argument list"""
    metric_name = ""
    description = ""
    
    # Look for string literals in the arguments
    string_literals = []
    
    def collect_strings(node):
        if node.type == "string_literal":
            text = node.text.decode("utf-8", errors="ignore")
            string_literals.append(unquote_string(text))
        for child in node.children:
            collect_strings(child)
    
    collect_strings(args_node)
    
    # First string literal is usually the metric name
    if string_literals:
        metric_name = string_literals[0]
    
    # Look for description in subsequent strings
    for i, string_val in enumerate(string_literals[1:], 1):
        if "description" in args_node.text.decode("utf-8", errors="ignore").lower():
            description = string_val
            break
    
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