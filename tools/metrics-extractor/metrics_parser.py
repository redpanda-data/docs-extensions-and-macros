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


def determine_metric_type_from_variable(start_node, variable_name, file_path):
    """
    Determine if a metrics variable is internal or external by searching for its declaration.
    Looks for patterns like:
    - metrics::public_metric_groups _service_metrics; (external)
    - ss::metrics::metric_groups _metrics; (internal)
    """
    
    # Go to the root of the file to search for declarations
    root_node = start_node
    while root_node.parent:
        root_node = root_node.parent
    
    def search_for_variable_declaration(node):
        if node.type == 'declaration':
            declaration_text = node.text.decode('utf-8', errors='ignore')
            if variable_name in declaration_text:
                # Check if it's a public_metric_groups declaration
                if 'public_metric_groups' in declaration_text:
                    return "external"
                elif 'metric_groups' in declaration_text and 'public' not in declaration_text:
                    return "internal"
        
        # Search children recursively
        for child in node.children:
            result = search_for_variable_declaration(child)
            if result:
                return result
        
        return None
    
    # First search the current file
    result = search_for_variable_declaration(root_node)
    if result:
        return result
    
    # If not found in current file, try to search the corresponding header file
    if file_path and str(file_path).endswith('.cc'):
        header_path = str(file_path).replace('.cc', '.h')
        try:
            header_content = get_file_contents(header_path)
            if header_content and variable_name.encode() in header_content:
                header_text = header_content.decode('utf-8', errors='ignore')
                logger.debug(f"Searching header file: {header_path}")
                if f'public_metric_groups {variable_name}' in header_text:
                    logger.debug(f"Found {variable_name} as public_metric_groups in header -> external")
                    return "external"
                elif f'metric_groups {variable_name}' in header_text and 'public' not in header_text:
                    logger.debug(f"Found {variable_name} as metric_groups in header -> internal")
                    return "internal"
        except Exception as e:
            logger.debug(f"Could not read header file {header_path}: {e}")
    
    # Default fallback based on variable name patterns
    if variable_name in ['_public_metrics', '_jobs_metrics', '_service_metrics', '_probe_metrics']:
        logger.debug(f"Using name-based fallback: {variable_name} -> external")
        return "external"
    elif variable_name in ['_internal_metrics', '_metrics']:
        logger.debug(f"Using name-based fallback: {variable_name} -> internal")
        return "internal"
    else:
        logger.debug(f"Unknown variable pattern: {variable_name}, defaulting to external")
        return "external"


