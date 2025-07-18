#!/usr/bin/env python3
"""
Compare extracted metrics with existing metrics documentation
"""
import json
import sys
import argparse
import logging
from pathlib import Path

logger = logging.getLogger("compare_metrics")


def load_extracted_metrics(metrics_file):
    """Load metrics from the extracted JSON file"""
    try:
        with open(metrics_file, 'r') as f:
            data = json.load(f)
        return data.get('metrics', {})
    except Exception as e:
        logger.error(f"Failed to load metrics file {metrics_file}: {e}")
        return {}


def load_existing_metrics(existing_file):
    """Load existing metrics from JSON file if available"""
    if not Path(existing_file).exists():
        logger.info(f"No existing metrics file found at {existing_file}")
        return {}
    
    try:
        with open(existing_file, 'r') as f:
            data = json.load(f)
        return data.get('metrics', {})
    except Exception as e:
        logger.warning(f"Failed to load existing metrics file {existing_file}: {e}")
        return {}


def compare_metrics(extracted_metrics, existing_metrics):
    """Compare extracted metrics with existing ones"""
    extracted_names = set(extracted_metrics.keys())
    existing_names = set(existing_metrics.keys())
    
    # Find differences
    new_metrics = extracted_names - existing_names
    removed_metrics = existing_names - extracted_names
    common_metrics = extracted_names & existing_names
    
    print("=== Metrics Comparison Report ===\n")
    
    print(f"Total extracted metrics: {len(extracted_names)}")
    print(f"Total existing metrics: {len(existing_names)}")
    print(f"Common metrics: {len(common_metrics)}")
    print(f"New metrics: {len(new_metrics)}")
    print(f"Removed metrics: {len(removed_metrics)}\n")
    
    if new_metrics:
        print("🆕 NEW METRICS:")
        for metric in sorted(new_metrics):
            metric_info = extracted_metrics[metric]
            print(f"  • {metric} ({metric_info.get('type', 'unknown')})")
            if metric_info.get('description'):
                print(f"    Description: {metric_info['description']}")
            print()
    
    if removed_metrics:
        print("❌ REMOVED METRICS:")
        for metric in sorted(removed_metrics):
            print(f"  • {metric}")
    
    if common_metrics:
        print("📊 METRIC TYPE DISTRIBUTION (extracted):")
        type_counts = {}
        for metric_name in extracted_names:
            metric_type = extracted_metrics[metric_name].get('type', 'unknown')
            type_counts[metric_type] = type_counts.get(metric_type, 0) + 1
        
        for metric_type, count in sorted(type_counts.items()):
            print(f"  • {metric_type}: {count}")
        
        print("\n📁 CONSTRUCTOR DISTRIBUTION:")
        constructor_counts = {}
        for metric_name in extracted_names:
            constructor = extracted_metrics[metric_name].get('constructor', 'unknown')
            constructor_counts[constructor] = constructor_counts.get(constructor, 0) + 1
        
        for constructor, count in sorted(constructor_counts.items()):
            print(f"  • {constructor}: {count}")
    
    return {
        'new_metrics': list(new_metrics),
        'removed_metrics': list(removed_metrics),
        'common_metrics': list(common_metrics),
        'total_extracted': len(extracted_names),
        'total_existing': len(existing_names)
    }


def analyze_metrics_coverage(extracted_metrics):
    """Analyze the coverage and quality of extracted metrics"""
    print("\n=== Metrics Analysis ===\n")
    
    total_metrics = len(extracted_metrics)
    with_description = sum(1 for m in extracted_metrics.values() if m.get('description'))
    with_labels = sum(1 for m in extracted_metrics.values() if m.get('labels'))
    
    print(f"📈 COVERAGE ANALYSIS:")
    print(f"  • Total metrics: {total_metrics}")
    print(f"  • With descriptions: {with_description} ({with_description/total_metrics*100:.1f}%)")
    print(f"  • With labels: {with_labels} ({with_labels/total_metrics*100:.1f}%)")
    
    # Analyze by namespace
    namespaces = {}
    for name, metric in extracted_metrics.items():
        if '_' in name:
            namespace = name.split('_')[0]
            namespaces[namespace] = namespaces.get(namespace, 0) + 1
    
    print(f"\n🏷️ NAMESPACE DISTRIBUTION:")
    for namespace, count in sorted(namespaces.items(), key=lambda x: x[1], reverse=True):
        print(f"  • {namespace}: {count}")
    
    # Find metrics without descriptions
    missing_descriptions = [
        name for name, metric in extracted_metrics.items() 
        if not metric.get('description')
    ]
    
    if missing_descriptions:
        print(f"\n⚠️ METRICS WITHOUT DESCRIPTIONS ({len(missing_descriptions)}):")
        for metric in sorted(missing_descriptions)[:10]:  # Show first 10
            print(f"  • {metric}")
        if len(missing_descriptions) > 10:
            print(f"  ... and {len(missing_descriptions) - 10} more")


def main():
    parser = argparse.ArgumentParser(description="Compare extracted metrics")
    parser.add_argument("metrics_file", help="JSON file with extracted metrics")
    parser.add_argument("--existing", help="Existing metrics JSON file for comparison")
    parser.add_argument("--output", help="Output comparison report to JSON file")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose logging")
    
    args = parser.parse_args()
    
    if args.verbose:
        logging.basicConfig(level=logging.DEBUG)
    else:
        logging.basicConfig(level=logging.INFO)
    
    # Load extracted metrics
    extracted_metrics = load_extracted_metrics(args.metrics_file)
    if not extracted_metrics:
        logger.error("No metrics found in the extracted file")
        sys.exit(1)
    
    # Load existing metrics if provided
    existing_metrics = {}
    if args.existing:
        existing_metrics = load_existing_metrics(args.existing)
    
    # Perform comparison
    if existing_metrics:
        comparison_result = compare_metrics(extracted_metrics, existing_metrics)
    else:
        comparison_result = {
            'new_metrics': list(extracted_metrics.keys()),
            'removed_metrics': [],
            'common_metrics': [],
            'total_extracted': len(extracted_metrics),
            'total_existing': 0
        }
    
    # Analyze metrics
    analyze_metrics_coverage(extracted_metrics)
    
    # Save comparison result if requested
    if args.output:
        with open(args.output, 'w') as f:
            json.dump(comparison_result, f, indent=2)
        logger.info(f"Comparison report saved to {args.output}")


if __name__ == "__main__":
    main()
