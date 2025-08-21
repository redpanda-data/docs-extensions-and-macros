#!/usr/bin/env python3
import logging
import sys
import os
import json
import re
import argparse
import warnings
from pathlib import Path
from tree_sitter import Language, Parser
from metrics_parser import build_treesitter_cpp_library, extract_metrics_from_files
from metrics_bag import MetricsBag

# Suppress tree-sitter deprecation warnings
warnings.filterwarnings("ignore", category=FutureWarning, module="tree_sitter")

logger = logging.getLogger("metrics_extractor")


def validate_paths(options):
    path = options.redpanda_repo

    if not os.path.exists(path):
        logger.error(f'Path does not exist: "{path}".')
        sys.exit(1)


def get_cpp_files(options):
    """Get all C++ source files from the path"""
    path = Path(options.redpanda_repo)
    
    # If the path is a file, return it directly
    if path.is_file() and path.suffix in ['.cc', '.cpp', '.cxx', '.h', '.hpp']:
        return [path.resolve()]
    
    # Otherwise, treat it as a directory
    file_patterns = ["*.cc", "*.cpp", "*.cxx"]
    cpp_files = []
    
    for pattern in file_patterns:
        if options.recursive:
            cpp_files.extend(path.rglob(pattern))
        else:
            cpp_files.extend(path.glob(pattern))
    
    return [f.resolve() for f in cpp_files]


def get_treesitter_cpp_parser_and_language(treesitter_dir, destination_path):
    """Initialize tree-sitter C++ parser and language"""
    if not os.path.exists(destination_path):
        build_treesitter_cpp_library(treesitter_dir, destination_path)

    cpp_language = Language(destination_path, "cpp")
    treesitter_parser = Parser()
    treesitter_parser.set_language(cpp_language)

    return treesitter_parser, cpp_language


def parse_args():
    parser = argparse.ArgumentParser(
        description="Extract Redpanda metrics from C++ source code using tree-sitter"
    )
    parser.add_argument(
        "--redpanda-repo",
        "-r",
        required=True,
        help="Path to the Redpanda source code directory"
    )
    parser.add_argument(
        "--recursive", 
        action="store_true", 
        default=True,
        help="Search for C++ files recursively (default: True)"
    )
    parser.add_argument(
        "--json-output", 
        default="metrics.json", 
        help="Output JSON file (default: metrics.json)"
    )
    parser.add_argument(
        "--internal-asciidoc", 
        help="Generate AsciiDoc output file for internal metrics"
    )
    parser.add_argument(
        "--external-asciidoc", 
        help="Generate AsciiDoc output file for external metrics"
    )
    parser.add_argument(
        "--asciidoc", 
        "-a", 
        help="Generate AsciiDoc output file (deprecated: use --internal-asciidoc and --external-asciidoc)"
    )
    parser.add_argument(
        "--verbose", 
        "-v", 
        action="store_true", 
        help="Enable verbose logging"
    )
    parser.add_argument(
        "--filter-namespace", 
        help="Filter metrics by namespace (e.g., redpanda)"
    )
    
    return parser.parse_args()


def clean_description(description):
    """Ensure description ends with appropriate punctuation"""
    if not description:
        return description
    
    description = description.strip()
    if description and not description.endswith(('.', '!', '?')):
        description += '.'
    
    return description


def clean_labels(labels):
    """Clean up labels by removing whitespace and deduplicating"""
    if not labels:
        return []
    
    cleaned_labels = set()
    simple_labels = set()  # Track simple labels to avoid adding redundant braced versions
    
    for label in labels:
        # Remove extra whitespace and newlines
        clean_label = ' '.join(label.split())
        
        # Skip empty labels
        if not clean_label:
            continue
            
        # Handle cases like "{shard}" vs "shard" - prefer the simpler form
        if clean_label.startswith('{') and clean_label.endswith('}'):
            # Extract the content inside braces
            inner_content = clean_label[1:-1].strip()
            # If it's a simple label (no comma), prefer the unbrace version
            if ',' not in inner_content and inner_content:
                simple_label = inner_content.strip()
                simple_labels.add(simple_label)
                cleaned_labels.add(simple_label)  # Add the simple version
            else:
                # Complex label with commas, keep the braced version
                cleaned_labels.add(clean_label)
        else:
            # Simple label
            simple_labels.add(clean_label)
            cleaned_labels.add(clean_label)
    
    # Convert back to sorted list
    return sorted(list(cleaned_labels))