def find_group_name_and_type_from_ast(metric_call_expr_node, file_path=None):
    """
    Traverse up the AST from a metric definition to find the enclosing 
    add_group call and extract its name and metric type (internal/external).
    Returns tuple: (group_name, metric_type)
    """
    current_node = metric_call_expr_node
    while current_node:
        # We are looking for a call expression, e.g., _metrics.add_group(...) or _public_metrics.add_group(...)
        if current_node.type == 'call_expression':
            function_node = current_node.child_by_field_name('function')
            if function_node and function_node.text.decode('utf-8').endswith('.add_group'):
                function_text = function_node.text.decode('utf-8')
                
                # Extract the variable name from the add_group call (e.g., "_service_metrics" from "_service_metrics.add_group")
                variable_name = function_text.replace('.add_group', '')
                logger.debug(f"Found add_group call with variable: {variable_name}")
                
                # Determine metric type by searching for the variable declaration
                metric_type = determine_metric_type_from_variable(current_node, variable_name, file_path)
                logger.debug(f"Determined metric_type: {metric_type} for variable: {variable_name}")
                
                # This is an add_group call. Now, get its arguments.
                args_node = current_node.child_by_field_name('arguments')
                if not args_node or args_node.named_child_count == 0:
                    continue

                # The first argument should be prometheus_sanitize::metrics_name(...) or a variable
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
                                group_name = unquote_string(group_name_node.text.decode('utf-8'))
                                return group_name, metric_type
                            elif group_name_node.type == 'identifier':
                                # The argument to metrics_name is a variable, resolve it
                                inner_var_name = group_name_node.text.decode('utf-8')
                                logger.debug(f"Found variable in metrics_name call: {inner_var_name}")
                                
                                # Try all our resolution strategies for this variable
                                resolved_value = resolve_variable_in_local_scope(current_node, inner_var_name)
                                if not resolved_value:
                                    resolved_value = resolve_variable_declaration(current_node, inner_var_name)
                                if not resolved_value:
                                    resolved_value = resolve_variable_forward_in_function(current_node, inner_var_name)
                                if not resolved_value:
                                    resolved_value = find_any_group_name_in_file(current_node)
                                
                                if resolved_value:
                                    logger.debug(f"Resolved metrics_name variable {inner_var_name} to: {resolved_value}")
                                    return resolved_value, metric_type
                                else:
                                    logger.error(f"Could not resolve metrics_name variable: {inner_var_name}")
                                    # EMERGENCY FALLBACK: Try to guess from common patterns
                                    if inner_var_name == "cluster_metric_prefix":
                                        logger.warning("Using emergency fallback for cluster_metric_prefix -> 'cluster'")
                                        return "cluster", metric_type
                # Handle simple string literal as group name
                elif first_arg_node.type == 'string_literal':
                    group_name = unquote_string(first_arg_node.text.decode('utf-8'))
                    return group_name, metric_type
                # Handle variable reference (like group_name)
                elif first_arg_node.type == 'identifier':
                    variable_name = first_arg_node.text.decode('utf-8')
                    logger.debug(f"Found variable reference: {variable_name} at line {first_arg_node.start_point[0] + 1}")
                    
                    # Try multiple strategies to resolve the variable
                    group_name = None
                    
                    # Strategy 1: Search in the immediate local scope first
                    group_name = resolve_variable_in_local_scope(current_node, variable_name)
                    if group_name:
                        logger.debug(f"Resolved variable {variable_name} locally to: {group_name}")
                        return group_name, metric_type
                    
                    # Strategy 2: Search in broader scopes
                    group_name = resolve_variable_declaration(current_node, variable_name)
                    if group_name:
                        logger.debug(f"Resolved variable {variable_name} in broader scope to: {group_name}")
                        return group_name, metric_type
                    
                    # Strategy 3: Search the entire function/method
                    group_name = resolve_variable_in_function_scope(current_node, variable_name)
                    if group_name:
                        logger.debug(f"Resolved variable {variable_name} in function scope to: {group_name}")
                        return group_name, metric_type
                    
                    # Strategy 4: Search forward in the function for variable declarations
                    group_name = resolve_variable_forward_in_function(current_node, variable_name)
                    if group_name:
                        logger.debug(f"Found variable {variable_name} declared later in function: {group_name}")
                        return group_name, metric_type
                    
                    # Strategy 5: Last resort - search entire file for any group_name variable
                    if variable_name == "group_name":
                        group_name = find_any_group_name_in_file(current_node)
                        if group_name:
                            logger.debug(f"Found fallback group_name in file: {group_name}")
                            return group_name, metric_type
                    
                    logger.error(f"CRITICAL: Could not resolve variable '{variable_name}' - this should not happen!")
                    
                    # EMERGENCY FALLBACK: Hard-coded common patterns
                    if variable_name == "group_name":
                        # Return a placeholder that can be manually reviewed
                        logger.warning(f"Using emergency fallback for group_name - returning 'unknown'")
                        return "unknown", metric_type
                    
                    # Add debugging to see what scopes we searched
                    logger.debug(f"Current node type: {current_node.type}, parent: {current_node.parent.type if current_node.parent else 'None'}")

        current_node = current_node.parent
    return None, "external"  # Default to external if not found


def resolve_variable_declaration(start_node, variable_name):
    """
    Search for a variable declaration within the current scope and enclosing scopes.
    Looks for patterns like: const auto group_name = prometheus_sanitize::metrics_name("...");
    """
    logger.debug(f"Searching for variable '{variable_name}' starting from node type: {start_node.type}")
    
    # Search from current scope up to the translation unit
    scope_node = start_node
    
    # Keep searching in broader scopes until we find the variable or reach the top
    while scope_node:
        logger.debug(f"Searching in scope: {scope_node.type}")
        
        # Search for variable declarations in the current scope
        def search_declarations(node, depth=0):
            indent = "  " * depth
            logger.debug(f"{indent}Checking node type: {node.type}")
            
            if node.type == 'declaration':
                logger.debug(f"{indent}Found declaration: {node.text.decode('utf-8')[:100]}...")
                # Look for variable declarators
                for child in node.children:
                    if child.type == 'init_declarator':
                        declarator = child.child_by_field_name('declarator')
                        initializer = child.child_by_field_name('value')
                        
                        if declarator and initializer:
                            # Check if this is our variable
                            declarator_text = declarator.text.decode('utf-8')
                            logger.debug(f"{indent}  Declarator: {declarator_text}")
                            if variable_name in declarator_text:
                                logger.debug(f"{indent}  Found matching variable!")
                                # Check if the initializer is a call to prometheus_sanitize::metrics_name
                                if initializer.type == 'call_expression':
                                    func_node = initializer.child_by_field_name('function')
                                    if func_node and '::metrics_name' in func_node.text.decode('utf-8'):
                                        args_node = initializer.child_by_field_name('arguments')
                                        if args_node and args_node.named_child_count > 0:
                                            first_arg = args_node.named_children[0]
                                            if first_arg.type == 'string_literal':
                                                result = unquote_string(first_arg.text.decode('utf-8'))
                                                logger.debug(f"{indent}  Resolved to: {result}")
                                                return result
            
            # Recursively search all child nodes
            for child in node.children:
                result = search_declarations(child, depth + 1)
                if result:
                    return result
            
            return None
        
        # Search in the current scope
        result = search_declarations(scope_node)
        if result:
            return result
        
        # Move to parent scope
        if scope_node.type == 'translation_unit':
            # We've reached the top level, stop here
            logger.debug("Reached translation unit, stopping search")
            break
        scope_node = scope_node.parent
        if scope_node:
            logger.debug(f"Moving to parent scope: {scope_node.type}")
    
    logger.debug(f"Variable '{variable_name}' not found in any scope")
    return None


