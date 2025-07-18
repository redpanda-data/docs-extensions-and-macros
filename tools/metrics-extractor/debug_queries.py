#!/usr/bin/env python3
"""
Debug tree-sitter queries to understand why we're not finding metrics
"""
import os
import sys
from pathlib import Path
from tree_sitter import Language, Parser

# Add the current directory to the path so we can import our modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from metrics_parser import METRICS_QUERIES

# Sample C++ code based on the user's example
SAMPLE_CODE = '''
#include <seastar/core/metrics.hh>

namespace storage {

class something {
private:
    void setup_metrics() {
        _metrics.add_group("storage", {
            ss::metrics::make_current_bytes(
                "cached_bytes",
                [this] { return _probe.cached_bytes; },
                ss::metrics::description("Size of the database in memory")),
            
            sm::make_gauge(
                "active_connections", 
                [this] { return _connections.size(); },
                sm::description("Number of active connections")),
            
            sm::make_counter(
                "requests_total",
                [this] { return _total_requests; },
                sm::description("Total number of requests")),
                
            // More complex cases from user examples
            sm::make_counter(
                "errors_total",
                [this] { return _audit_error_count; },
                sm::description("Running count of errors in creating/publishing "
                                "audit event log entries"))
                .aggregate(aggregate_labels),
                
            {sm::make_gauge(
                "buffer_usage_ratio",
                [fn = std::move(get_usage_ratio)] { return fn(); },
                sm::description("Audit client send buffer usage ratio"))},
                
            // Test case with different syntax
            sm::make_histogram(
                "request_duration_ms",
                sm::description("Request duration in milliseconds")),
                
            ss::metrics::make_total_operations(
                "disk_operations_total",
                [this] { return _disk_ops; },
                ss::metrics::description("Total disk operations performed"))
        });
    }
    
    ss::metrics::metric_groups _metrics;
};

} // namespace storage
'''

def debug_tree_sitter():
    """Debug tree-sitter parsing"""
    print("🔍 Debugging tree-sitter parsing...")
    
    # Initialize tree-sitter
    treesitter_dir = os.path.join(os.getcwd(), "tree-sitter/tree-sitter-cpp")
    destination_path = os.path.join(treesitter_dir, "tree-sitter-cpp.so")
    
    if not os.path.exists(destination_path):
        print(f"❌ Tree-sitter library not found at {destination_path}")
        print("Run 'make treesitter' first")
        return False
    
    try:
        cpp_language = Language(destination_path, "cpp")
        parser = Parser()
        parser.set_language(cpp_language)
        
        print("✅ Tree-sitter initialized successfully")
    except Exception as e:
        print(f"❌ Failed to initialize tree-sitter: {e}")
        return False
    
    # Parse the sample code
    tree = parser.parse(SAMPLE_CODE.encode('utf-8'))
    
    print(f"\n📊 Parse tree root: {tree.root_node}")
    print(f"📊 Parse tree text: {tree.root_node.text[:100].decode('utf-8')}...")
    
    # Test each query
    for query_name, query_string in METRICS_QUERIES.items():
        print(f"\n🔍 Testing query: {query_name}")
        print(f"Query: {query_string[:100]}...")
        
        try:
            query = cpp_language.query(query_string)
            captures = query.captures(tree.root_node)
            
            print(f"📊 Found {len(captures)} captures")
            
            if captures:
                for node, label in captures[:5]:  # Show first 5 matches
                    text = node.text.decode('utf-8', errors='ignore')
                    print(f"  • {label}: {text[:50]}")
                    
                    # If this is a metric name, let's see what we got
                    if label == "metric_name":
                        print(f"    🎯 FOUND METRIC: {text}")
            else:
                print("  ⚠️ No captures found")
                
        except Exception as e:
            print(f"  ❌ Query failed: {e}")
    
    # Let's also try a simple query to see if we can find any function calls
    print(f"\n🔍 Testing simple function call query...")
    simple_query = """
    (call_expression
        function: (qualified_identifier) @function
        arguments: (argument_list) @args
    )
    """
    
    try:
        query = cpp_language.query(simple_query)
        captures = query.captures(tree.root_node)
        print(f"📊 Found {len(captures)} function calls")
        
        metrics_found = []
        
        for node, label in captures:
            if label == "function":
                function_text = node.text.decode('utf-8', errors='ignore')
                
                # Check if this is a metrics function
                if any(func in function_text for func in [
                    "make_gauge", "make_counter", "make_histogram", 
                    "make_total_bytes", "make_derive", "make_current_bytes", "make_total_operations"
                ]):
                    print(f"  • 🎯 METRICS FUNCTION: {function_text}")
                    
                    # Get the parent call expression to extract arguments
                    call_expr = node.parent
                    if call_expr and call_expr.type == "call_expression":
                        # Find the argument list
                        for child in call_expr.children:
                            if child.type == "argument_list":
                                args_text = child.text.decode('utf-8', errors='ignore')
                                print(f"    📝 Arguments: {args_text[:150]}...")
                                
                                # Extract metric name and description
                                metric_name = ""
                                description = ""
                                string_literals = []
                                
                                # Collect all string literals
                                def collect_strings(node):
                                    if node.type == "string_literal":
                                        text = node.text.decode('utf-8', errors='ignore')
                                        string_literals.append(text.strip('"'))
                                    for child in node.children:
                                        collect_strings(child)
                                
                                collect_strings(child)
                                
                                if string_literals:
                                    metric_name = string_literals[0]
                                    print(f"    🏷️  METRIC NAME: '{metric_name}'")
                                
                                # Look for description
                                if len(string_literals) > 1:
                                    for desc in string_literals[1:]:
                                        if len(desc) > 10:  # Likely a description
                                            description = desc
                                            print(f"    📄 DESCRIPTION: '{description[:80]}...'")
                                            break
                                
                                # Determine metric type
                                metric_type = "unknown"
                                if "make_gauge" in function_text or "make_current_bytes" in function_text:
                                    metric_type = "gauge"
                                elif "make_counter" in function_text or "make_total" in function_text or "make_derive" in function_text:
                                    metric_type = "counter"
                                elif "make_histogram" in function_text:
                                    metric_type = "histogram"
                                
                                print(f"    📊 TYPE: {metric_type}")
                                
                                if metric_name:
                                    metrics_found.append((function_text, metric_name, metric_type, description))
                                break
                else:
                    print(f"  • {function_text}")
        
        print(f"\n🎉 SUMMARY: Found {len(metrics_found)} metrics:")
        for func, name, mtype, desc in metrics_found:
            print(f"  • '{name}' ({mtype}) via {func}")
            if desc:
                print(f"    Description: {desc[:60]}...")
            
    except Exception as e:
        print(f"❌ Simple query failed: {e}")
    
    return True

if __name__ == "__main__":
    debug_tree_sitter()
