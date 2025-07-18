#!/usr/bin/env python3
import logging
import sys
import os
import json
import re
import argparse
from pathlib import Path
from tree_sitter import Language, Parser
from metrics_parser import build_treesitter_cpp_library, extract_metrics_from_files
from metrics_bag import MetricsBag

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
        
        # Sort metrics by name
        sorted_metrics = sorted(metrics_bag.get_all_metrics().items())
        
        for metric_name, metric_info in sorted_metrics:
            f.write(f"=== {metric_name}\n\n")
            
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
            
            if metric_info.get('file'):
                f.write(f"*Source*: `{metric_info['file']}`\n\n")
            
            f.write("---\n\n")


def main():
    args = parse_args()
    
    if args.verbose:
        logging.basicConfig(level=logging.DEBUG)
    else:
        logging.basicConfig(level=logging.INFO)
    
    validate_paths(args)
    
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
    
    logger.info("Finding C++ source files...")
    cpp_files = get_cpp_files(args)
    logger.info(f"Found {len(cpp_files)} C++ files")
    
    logger.info("Extracting metrics from source files...")
    metrics_bag = extract_metrics_from_files(
        cpp_files, treesitter_parser, cpp_language, args.filter_namespace
    )
    
    logger.info(f"Extracted {len(metrics_bag.get_all_metrics())} metrics")
    
    # Output JSON
    logger.info(f"Writing JSON output to {args.output}")
    with open(args.output, 'w') as f:
        json.dump(metrics_bag.to_dict(), f, indent=2)
    
    # Output AsciiDoc if requested
    if args.asciidoc:
        logger.info(f"Writing AsciiDoc output to {args.asciidoc}")
        generate_asciidoc(metrics_bag, args.asciidoc)
    
    logger.info("Metrics extraction completed successfully!")


if __name__ == "__main__":
    main()