def resolve_variable_in_local_scope(start_node, variable_name):
    """
    Search for a variable declaration in the immediate local scope around the add_group call.
    This handles cases where the variable is declared just before the add_group call.
    """
    logger.debug(f"Searching for variable '{variable_name}' in local scope")
    
    # First, try to find the enclosing function/method
    func_node = start_node
    while func_node and func_node.type not in ['function_definition', 'method_definition']:
        func_node = func_node.parent
    
    if not func_node:
        logger.debug("No function/method definition found")
        return None
    
    # Get the function body (compound_statement)
    body_node = None
    for child in func_node.children:
        if child.type == 'compound_statement':
            body_node = child
            break
    
    if not body_node:
        logger.debug("No function body found")
        return None
    
    # Search all declarations in the function body
    def search_in_node(node):
        if node.type == 'declaration':
            # Check for auto group_name = prometheus_sanitize::metrics_name(...);
            for child in node.children:
                if child.type == 'init_declarator':
                    declarator = child.child_by_field_name('declarator')
                    initializer = child.child_by_field_name('value')
                    
                    if declarator and initializer:
                        # Handle 'auto' type declarations
                        if declarator.type == 'identifier' and declarator.text.decode('utf-8') == variable_name:
                            # Found our variable!
                            if initializer.type == 'call_expression':
                                func_node = initializer.child_by_field_name('function')
                                if func_node and '::metrics_name' in func_node.text.decode('utf-8'):
                                    args_node = initializer.child_by_field_name('arguments')
                                    if args_node and args_node.named_child_count > 0:
                                        first_arg = args_node.named_children[0]
                                        if first_arg.type == 'string_literal':
                                            return unquote_string(first_arg.text.decode('utf-8'))
        
        # Recursively search children
        for child in node.children:
            result = search_in_node(child)
            if result:
                return result
        
        return None
    
    return search_in_node(body_node)


def resolve_variable_in_function_scope(start_node, variable_name):
    """
    Search for a variable declaration within the entire function scope.
    This is the most aggressive search strategy.
    """
    logger.debug(f"Searching for variable '{variable_name}' in function scope")
    
    # Go up to the function definition
    func_node = start_node
    while func_node and func_node.type not in ['function_definition', 'lambda_expression', 'method_definition']:
        func_node = func_node.parent
    
    if not func_node:
        logger.debug("No function definition found for function scope search")
        return None
    
    logger.debug(f"Found function node: {func_node.type}")
    
    # Search the entire function body recursively
    def search_in_function(node, depth=0):
        indent = "  " * depth
        logger.debug(f"{indent}Searching node type: {node.type}")
        
        # Print the text for declarations to help debug
        if node.type in ['declaration', 'expression_statement']:
            text = node.text.decode('utf-8')[:100]
            logger.debug(f"{indent}Found {node.type}: {text}...")
        
        if node.type == 'declaration':
            result = extract_variable_from_declaration(node, variable_name)
            if result:
                logger.debug(f"{indent}Found variable in declaration: {result}")
                return result
        elif node.type == 'expression_statement':
            # Some variable declarations might be parsed as expression statements
            for child in node.children:
                if child.type == 'assignment_expression':
                    left = child.child_by_field_name('left')
                    right = child.child_by_field_name('right')
                    if left and right and left.text.decode('utf-8') == variable_name:
                        if right.type == 'call_expression':
                            func_call = right.child_by_field_name('function')
                            if func_call and '::metrics_name' in func_call.text.decode('utf-8'):
                                args_node = right.child_by_field_name('arguments')
                                if args_node and args_node.named_child_count > 0:
                                    first_arg = args_node.named_children[0]
                                    if first_arg.type == 'string_literal':
                                        result = unquote_string(first_arg.text.decode('utf-8'))
                                        logger.debug(f"{indent}Found variable in assignment: {result}")
                                        return result
        
        # Search all children
        for child in node.children:
            result = search_in_function(child, depth + 1)
            if result:
                return result
        
        return None
    
    return search_in_function(func_node)