def generate_asciidoc_by_type(metrics_bag, internal_output_file, external_output_file):
    """Generate separate AsciiDoc documentation for internal and external metrics"""
    all_metrics = metrics_bag.get_all_metrics()
    
    # Separate metrics by type
    internal_metrics = {}
    external_metrics = {}
    
    for metric_key, metric_info in all_metrics.items():
        metric_type = metric_info.get('metric_type', 'external')  # Default to external if not specified
        if metric_type == 'internal':
            internal_metrics[metric_key] = metric_info
        else:
            external_metrics[metric_key] = metric_info
    
    # Group metrics by category/prefix for better organization
    def group_metrics_by_category(metrics_dict):
        """Group metrics by their prefix (first part before underscore)"""
        groups = {}
        for metric_key, metric_info in metrics_dict.items():
            # Extract category from full_name or fallback to metric_key
            full_name = metric_info.get('full_name', metric_key)
            
            # Remove redpanda_ or vectorized_ prefix first
            clean_name = full_name
            if clean_name.startswith('redpanda_'):
                clean_name = clean_name[9:]  # Remove 'redpanda_'
            elif clean_name.startswith('vectorized_'):
                clean_name = clean_name[11:]  # Remove 'vectorized_'
            
            # Get the category (first part before underscore)
            parts = clean_name.split('_')
            category = parts[0] if parts else 'other'
            
            # Create more meaningful category names
            category_mapping = {
                'cluster': 'Cluster metrics',
                'kafka': 'Kafka metrics', 
                'raft': 'Raft metrics',
                'storage': 'Storage metrics',
                'memory': 'Infrastructure metrics',
                'io': 'Infrastructure metrics',
                'rpc': 'RPC metrics',
                'cloud': 'Cloud storage metrics',
                'application': 'Application metrics',
                'reactor': 'Infrastructure metrics',
                'scheduler': 'Infrastructure metrics',
                'network': 'Infrastructure metrics',
                'internal': 'RPC metrics',
                'pandaproxy': 'REST proxy metrics',
                'rest': 'REST proxy metrics',
                'schema': 'Schema registry metrics',
                'transform': 'Data transforms metrics',
                'wasm': 'Data transforms metrics',
                'security': 'Security metrics',
                'authorization': 'Security metrics',
                'tls': 'Security metrics',
                'debug': 'Debug bundle metrics',
                'alien': 'Infrastructure metrics',
                'archival': 'Cloud storage metrics',
                'ntp': 'Partition metrics',
                'space': 'Storage metrics',
                'chunk': 'Storage metrics',
                'tx': 'Transaction metrics',
                'leader': 'Raft metrics',
                'node': 'Raft metrics',
                'stall': 'Infrastructure metrics',
                'httpd': 'Infrastructure metrics',
                'host': 'Infrastructure metrics',
                'uptime': 'Infrastructure metrics',
                'cpu': 'Infrastructure metrics',
                'iceberg': 'Iceberg metrics'
            }
            
            # Use the mapping, but fallback to a few broad categories instead of creating many
            category_name = category_mapping.get(category)
            if not category_name:
                # Group unmapped categories into broader buckets
                if category in ['active', 'adjacent', 'anomalies', 'available', 'backlog', 'batch', 'batches', 'brokers', 'buffer', 'bytes', 'cached', 'certificate', 'chunked', 'cleanly', 'client', 'closed', 'committed', 'compacted', 'compaction', 'complete', 'connection', 'connections', 'connects', 'consumed', 'corrupted']:
                    category_name = 'Application metrics'
                elif category in ['data', 'datalake', 'decompressed', 'dirty', 'disk', 'dispatch', 'dlq', 'end', 'error', 'errors', 'events', 'failed', 'failures', 'fetch', 'files', 'high', 'housekeeping']:
                    category_name = 'Application metrics'
                elif category in ['in', 'inflight', 'invalid', 'lag', 'last', 'latest', 'loaded', 'local', 'log', 'logs', 'max', 'method', 'non', 'num', 'offsets', 'out', 'parquet', 'partition', 'partitions']:
                    category_name = 'Application metrics'
                elif category in ['queued', 'raw', 'read', 'received', 'reclaim', 'records', 'request', 'requests', 'result', 'retention', 'segments', 'sent', 'server', 'service', 'shares', 'start', 'state', 'successful', 'target', 'throttle', 'tombstones', 'topics', 'total', 'traffic', 'translations', 'trust', 'truststore', 'unavailable', 'under', 'urgent', 'write', 'written']:
                    category_name = 'Application metrics'
                else:
                    category_name = 'Other metrics'
            
            if category_name not in groups:
                groups[category_name] = {}
            groups[category_name][metric_key] = metric_info
        
        return groups
    
    # Generate internal metrics documentation
    if internal_output_file:
        with open(internal_output_file, 'w') as f:
            f.write("= Internal Metrics\n")
            f.write(":description: Redpanda internal metrics for detailed analysis, debugging, and troubleshooting.\n")
            f.write(":page-aliases: reference:internal-metrics.adoc\n")
            f.write("\n")
            f.write("This section provides reference descriptions about the internal metrics exported from Redpanda's `/metrics` endpoint.\n")
            f.write("\n")
            f.write("include::shared:partial$metrics-usage-tip.adoc[]\n")
            f.write("\n")
            f.write("[IMPORTANT]\n")
            f.write("====\n")
            f.write("In a live system, Redpanda metrics are exported only for features that are in use. For example, a metric for consumer groups is not exported when no groups are registered.\n")
            f.write("\n")
            f.write("To see the available internal metrics in your system, query the `/metrics` endpoint:\n")
            f.write("\n")
            f.write("[,bash]\n")
            f.write("----\n")
            f.write("curl http://<node-addr>:9644/metrics | grep \"[HELP|TYPE]\"\n")
            f.write("----\n")
            f.write("====\n")
            f.write("\n")
            f.write("Internal metrics (`/metrics`) can generate thousands of metric series in production environments. Use them judiciously in monitoring systems to avoid performance issues. For alerting and dashboards, prefer public metrics (`/public_metrics`) which are optimized for lower cardinality.\n")
            f.write("\n")
            f.write("The xref:reference:properties/cluster-properties.adoc#aggregate_metrics[aggregate_metrics] cluster property controls internal metrics cardinality. When you enable this property, internal metrics combine labels (like shard) to reduce the number of series. Public metrics always combine labels, regardless of this setting.\n")
            f.write("\n")
            
            # Group and sort internal metrics
            internal_groups = group_metrics_by_category(internal_metrics)
            
            for group_name in sorted(internal_groups.keys()):
                f.write(f"== {group_name}\n\n")
                
                # Sort metrics within each group
                sorted_group_metrics = sorted(internal_groups[group_name].items())
                
                for metric_key, metric_info in sorted_group_metrics:
                    # Use full_name as section header, fallback to metric_key if full_name is not available
                    section_name = metric_info.get('full_name', metric_key)
                    f.write(f"=== {section_name}\n\n")
                    
                    description = clean_description(metric_info.get('description'))
                    if description:
                        f.write(f"{description}\n\n")
                    else:
                        f.write("No description available.\n\n")
                    
                    f.write(f"*Type*: {metric_info.get('type', 'unknown')}\n\n")
                    
                    cleaned_labels = clean_labels(metric_info.get('labels', []))
                    if cleaned_labels:
                        f.write("*Labels*:\n\n")
                        for label in cleaned_labels:
                            f.write(f"- `{label}`\n")
                        f.write("\n")
                    
                    f.write("---\n\n")
    
    # Generate external metrics documentation
    if external_output_file:
        with open(external_output_file, 'w') as f:
            f.write("= Public Metrics\n")
            f.write(":description: Public metrics to create your system dashboard.\n")
            f.write("// tag::single-source[]\n")
            f.write("\n")
            f.write("This section provides reference descriptions for the public metrics exported from Redpanda's `/public_metrics` endpoint.\n")
            f.write("\n")
            f.write("// Cloud does not expose the internal metrics.\n")
            f.write("ifndef::env-cloud[]\n")
            f.write("include::shared:partial$metrics-usage-tip.adoc[]\n")
            f.write("endif::[]\n")
            f.write("\n")
            f.write("[IMPORTANT]\n")
            f.write("====\n")
            f.write("In a live system, Redpanda metrics are exported only for features that are in use. For example, Redpanda does not export metrics for consumer groups if no groups are registered.\n")
            f.write("\n")
            f.write("To see the available public metrics in your system, query the `/public_metrics` endpoint:\n")
            f.write("\n")
            f.write("[,bash]\n")
            f.write("----\n")
            f.write("curl http://<node-addr>:9644/public_metrics | grep \"[HELP|TYPE]\"\n")
            f.write("----\n")
            f.write("\n")
            f.write("====\n")
            f.write("\n")
            
            # Group and sort external metrics
            external_groups = group_metrics_by_category(external_metrics)
            
            for group_name in sorted(external_groups.keys()):
                f.write(f"== {group_name}\n\n")
                
                # Sort metrics within each group
                sorted_group_metrics = sorted(external_groups[group_name].items())
                
                for metric_key, metric_info in sorted_group_metrics:
                    # Use full_name as section header, fallback to metric_key if full_name is not available
                    section_name = metric_info.get('full_name', metric_key)
                    f.write(f"=== {section_name}\n\n")
                    
                    description = clean_description(metric_info.get('description'))
                    if description:
                        f.write(f"{description}\n\n")
                    else:
                        f.write("No description available.\n\n")
                    
                    f.write(f"*Type*: {metric_info.get('type', 'unknown')}\n\n")
                    
                    cleaned_labels = clean_labels(metric_info.get('labels', []))
                    if cleaned_labels:
                        f.write("*Labels*:\n\n")
                        for label in cleaned_labels:
                            f.write(f"- `{label}`\n")
                        f.write("\n")
                    
                    f.write("---\n\n")
            
            f.write("// end::single-source[]\n")


