#!/usr/bin/env python3
"""
Test sample C++ code to validate metrics extraction
"""

# Sample C++ code with various metric constructors
SAMPLE_CPP_CODE = '''
#include <seastar/core/metrics.hh>

namespace redpanda {

class kafka_server {
public:
    kafka_server() {
        setup_metrics();
    }

private:
    void setup_metrics() {
        _metrics.add_group("kafka", {
            sm::make_gauge(
                "requests_total",
                [this] { return _total_requests; },
                sm::description("Total number of Kafka requests processed")),
            
            sm::make_counter(
                "bytes_received_total",
                [this] { return _bytes_received; },
                sm::description("Total bytes received from Kafka clients")),
            
            sm::make_histogram(
                "request_latency_seconds",
                sm::description("Latency histogram of Kafka requests")),
            
            sm::make_total_bytes(
                "memory_usage_bytes",
                [this] { return _memory_used; },
                sm::description("Current memory usage in bytes")),
            
            ss::metrics::make_total_operations(
                "operations_total",
                [this] { return _operations; },
                ss::metrics::description("Total operations performed")),
            
            ss::metrics::make_current_bytes(
                "cache_size_bytes",
                [this] { return _cache_size; },
                ss::metrics::description("Current cache size in bytes"))
        });
    }

    uint64_t _total_requests = 0;
    uint64_t _bytes_received = 0;
    uint64_t _memory_used = 0;
    uint64_t _operations = 0;
    uint64_t _cache_size = 0;
    ss::metrics::metric_groups _metrics;
};

} // namespace redpanda
'''

def test_sample_extraction():
    """Test that the sample code extracts expected metrics"""
    import tempfile
    import os
    from pathlib import Path
    
    # Write sample code to temporary file
    with tempfile.NamedTemporaryFile(mode='w', suffix='.cc', delete=False) as f:
        f.write(SAMPLE_CPP_CODE)
        temp_file = f.name
    
    try:
        # Import and test the parser
        from metrics_parser import parse_cpp_file, get_treesitter_cpp_parser_and_language
        
        # Initialize tree-sitter (this will download and compile if needed)
        parser, language = get_treesitter_cpp_parser_and_language("tree-sitter", "tree-sitter-cpp.so")
        
        # Parse the file
        metrics_bag = parse_cpp_file(Path(temp_file), parser, language, filter_namespace="redpanda")
        
        # Check results
        all_metrics = metrics_bag.get_all_metrics()
        print(f"Found {len(all_metrics)} metrics:")
        
        expected_metrics = [
            ("requests_total", "gauge"),
            ("bytes_received_total", "counter"),
            ("request_latency_seconds", "histogram"),
            ("memory_usage_bytes", "counter"),
            ("operations_total", "counter"),
            ("cache_size_bytes", "gauge")
        ]
        
        for metric_name, expected_type in expected_metrics:
            if metric_name in all_metrics:
                metric = all_metrics[metric_name]
                print(f"  ✓ {metric_name} ({metric['type']}) - {metric.get('description', 'No description')}")
                assert metric['type'] == expected_type, f"Expected {expected_type}, got {metric['type']}"
            else:
                print(f"  ✗ {metric_name} - NOT FOUND")
        
        print(f"\nStatistics: {metrics_bag.get_statistics()}")
        
    finally:
        # Clean up
        os.unlink(temp_file)


if __name__ == "__main__":
    test_sample_extraction()