def resolve_variable_forward_in_function(start_node, variable_name):
    """
    Search forward from the current position for variable declarations.
    This handles cases where variables are declared after they're referenced in metric definitions
    but before the add_group call.
    """
    logger.debug(f"Searching forward for variable '{variable_name}'")
    
    # Go up to the function definition
    func_node = start_node
    while func_node and func_node.type not in ['function_definition', 'lambda_expression', 'method_definition']:
        func_node = func_node.parent
    
    if not func_node:
        logger.debug("No function definition found for forward search")
        return None
    
    # Find the function body
    body_node = None
    for child in func_node.children:
        if child.type == 'compound_statement':
            body_node = child
            break
    
    if not body_node:
        logger.debug("No function body found for forward search")
        return None
    
    # Search through all statements in the function body
    for statement in body_node.children:
        if statement.type == 'declaration':
            result = extract_variable_from_declaration(statement, variable_name)
            if result:
                logger.debug(f"Found forward declaration: {result}")
                return result
        elif statement.type == 'expression_statement':
            # Check for assignment expressions
            for child in statement.children:
                if child.type == 'assignment_expression':
                    left = child.child_by_field_name('left')
                    right = child.child_by_field_name('right')
                    if left and right and left.text.decode('utf-8') == variable_name:
                        if right.type == 'call_expression':
                            func_call = right.child_by_field_name('function')
                            if func_call and '::metrics_name' in func_call.text.decode('utf-8'):
                                args_node = right.child_by_field_name('arguments')
                                if args_node and args_node.named_child_count > 0:
                                    first_arg = args_node.named_children[0]
                                    if first_arg.type == 'string_literal':
                                        result = unquote_string(first_arg.text.decode('utf-8'))
                                        logger.debug(f"Found forward assignment: {result}")
                                        return result
    
    return None


def extract_variable_from_declaration(declaration_node, variable_name):
    """
    Extract the value of a variable from a declaration node if it matches the variable name.
    Handles patterns like:
    - const auto group_name = prometheus_sanitize::metrics_name("...");
    - constexpr static auto cluster_metric_prefix = "cluster";
    """
    for child in declaration_node.children:
        if child.type == 'init_declarator':
            declarator = child.child_by_field_name('declarator')
            initializer = child.child_by_field_name('value')
            
            if declarator and initializer:
                declarator_text = declarator.text.decode('utf-8')
                if variable_name in declarator_text:
                    # Check if the initializer is a call to prometheus_sanitize::metrics_name
                    if initializer.type == 'call_expression':
                        func_node = initializer.child_by_field_name('function')
                        if func_node and '::metrics_name' in func_node.text.decode('utf-8'):
                            args_node = initializer.child_by_field_name('arguments')
                            if args_node and args_node.named_child_count > 0:
                                first_arg = args_node.named_children[0]
                                if first_arg.type == 'string_literal':
                                    return unquote_string(first_arg.text.decode('utf-8'))
                    # Also check for simple string literal assignment (like constexpr static auto cluster_metric_prefix = "cluster")
                    elif initializer.type == 'string_literal':
                        return unquote_string(initializer.text.decode('utf-8'))
    return None


