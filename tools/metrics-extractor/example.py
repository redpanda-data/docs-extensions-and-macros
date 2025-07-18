#!/usr/bin/env python3
"""
Example script demonstrating the metrics extractor usage
"""
import argparse
import tempfile
import os
from pathlib import Path

# Sample C++ code with metrics that would be found in Redpanda
REDPANDA_SAMPLE = '''
// File: src/v/kafka/server/handlers/produce.cc
#include <seastar/core/metrics.hh>

namespace kafka {

class produce_handler {
private:
    void setup_metrics() {
        _metrics.add_group("kafka", {
            sm::make_counter(
                "produce_requests_total",
                [this] { return _produce_requests; },
                sm::description("Total number of produce requests received")),
            
            sm::make_gauge(
                "active_connections",
                [this] { return _connections.size(); },
                sm::description("Number of currently active Kafka connections")),
            
            sm::make_histogram(
                "produce_latency_seconds",
                sm::description("Latency histogram for Kafka produce requests")),
            
            sm::make_total_bytes(
                "bytes_produced_total",
                [this] { return _bytes_produced; },
                sm::description("Total bytes produced to Kafka topics"))
        });
    }
    
    uint64_t _produce_requests = 0;
    uint64_t _bytes_produced = 0;
    std::vector<connection> _connections;
    ss::metrics::metric_groups _metrics;
};

} // namespace kafka
'''

CLUSTER_SAMPLE = '''
// File: src/v/cluster/partition_manager.cc
#include <seastar/core/metrics.hh>

namespace cluster {

class partition_manager {
private:
    void register_metrics() {
        _metrics.add_group("redpanda_cluster", {
            sm::make_gauge(
                "partitions",
                [this] { return _partitions.size(); },
                sm::description("Number of partitions in the cluster")),
            
            sm::make_counter(
                "leadership_changes",
                [this] { return _leadership_changes; },
                sm::description("Number of leadership changes across all partitions")),
            
            ss::metrics::make_current_bytes(
                "memory_usage_bytes",
                [this] { return _memory_tracker.used(); },
                ss::metrics::description("Current memory usage by partition manager"))
        });
    }
    
    std::unordered_map<model::ntp, partition> _partitions;
    uint64_t _leadership_changes = 0;
    memory_tracker _memory_tracker;
    ss::metrics::metric_groups _metrics;
};

} // namespace cluster
'''


def create_sample_files(temp_dir):
    """Create sample C++ files for testing"""
    files = []
    
    # Create kafka handler file
    kafka_file = temp_dir / "kafka_produce.cc"
    with open(kafka_file, 'w') as f:
        f.write(REDPANDA_SAMPLE)
    files.append(kafka_file)
    
    # Create cluster manager file
    cluster_file = temp_dir / "cluster_partition_manager.cc"
    with open(cluster_file, 'w') as f:
        f.write(CLUSTER_SAMPLE)
    files.append(cluster_file)
    
    return files


def run_example():
    """Run the metrics extraction example"""
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        
        print("🔧 Creating sample C++ files...")
        sample_files = create_sample_files(temp_path)
        
        print("📁 Sample files created:")
        for f in sample_files:
            print(f"  • {f.name}")
        
        try:
            from metrics_parser import get_treesitter_cpp_parser_and_language, parse_cpp_file
            from metrics_bag import MetricsBag
            
            print("\n🌳 Initializing tree-sitter C++ parser...")
            parser, language = get_treesitter_cpp_parser_and_language("tree-sitter", "tree-sitter-cpp.so")
            
            print("🔍 Extracting metrics from sample files...")
            all_metrics = MetricsBag()
            
            for cpp_file in sample_files:
                print(f"  Processing {cpp_file.name}...")
                file_metrics = parse_cpp_file(cpp_file, parser, language)
                all_metrics.merge(file_metrics)
            
            # Display results
            print(f"\n✅ Extraction completed! Found {len(all_metrics)} metrics:")
            print()
            
            for name, metric in all_metrics.get_all_metrics().items():
                print(f"📊 {name}")
                print(f"   Type: {metric['type']}")
                print(f"   Description: {metric.get('description', 'No description')}")
                if metric.get('labels'):
                    print(f"   Labels: {', '.join(metric['labels'])}")
                print(f"   Constructor: {metric['constructor']}")
                print(f"   File: {metric['files'][0]['file']}")
                print()
            
            # Show statistics
            stats = all_metrics.get_statistics()
            print("📈 Statistics:")
            print(f"   Total metrics: {stats['total_metrics']}")
            print(f"   By type: {stats['by_type']}")
            print(f"   By constructor: {stats['by_constructor']}")
            print(f"   With descriptions: {stats['with_description']}")
            print()
            
            return True
            
        except ImportError as e:
            print(f"❌ Import error: {e}")
            print("Make sure to install dependencies with: pip install -r requirements.txt")
            return False
        except Exception as e:
            print(f"❌ Error during extraction: {e}")
            return False


def main():
    parser = argparse.ArgumentParser(description="Redpanda metrics extractor example")
    parser.add_argument("--verbose", "-v", action="store_true", help="Enable verbose output")
    
    args = parser.parse_args()
    
    if args.verbose:
        import logging
        logging.basicConfig(level=logging.DEBUG)
    
    print("🚀 Redpanda Metrics Extractor Example")
    print("=====================================")
    print()
    print("This example demonstrates how the metrics extractor works")
    print("by processing sample C++ code with Redpanda metrics.")
    print()
    
    success = run_example()
    
    if success:
        print("🎉 Example completed successfully!")
        print()
        print("Next steps:")
        print("  1. Run against real Redpanda source: make build TAG=dev")
        print("  2. Compare with existing metrics: python compare_metrics.py metrics.json")
        print("  3. Generate documentation: see README.adoc for details")
    else:
        print("❌ Example failed. Please check the error messages above.")
        return 1
    
    return 0


if __name__ == "__main__":
    exit(main())