def main():
    args = parse_args()
    
    # Set logging level - only show warnings and errors unless verbose is requested
    if args.verbose:
        logging.basicConfig(level=logging.DEBUG, format='%(levelname)s: %(message)s')
    else:
        logging.basicConfig(level=logging.WARNING, format='%(levelname)s: %(message)s')
    
    validate_paths(args)
    
    if args.verbose:
        logger.info("Initializing tree-sitter C++ parser...")
    
    # Use the same pattern as property-extractor
    treesitter_dir = os.path.join(os.getcwd(), "tree-sitter/tree-sitter-cpp")
    destination_path = os.path.join(treesitter_dir, "tree-sitter-cpp.so")

    if not os.path.exists(os.path.join(treesitter_dir, "src/parser.c")):
        logger.error("Missing parser.c. Ensure Tree-sitter submodules are initialized.")
        logger.error("Run 'make treesitter' first to generate the parser.")
        sys.exit(1)
    
    treesitter_parser, cpp_language = get_treesitter_cpp_parser_and_language(
        treesitter_dir, destination_path
    )
    
    if args.verbose:
        logger.info("Finding C++ source files...")
    cpp_files = get_cpp_files(args)
    if args.verbose:
        logger.info(f"Found {len(cpp_files)} C++ files")
    
    if args.verbose:
        logger.info("Extracting metrics from source files...")
    metrics_bag = extract_metrics_from_files(
        cpp_files, treesitter_parser, cpp_language, args.filter_namespace
    )
    
    # Show clean summary with internal/external breakdown
    all_metrics = metrics_bag.get_all_metrics()
    total_metrics = len(all_metrics)
    
    # Count internal vs external metrics
    internal_count = sum(1 for metric in all_metrics.values() if metric.get('metric_type') == 'internal')
    external_count = sum(1 for metric in all_metrics.values() if metric.get('metric_type') == 'external')
    
    print(f"✅ Successfully extracted {total_metrics} metrics from {len(cpp_files)} C++ files.")
    print(f"Internal metrics: {internal_count}")
    print(f"External metrics: {external_count}")
    
    with open(args.json_output, 'w') as f:
        json.dump(metrics_bag.to_dict(), f, indent=2)
    
    # Output AsciiDoc if requested
    if args.internal_asciidoc or args.external_asciidoc:
        generate_asciidoc_by_type(metrics_bag, args.internal_asciidoc, args.external_asciidoc)
    
    # Handle legacy --asciidoc argument (generate both files)
    if args.asciidoc:
        if args.verbose:
            logger.info(f"Writing legacy AsciiDoc output to {args.asciidoc}")
        # For backward compatibility, generate both internal and external in one file
        generate_asciidoc_by_type(metrics_bag, args.asciidoc, None)
    
    # Only show summary messages, not duplicate file outputs
    print(f"📄 JSON output: {args.json_output}")
    if args.internal_asciidoc:
        print(f"📄 Internal metrics: {args.internal_asciidoc}")
    if args.external_asciidoc:
        print(f"📄 External metrics: {args.external_asciidoc}")
    if args.asciidoc:
        print(f"📄 Legacy AsciiDoc: {args.asciidoc}")
    
    # Show breakdown by type
    metrics_by_type = {}
    for metric_data in metrics_bag.get_all_metrics().values():
        metric_type = metric_data.get('type', 'unknown')
        metrics_by_type[metric_type] = metrics_by_type.get(metric_type, 0) + 1
    
    if metrics_by_type:
        print(f"📊 Metrics by type:")
        for metric_type, count in sorted(metrics_by_type.items()):
            print(f"   • {metric_type}: {count}")
    
    print("🎉 Metrics extraction completed successfully!")


if __name__ == "__main__":
    main()