def find_any_group_name_in_file(start_node):
    """
    Last resort: search the entire file for any variable that's assigned 
    a prometheus_sanitize::metrics_name value, regardless of variable name.
    """
    logger.debug("Searching entire file for any metrics_name assignment")
    
    # Go to the root of the file
    root_node = start_node
    while root_node.parent:
        root_node = root_node.parent
    
    # Search the entire file for any prometheus_sanitize::metrics_name call
    def search_entire_file(node):
        if node.type == 'declaration':
            # Look for any variable declared with prometheus_sanitize::metrics_name
            for child in node.children:
                if child.type == 'init_declarator':
                    declarator = child.child_by_field_name('declarator')
                    initializer = child.child_by_field_name('value')
                    
                    if declarator and initializer:
                        # Check if the initializer is a call to prometheus_sanitize::metrics_name
                        if initializer.type == 'call_expression':
                            func_node = initializer.child_by_field_name('function')
                            if func_node and '::metrics_name' in func_node.text.decode('utf-8'):
                                args_node = initializer.child_by_field_name('arguments')
                                if args_node and args_node.named_child_count > 0:
                                    first_arg = args_node.named_children[0]
                                    if first_arg.type == 'string_literal':
                                        result = unquote_string(first_arg.text.decode('utf-8'))
                                        declarator_text = declarator.text.decode('utf-8')
                                        logger.debug(f"Found metrics_name assignment in file: {declarator_text} = {result}")
                                        return result
        
        # Also check for assignment expressions
        if node.type == 'assignment_expression':
            left = node.child_by_field_name('left')
            right = node.child_by_field_name('right')
            if left and right:
                if right.type == 'call_expression':
                    func_node = right.child_by_field_name('function')
                    if func_node and '::metrics_name' in func_node.text.decode('utf-8'):
                        args_node = right.child_by_field_name('arguments')
                        if args_node and args_node.named_child_count > 0:
                            first_arg = args_node.named_children[0]
                            if first_arg.type == 'string_literal':
                                result = unquote_string(first_arg.text.decode('utf-8'))
                                left_text = left.text.decode('utf-8')
                                logger.debug(f"Found metrics_name assignment in file: {left_text} = {result}")
                                return result
        
        # Search all children recursively
        for child in node.children:
            result = search_entire_file(child)
            if result:
                return result
        
        return None
    
    return search_entire_file(root_node)


def find_any_metrics_name_in_file(start_node, file_path):
    """
    Enhanced search: find ANY variable in the file that's assigned a prometheus_sanitize::metrics_name value.
    This handles cases where the variable name is not 'group_name' (e.g., 'cluster_metrics_name').
    """
    logger.debug(f"Enhanced file-wide search for metrics_name declarations in {file_path}")
    
    # Go to the root of the file
    root_node = start_node
    while root_node.parent:
        root_node = root_node.parent
    
    def search_any_metrics_name(node):
        if node.type == 'declaration':
            # Look for any variable declared with prometheus_sanitize::metrics_name
            for child in node.children:
                if child.type == 'init_declarator':
                    declarator = child.child_by_field_name('declarator')
                    initializer = child.child_by_field_name('value')
                    
                    if declarator and initializer:
                        if initializer.type == 'call_expression':
                            func_node = initializer.child_by_field_name('function')
                            if func_node and '::metrics_name' in func_node.text.decode('utf-8'):
                                args_node = initializer.child_by_field_name('arguments')
                                if args_node and args_node.named_child_count > 0:
                                    first_arg = args_node.named_children[0]
                                    if first_arg.type == 'string_literal':
                                        result = unquote_string(first_arg.text.decode('utf-8'))
                                        var_name = declarator.text.decode('utf-8')
                                        logger.debug(f"Found metrics_name declaration: {var_name} = '{result}'")
                                        return result
        
        # Also check for assignment expressions (not just declarations)
        if node.type == 'assignment_expression':
            left = node.child_by_field_name('left')
            right = node.child_by_field_name('right')
            if left and right:
                if right.type == 'call_expression':
                    func_node = right.child_by_field_name('function')
                    if func_node and '::metrics_name' in func_node.text.decode('utf-8'):
                        args_node = right.child_by_field_name('arguments')
                        if args_node and args_node.named_child_count > 0:
                            first_arg = args_node.named_children[0]
                            if first_arg.type == 'string_literal':
                                result = unquote_string(first_arg.text.decode('utf-8'))
                                var_name = left.text.decode('utf-8')
                                logger.debug(f"Found metrics_name assignment: {var_name} = '{result}'")
                                return result
        
        # Search all children recursively
        for child in node.children:
            result = search_any_metrics_name(child)
            if result:
                return result
        
        return None
    
    return search_any_metrics_name(root_node)


def infer_group_name_from_path(file_path):
    """
    Programmatic inference of group names from file paths with common patterns.
    """
    path_str = str(file_path).lower()
    file_parts = path_str.split('/')
    
    # Define path-based inference rules
    inference_rules = [
        # Pattern: (path_contains, additional_condition, group_name)
        (['kafka', 'quota'], lambda p: 'quota' in p, "kafka:quotas"),
        (['datalake', 'translation'], lambda p: 'translation' in p, "iceberg:translation"),
        (['iceberg', 'rest_client'], lambda p: 'rest_client' in p, "iceberg:rest_client"),
        (['cluster', 'partition'], lambda p: 'partition' in p, "cluster:partition"),
        (['debug_bundle'], lambda p: True, "debug_bundle"),
        (['kafka'], lambda p: True, "kafka"),
        (['cluster'], lambda p: True, "cluster"),
        (['iceberg'], lambda p: True, "iceberg"),
        (['storage'], lambda p: 'cloud' in p, "cloud_storage"),
    ]
    
    # Apply inference rules
    for path_keywords, condition, group_name in inference_rules:
        if all(keyword in file_parts for keyword in path_keywords) and condition(path_str):
            return group_name
    
    # Default fallback
    return "unknown"


