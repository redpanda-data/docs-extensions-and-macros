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
    path = options.path

    if not os.path.exists(path):
        logger.error(f'Path does not exist: "{path}".')
        sys.exit(1)


def get_cpp_files(options):
    """Get all C++ source files from the path"""
    path = Path(options.path)
    
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
        "path",
        help="Path to the Redpanda source code directory"
    )
    parser.add_argument(
        "--recursive", 
        "-r", 
        action="store_true", 
        help="Search for C++ files recursively"
    )
    parser.add_argument(
        "--output", 
        "-o", 
        default="metrics.json", 
        help="Output JSON file (default: metrics.json)"
    )
    parser.add_argument(
        "--asciidoc", 
        "-a", 
        help="Generate AsciiDoc output file"
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


def generate_asciidoc(metrics_bag, output_file):
    """Generate AsciiDoc documentation from metrics"""
    with open(output_file, 'w') as f:
        f.write("= Redpanda Metrics Reference\n")
        f.write(":description: Reference documentation for Redpanda metrics extracted from source code.\n")
        f.write(":page-categories: Management, Monitoring\n")
        f.write("\n")
        f.write("This document lists all metrics found in the Redpanda source code.\n")
        f.write("\n")
        
        # Sort metrics by the key (which is now full_name or fallback to unique_id)
        sorted_metrics = sorted(metrics_bag.get_all_metrics().items())
        
        for metric_key, metric_info in sorted_metrics:
            # Use full_name as section header, fallback to metric_key if full_name is not available
            section_name = metric_info.get('full_name', metric_key)
            f.write(f"=== {section_name}\n\n")
            
            if metric_info.get('description'):
                f.write(f"{metric_info['description']}\n\n")
            else:
                f.write("No description available.\n\n")
            
            f.write(f"*Type*: {metric_info.get('type', 'unknown')}\n\n")
            
            if metric_info.get('labels'):
                f.write("*Labels*:\n\n")
                for label in sorted(metric_info['labels']):
                    f.write(f"- `{label}`\n")
                f.write("\n")
            
            if metric_info.get('files') and metric_info['files']:
                f.write(f"*Source*: `{metric_info['files'][0].get('file', '')}`\n\n")
            
            f.write("---\n\n")


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
    
    # Show clean summary
    total_metrics = len(metrics_bag.get_all_metrics())
    print(f"✅ Successfully extracted {total_metrics} metrics from {len(cpp_files)} C++ files")
    
    # Output JSON
    if args.verbose:
        logger.info(f"Writing JSON output to {args.output}")
    with open(args.output, 'w') as f:
        json.dump(metrics_bag.to_dict(), f, indent=2)
    
    # Output AsciiDoc if requested
    if args.asciidoc:
        if args.verbose:
            logger.info(f"Writing AsciiDoc output to {args.asciidoc}")
        generate_asciidoc(metrics_bag, args.asciidoc)
    
    print(f"📄 Output written to: {args.output}")
    if args.asciidoc:
        print(f"📄 AsciiDoc written to: {args.asciidoc}")
    
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