def find_group_name_from_ast(metric_call_expr_node):
    """
    Traverse up the AST from a metric definition to find the enclosing 
    add_group call and extract its name. This is more reliable than regex.
    """
    group_name, _ = find_group_name_and_type_from_ast(metric_call_expr_node, None)
    return group_name


def construct_full_metric_name(group_name, metric_name, metric_type="external"):
    """Construct the full Prometheus metric name from group and metric name"""
    # Add debug logging
    if not group_name or group_name == "unknown":
        # Fallback based on metric type
        if metric_type == "internal":
            result = f"vectorized_{metric_name}"
        else:
            result = f"redpanda_{metric_name}"
        return result
    
    # Sanitize the group name: replace special characters with underscores.
    sanitized_group = group_name.replace(':', '_').replace('-', '_')
    
    # Ensure the correct prefix is present based on metric type
    if metric_type == "internal":
        # Internal metrics should have vectorized_ prefix
        if not sanitized_group.startswith('vectorized_'):
            full_group_name = f"vectorized_{sanitized_group}"
        else:
            full_group_name = sanitized_group
    else:
        # External metrics should have redpanda_ prefix
        if not sanitized_group.startswith('redpanda_'):
            full_group_name = f"redpanda_{sanitized_group}"
        else:
            full_group_name = sanitized_group
    
    # The full metric name is: <full_group_name>_<metric_name>
    result = f"{full_group_name}_{metric_name}"
    return result


def parse_seastar_replicated_metrics(tree_root, source_code, file_path):
    """Parse seastar replicated metrics from seastar::metrics::replicate_metric_families calls"""
    metrics_bag = MetricsBag()
    
    # Look ONLY for seastar::metrics::replicate_metric_families calls
    def find_replicate_calls(node):
        if node.type == 'call_expression':
            function_node = node.child_by_field_name('function')
            if function_node:
                function_text = function_node.text.decode('utf-8')
                # Be very specific - must be exactly replicate_metric_families
                if 'replicate_metric_families' in function_text and 'seastar::metrics::' in function_text:
                    logger.debug(f"Found seastar replicate_metric_families call in {file_path}")
                    args_node = node.child_by_field_name('arguments')
                    if args_node:
                        # Look for the array of metric names
                        for child in args_node.children:
                            if child.type == 'initializer_list':
                                # This is the array of {"metric_name", handle} pairs
                                for item in child.children:
                                    if item.type == 'initializer_list':
                                        # Each item is {"metric_name", handle}
                                        metric_items = [c for c in item.children if c.type == 'string_literal']
                                        if metric_items:
                                            metric_name = unquote_string(metric_items[0].text.decode('utf-8'))
                                            if metric_name:
                                                logger.debug(f"Found replicated seastar metric: {metric_name}")
                                                # Seastar metrics are typically in the "application" group
                                                full_metric_name = f"redpanda_{metric_name}"
                                                
                                                metrics_bag.add_metric(
                                                    name=metric_name,
                                                    metric_type="gauge",  # Most seastar metrics are gauges
                                                    description=f"Seastar replicated metric: {metric_name}",
                                                    labels=[],
                                                    file=str(file_path),
                                                    constructor="seastar_replicated",
                                                    group_name="application",
                                                    full_name=full_metric_name,
                                                    internal_external_type="public",
                                                    line_number=node.start_point[0] + 1
                                                )
        
        # Search children recursively
        for child in node.children:
            find_replicate_calls(child)
    
    find_replicate_calls(tree_root)
    return metrics_bag


def parse_direct_seastar_metrics(tree_root, source_code, file_path):
    """Parse direct ss::metrics calls like sm::make_gauge ONLY in specific contexts"""
    metrics_bag = MetricsBag()
    
    # Look for ss::metrics or sm:: calls but ONLY in the application.cc context
    # This is a very specific pattern that should not interfere with regular metrics
    if 'application.cc' not in str(file_path):
        return metrics_bag  # Only process application.cc for direct seastar metrics
    
    def find_direct_seastar_calls(node):
        if node.type == 'call_expression':
            function_node = node.child_by_field_name('function')
            if function_node:
                function_text = function_node.text.decode('utf-8')
                
                # Be very specific - must be sm:: prefix AND in the right context
                seastar_type = None
                if function_text == 'sm::make_gauge':
                    seastar_type = 'gauge'
                elif function_text == 'sm::make_counter':
                    seastar_type = 'counter'
                elif function_text == 'sm::make_histogram':
                    seastar_type = 'histogram'
                
                # Also check for direct ss::metrics calls
                if not seastar_type:
                    if function_text == 'ss::metrics::make_gauge':
                        seastar_type = 'gauge'
                    elif function_text == 'ss::metrics::make_counter':
                        seastar_type = 'counter'
                    elif function_text == 'ss::metrics::make_histogram':
                        seastar_type = 'histogram'
                
                if seastar_type:
                    # Additional check: must be in a specific function context
                    # Look for setup_public_metrics or similar function
                    current = node.parent
                    in_correct_function = False
                    while current:
                        if current.type == 'function_definition':
                            # Check if this is the setup_public_metrics function
                            for child in current.children:
                                if child.type == 'function_declarator':
                                    func_name = child.text.decode('utf-8')
                                    if 'setup_public_metrics' in func_name:
                                        in_correct_function = True
                                        break
                            break
                        current = current.parent
                    
                    if not in_correct_function:
                        return  # Skip if not in the right function
                    
                    args_node = node.child_by_field_name('arguments')
                    if args_node and args_node.named_child_count > 0:
                        # First argument is typically the metric name
                        first_arg = args_node.named_children[0]
                        if first_arg.type == 'string_literal':
                            metric_name = unquote_string(first_arg.text.decode('utf-8'))
                            
                            # Try to find description from subsequent arguments
                            description = f"Seastar direct metric: {metric_name}"
                            for i in range(1, args_node.named_child_count):
                                arg = args_node.named_children[i]
                                if arg.type == 'call_expression':
                                    # Look for sm::description() calls
                                    desc_func = arg.child_by_field_name('function')
                                    if desc_func and 'description' in desc_func.text.decode('utf-8'):
                                        desc_args = arg.child_by_field_name('arguments')
                                        if desc_args and desc_args.named_child_count > 0:
                                            desc_arg = desc_args.named_children[0]
                                            if desc_arg.type == 'string_literal':
                                                description = unquote_string(desc_arg.text.decode('utf-8'))
                                                break
                            
                            logger.debug(f"Found direct seastar metric: {metric_name}")
                            full_metric_name = f"redpanda_{metric_name}"
                            
                            metrics_bag.add_metric(
                                name=metric_name,
                                metric_type=seastar_type,
                                description=description,
                                labels=[],
                                file=str(file_path),
                                constructor=f"seastar_{seastar_type}",
                                group_name="application",
                                full_name=full_metric_name,
                                internal_external_type="public",
                                line_number=node.start_point[0] + 1
                            )
        
        # Search children recursively
        for child in node.children:
            find_direct_seastar_calls(child)
    
    find_direct_seastar_calls(tree_root)
    return metrics_bag


def parse_cpp_file(file_path, treesitter_parser, cpp_language, filter_namespace=None):
    """Parse a single C++ file for metrics definitions"""
    # Only show debug info in verbose mode
    
    source_code = get_file_contents(file_path)
    if not source_code:
        return MetricsBag()

    try:
        tree = treesitter_parser.parse(source_code)
    except Exception as e:
        logger.warning(f"Failed to parse {file_path}: {e}")
        return MetricsBag()

    metrics_bag = MetricsBag()
    
    # TODO: Add seastar metrics parsing later - currently disabled to avoid contamination
    # First, parse seastar metrics
    # seastar_replicated = parse_seastar_replicated_metrics(tree.root_node, source_code, file_path)
    # metrics_bag.merge(seastar_replicated)
    
    # seastar_direct = parse_direct_seastar_metrics(tree.root_node, source_code, file_path)
    # metrics_bag.merge(seastar_direct)
    
    # Then parse regular prometheus metrics
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
                        
                        # Use robust AST traversal to find the group name and metric type
                        group_name, internal_external_type = find_group_name_and_type_from_ast(call_expr, file_path)

                        full_metric_name = construct_full_metric_name(group_name, metric_name, internal_external_type)
                        
                        # Get code context for labels
                        start_byte = call_expr.start_byte
                        end_byte = call_expr.end_byte
                        context_start = max(0, start_byte - 500)
                        context_end = min(len(source_code), end_byte + 500)
                        code_context = source_code[context_start:context_end].decode("utf-8", errors="ignore")
                        
                        labels = extract_labels_from_code(code_context)
                        
                        # CRITICAL SAFEGUARD: Never allow null group names
                        if group_name is None:
                            logger.error(f"CRITICAL: group_name is None for metric '{metric_name}' in {file_path}")
                            logger.error(f"File context: {metric_name} at line {call_expr.start_point[0] + 1}")
                            
                            # Enhanced emergency fallback: try to find any metrics_name declaration in the file
                            group_name = find_any_metrics_name_in_file(call_expr, file_path)
                            
                            if not group_name:
                                # Last resort: programmatic file path inference
                                group_name = infer_group_name_from_path(file_path)
                                logger.warning(f"Emergency fallback: inferred group_name='{group_name}' from file path")
                            else:
                                logger.warning(f"Emergency fallback: found group_name='{group_name}' via file-wide search")
                        
                            # CRITICAL: Recalculate full_metric_name with the corrected group_name
                            full_metric_name = construct_full_metric_name(group_name, metric_name, internal_external_type)
                            logger.debug(f"Recalculated full_metric_name after emergency fallback: {full_metric_name}")
                        
                        metrics_bag.add_metric(
                            name=metric_name,
                            metric_type=metric_type,
                            description=description,
                            labels=labels,
                            file=str(file_path.relative_to(Path.cwd()) if file_path.is_absolute() else file_path),
                            constructor=constructor,
                            line_number=call_expr.start_point[0] + 1,
                            group_name=group_name,
                            full_name=full_metric_name,
                            internal_external_type=internal_external_type  # Add the new field
                        )
                        
    except Exception as e:
        logger.warning(f"Query failed on {file_path}: {e}")
    
    return metrics_bag


def extract_metric_details(args_node, source_code):
    """Extract metric name and description from argument list"""
    metric_name = ""
    description = ""
    
    # Find all string literals and their positions
    string_literals = []
    
    def collect_string_info(node):
        """Recursively find all string literals with their positions"""
        if node.type == "string_literal":
            text = node.text.decode("utf-8", errors="ignore")
            unquoted = unquote_string(text)
            start_pos = node.start_point
            end_pos = node.end_point
            string_literals.append({
                'text': unquoted,
                'start': start_pos,
                'end': end_pos,
                'raw': text
            })
        for child in node.children:
            collect_string_info(child)
    
    collect_string_info(args_node)
    
    # Sort string literals by their position in the source
    string_literals.sort(key=lambda x: (x['start'][0], x['start'][1]))
    
    # First string literal is the metric name
    if string_literals:
        metric_name = string_literals[0]['text']
    
    # Look for description by finding sm::description() calls or consecutive string literals
    args_text = args_node.text.decode("utf-8", errors="ignore")
    
    if "description" in args_text:
        # Improved AST-based approach to find all strings in description
        description_strings = []
        found_description = False
        
        for i, str_info in enumerate(string_literals):
            # Skip the first string which is the metric name
            if i == 0:
                continue
            
            # Get the full args context and find position of this string
            str_pos = args_text.find(str_info['raw'])
            if str_pos != -1:
                context_before = args_text[:str_pos]
                
                # Check if this string comes after "description" in the context
                if "description" in context_before and not found_description:
                    found_description = True
                    description_strings.append(str_info['text'])
                    
                    # Look ahead to collect all consecutive string literals
                    # that are part of the same description (C++ auto-concatenation)
                    for j in range(i + 1, len(string_literals)):
                        next_str = string_literals[j]
                        next_pos = args_text.find(next_str['raw'])
                        
                        if next_pos != -1:
                            # Check if there's only whitespace/comments between strings
                            between_text = args_text[str_pos + len(str_info['raw']):next_pos]
                            
                            # Clean up the between text - remove comments and normalize whitespace
                            between_clean = re.sub(r'//.*?$', '', between_text, flags=re.MULTILINE)
                            between_clean = re.sub(r'/\*.*?\*/', '', between_clean, flags=re.DOTALL)
                            between_clean = between_clean.strip()
                            
                            # If only whitespace/punctuation between strings, they're concatenated
                            if not between_clean or all(c in ' \t\n\r,)' for c in between_clean):
                                description_strings.append(next_str['text'])
                                str_info = next_str  # Update position for next iteration
                                str_pos = next_pos
                            else:
                                # Found something else, stop collecting
                                break
                        else:
                            break
                    break
        
        # Join all collected description strings
        if description_strings:
            description = ''.join(description_strings)
        elif len(string_literals) > 1:
            # Final fallback: just use the second string literal
            description = string_literals[1]['text']

    # Filter out descriptions with unresolved format placeholders
    if description and '{}' in description:
        description = ""

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
