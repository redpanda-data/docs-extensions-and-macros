#!/usr/bin/env python3
"""
Dual Metrics Documentation Diff Tool

This tool compares Prometheus metrics documentation files in AsciiDoc format
for both public and internal metrics, identifying differences in metrics, 
descriptions, types, and labels.

Usage:
    python metrics_diff.py --original-public orig_pub.adoc --generated-public gen_pub.adoc
    python metrics_diff.py --original-internal orig_int.adoc --generated-internal gen_int.adoc
    python metrics_diff.py --original-public orig_pub.adoc --generated-public gen_pub.adoc --original-internal orig_int.adoc --generated-internal gen_int.adoc
"""

import re
import json
import argparse
import sys
from typing import Dict, List, Set, Tuple, Optional
from dataclasses import dataclass, field
from collections import defaultdict


@dataclass
class MetricInfo:
    """Structure to hold metric information"""
    name: str
    description: str = ""
    metric_type: str = ""
    labels: List[str] = field(default_factory=list)
    usage: str = ""
    section: str = ""
    raw_content: str = ""


class MetricsParser:
    """Parser for AsciiDoc metrics documentation"""
    
    def __init__(self, metric_header_level: str = "==="):
        """
        Initialize parser with specific header level
        metric_header_level: "===" for public metrics, "==" for internal metrics
        """
        self.metrics = {}
        self.current_section = ""
        self.metric_header_level = metric_header_level
    
    def parse_file(self, content: str) -> Dict[str, MetricInfo]:
        """Parse the AsciiDoc content and extract metrics information"""
        lines = content.split('\n')
        current_metric = None
        in_metric_block = False
        collecting_description = False
        collecting_labels = False
        collecting_usage = False
        raw_start = 0
        
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            
            # Skip empty lines
            if not line:
                i += 1
                continue
            
            # Handle different header levels based on metric type
            if self.metric_header_level == "===":
                # PUBLIC METRICS: == is section, === is metric
                if line.startswith('== ') and not line.startswith('=== '):
                    self.current_section = line[3:].strip()
                    i += 1
                    continue
                elif line.startswith('=== '):
                    # Save previous metric if exists
                    if current_metric and current_metric.name:
                        raw_end = i
                        current_metric.raw_content = '\n'.join(lines[raw_start:raw_end])
                        self.metrics[current_metric.name] = current_metric
                    
                    metric_name = line[4:].strip()
                    current_metric = MetricInfo(
                        name=metric_name,
                        section=self.current_section
                    )
                    in_metric_block = True
                    collecting_description = True
                    collecting_labels = False
                    collecting_usage = False
                    raw_start = i
                    i += 1
                    continue
                    
            elif self.metric_header_level == "==":
                # INTERNAL METRICS: == is metric (no section headers typically)
                if line.startswith('== ') and not line.startswith('=== '):
                    # Check if this looks like a metric name (starts with vectorized_)
                    potential_metric = line[3:].strip()
                    if potential_metric.startswith('vectorized_') or len(potential_metric.split()) == 1:
                        # This is a metric header
                        # Save previous metric if exists
                        if current_metric and current_metric.name:
                            raw_end = i
                            current_metric.raw_content = '\n'.join(lines[raw_start:raw_end])
                            self.metrics[current_metric.name] = current_metric
                        
                        metric_name = potential_metric
                        current_metric = MetricInfo(
                            name=metric_name,
                            section=self.current_section or "Internal Metrics"
                        )
                        in_metric_block = True
                        collecting_description = True
                        collecting_labels = False
                        collecting_usage = False
                        raw_start = i
                        i += 1
                        continue
                    else:
                        # This might be a section header (rare in internal metrics)
                        self.current_section = potential_metric
                        i += 1
                        continue
            
            if not in_metric_block or not current_metric:
                i += 1
                continue
            
            # Check for Type specification
            if line.startswith('*Type*:'):
                current_metric.metric_type = line.split(':', 1)[1].strip()
                collecting_description = False
                i += 1
                continue
            
            # Check for Labels section
            if line.startswith('*Labels*:'):
                collecting_labels = True
                collecting_description = False
                collecting_usage = False
                i += 1
                continue
            
            # Check for Usage section
            if line.startswith('*Usage*:'):
                collecting_usage = True
                collecting_description = False
                collecting_labels = False
                i += 1
                continue
            
            # Check for end of metric (horizontal rule)
            if line.startswith('---'):
                collecting_description = False
                collecting_labels = False
                collecting_usage = False
                i += 1
                continue
            
            # Collect content based on current state
            if collecting_description and not line.startswith('*') and not line.startswith('- ') and not line.startswith('* '):
                if current_metric.description:
                    current_metric.description += " " + line
                else:
                    current_metric.description = line
            
            elif collecting_labels:
                # Extract label information
                if line.startswith('- ') or line.startswith('* '):
                    label_text = line[2:].strip()
                    # Clean up label text by removing backticks and extra formatting
                    label_text = re.sub(r'`([^`]+)`', r'\1', label_text)
                    current_metric.labels.append(label_text)
                elif line and not line.startswith('*'):
                    # Continue collecting labels if not a new section
                    if current_metric.labels:
                        current_metric.labels[-1] += " " + line
            
            elif collecting_usage:
                if not line.startswith('*'):
                    if current_metric.usage:
                        current_metric.usage += " " + line
                    else:
                        current_metric.usage = line
            
            i += 1
        
        # Don't forget the last metric
        if current_metric and current_metric.name:
            current_metric.raw_content = '\n'.join(lines[raw_start:])
            self.metrics[current_metric.name] = current_metric
        
        return self.metrics


class MetricsDiff:
    """Class to compare two sets of metrics and generate diff report"""
    
    def __init__(self, original_metrics: Dict[str, MetricInfo], generated_metrics: Dict[str, MetricInfo], metrics_type: str = ""):
        self.original = original_metrics
        self.generated = generated_metrics
        self.metrics_type = metrics_type
        
    def get_metric_sets(self) -> Tuple[Set[str], Set[str], Set[str], Set[str]]:
        """Get sets of metric names for comparison"""
        original_names = set(self.original.keys())
        generated_names = set(self.generated.keys())
        
        removed = original_names - generated_names
        added = generated_names - original_names
        common = original_names & generated_names
        
        return removed, added, common, original_names | generated_names
    
    def compare_metrics(self) -> Dict:
        """Compare metrics and return comprehensive diff report"""
        removed, added, common, all_metrics = self.get_metric_sets()
        
        report = {
            'metrics_type': self.metrics_type,
            'summary': {
                'total_original': len(self.original),
                'total_generated': len(self.generated),
                'removed_count': len(removed),
                'added_count': len(added),
                'common_count': len(common),
                'modified_count': 0
            },
            'removed_metrics': sorted(list(removed)),
            'added_metrics': sorted(list(added)),
            'modified_metrics': {},
            'section_changes': self._analyze_section_changes(),
            'type_changes': self._analyze_type_changes(),
            'label_changes': self._analyze_label_changes()
        }
        
        # Analyze modifications in common metrics
        modified_count = 0
        for metric_name in common:
            original_metric = self.original[metric_name]
            generated_metric = self.generated[metric_name]
            
            changes = self._compare_single_metric(original_metric, generated_metric)
            if changes:
                report['modified_metrics'][metric_name] = changes
                modified_count += 1
        
        report['summary']['modified_count'] = modified_count
        
        return report
    
    def _compare_single_metric(self, original: MetricInfo, generated: MetricInfo) -> Dict:
        """Compare two metrics and return differences"""
        changes = {}
        
        # Compare descriptions
        orig_desc = original.description.strip()
        gen_desc = generated.description.strip()
        if orig_desc != gen_desc:
            changes['description'] = {
                'original': orig_desc,
                'generated': gen_desc,
                'length_diff': len(gen_desc) - len(orig_desc)
            }
        
        # Compare types
        if original.metric_type != generated.metric_type:
            changes['type'] = {
                'original': original.metric_type,
                'generated': generated.metric_type
            }
        
        # Compare labels
        original_labels = set(original.labels)
        generated_labels = set(generated.labels)
        
        if original_labels != generated_labels:
            changes['labels'] = {
                'removed': sorted(list(original_labels - generated_labels)),
                'added': sorted(list(generated_labels - original_labels)),
                'original_count': len(original_labels),
                'generated_count': len(generated_labels),
                'original_labels': sorted(list(original_labels)),
                'generated_labels': sorted(list(generated_labels))
            }
        
        # Compare usage
        orig_usage = original.usage.strip()
        gen_usage = generated.usage.strip()
        if orig_usage != gen_usage:
            changes['usage'] = {
                'original': orig_usage,
                'generated': gen_usage,
                'original_has_usage': bool(orig_usage),
                'generated_has_usage': bool(gen_usage)
            }
        
        # Compare sections
        if original.section != generated.section:
            changes['section'] = {
                'original': original.section,
                'generated': generated.section
            }
        
        return changes
    
    def _analyze_section_changes(self) -> Dict:
        """Analyze changes in metric organization by sections"""
        original_by_section = defaultdict(list)
        generated_by_section = defaultdict(list)
        
        for name, metric in self.original.items():
            original_by_section[metric.section].append(name)
        
        for name, metric in self.generated.items():
            generated_by_section[metric.section].append(name)
        
        section_changes = {}
        all_sections = set(original_by_section.keys()) | set(generated_by_section.keys())
        
        for section in all_sections:
            original_metrics = set(original_by_section.get(section, []))
            generated_metrics = set(generated_by_section.get(section, []))
            
            if original_metrics != generated_metrics:
                section_changes[section] = {
                    'original_count': len(original_metrics),
                    'generated_count': len(generated_metrics),
                    'removed': sorted(list(original_metrics - generated_metrics)),
                    'added': sorted(list(generated_metrics - original_metrics)),
                    'moved_in': [],
                    'moved_out': []
                }
        
        # Identify metrics that moved between sections
        for metric_name in set(self.original.keys()) & set(self.generated.keys()):
            orig_section = self.original[metric_name].section
            gen_section = self.generated[metric_name].section
            if orig_section != gen_section:
                if orig_section in section_changes:
                    section_changes[orig_section]['moved_out'].append(f"{metric_name} -> {gen_section}")
                if gen_section in section_changes:
                    section_changes[gen_section]['moved_in'].append(f"{metric_name} <- {orig_section}")
        
        return section_changes
    
    def _analyze_type_changes(self) -> Dict:
        """Analyze changes in metric types"""
        type_changes = {}
        
        for metric_name in set(self.original.keys()) & set(self.generated.keys()):
            orig_type = self.original[metric_name].metric_type
            gen_type = self.generated[metric_name].metric_type
            
            if orig_type != gen_type:
                type_changes[metric_name] = {
                    'original': orig_type,
                    'generated': gen_type
                }
        
        return type_changes
    
    def _analyze_label_changes(self) -> Dict:
        """Analyze changes in metric labels across all metrics"""
        label_stats = {
            'metrics_with_labels_removed': 0,
            'metrics_with_labels_added': 0,
            'metrics_with_label_changes': 0,
            'total_labels_removed': 0,
            'total_labels_added': 0,
            'common_labels_removed': set(),
            'common_labels_added': set()
        }
        
        for metric_name in set(self.original.keys()) & set(self.generated.keys()):
            orig_labels = set(self.original[metric_name].labels)
            gen_labels = set(self.generated[metric_name].labels)
            
            removed_labels = orig_labels - gen_labels
            added_labels = gen_labels - orig_labels
            
            if removed_labels or added_labels:
                label_stats['metrics_with_label_changes'] += 1
                
                if removed_labels:
                    label_stats['metrics_with_labels_removed'] += 1
                    label_stats['total_labels_removed'] += len(removed_labels)
                    label_stats['common_labels_removed'].update(removed_labels)
                
                if added_labels:
                    label_stats['metrics_with_labels_added'] += 1
                    label_stats['total_labels_added'] += len(added_labels)
                    label_stats['common_labels_added'].update(added_labels)
        
        # Convert sets to sorted lists for JSON serialization
        label_stats['common_labels_removed'] = sorted(list(label_stats['common_labels_removed']))
        label_stats['common_labels_added'] = sorted(list(label_stats['common_labels_added']))
        
        return label_stats


class DualMetricsReportGenerator:
    """Generate combined reports for both public and internal metrics"""
    
    def __init__(self, public_diff: Optional[MetricsDiff] = None, internal_diff: Optional[MetricsDiff] = None):
        self.public_diff = public_diff
        self.internal_diff = internal_diff
    
    def generate_combined_report(self, output_file: str = None) -> str:
        """Generate a comprehensive report for both metric types"""
        report_lines = []
        report_lines.append("# Metrics Documentation Diff Report")
        report_lines.append("=" * 60)
        report_lines.append("")
        
        # Overall summary
        total_original = 0
        total_generated = 0
        total_removed = 0
        total_added = 0
        total_modified = 0
        
        if self.public_diff:
            public_data = self.public_diff.compare_metrics()
            total_original += public_data['summary']['total_original']
            total_generated += public_data['summary']['total_generated']
            total_removed += public_data['summary']['removed_count']
            total_added += public_data['summary']['added_count']
            total_modified += public_data['summary']['modified_count']
        
        if self.internal_diff:
            internal_data = self.internal_diff.compare_metrics()
            total_original += internal_data['summary']['total_original']
            total_generated += internal_data['summary']['total_generated']
            total_removed += internal_data['summary']['removed_count']
            total_added += internal_data['summary']['added_count']
            total_modified += internal_data['summary']['modified_count']
        
        report_lines.append("## Overall Summary")
        report_lines.append(f"- **Total original metrics**: {total_original}")
        report_lines.append(f"- **Total generated metrics**: {total_generated}")
        report_lines.append(f"- **Net change**: {total_generated - total_original:+d}")
        report_lines.append(f"- **Total removed**: {total_removed}")
        report_lines.append(f"- **Total added**: {total_added}")
        report_lines.append(f"- **Total modified**: {total_modified}")
        report_lines.append("")
        
        # Individual reports
        if self.public_diff:
            report_lines.append("# PUBLIC METRICS")
            report_lines.append("=" * 40)
            public_report = self._generate_single_report(self.public_diff, "Public")
            report_lines.extend(public_report.split('\n')[3:])  # Skip the title
            report_lines.append("")
        
        if self.internal_diff:
            report_lines.append("# INTERNAL METRICS")
            report_lines.append("=" * 40)
            internal_report = self._generate_single_report(self.internal_diff, "Internal")
            report_lines.extend(internal_report.split('\n')[3:])  # Skip the title
            report_lines.append("")
        
        report_text = '\n'.join(report_lines)
        
        if output_file:
            with open(output_file, 'w', encoding='utf-8') as f:
                f.write(report_text)
            print(f"Combined report saved to {output_file}")
        
        return report_text
    
    def _generate_single_report(self, diff_tool: MetricsDiff, metrics_type: str) -> str:
        """Generate a report for a single metrics type"""
        diff_data = diff_tool.compare_metrics()
        
        report_lines = []
        report_lines.append(f"# {metrics_type} Metrics Report")
        report_lines.append("=" * 40)
        report_lines.append("")
        
        # Summary
        summary = diff_data['summary']
        report_lines.append("## Summary")
        report_lines.append(f"- **Original metrics count**: {summary['total_original']}")
        report_lines.append(f"- **Generated metrics count**: {summary['total_generated']}")
        report_lines.append(f"- **Net change**: {summary['total_generated'] - summary['total_original']:+d}")
        report_lines.append(f"- **Removed metrics**: {summary['removed_count']}")
        report_lines.append(f"- **Added metrics**: {summary['added_count']}")
        report_lines.append(f"- **Modified metrics**: {summary['modified_count']}")
        report_lines.append(f"- **Unchanged metrics**: {summary['common_count'] - summary['modified_count']}")
        report_lines.append("")
        
        # Label changes summary
        label_stats = diff_data['label_changes']
        if label_stats['metrics_with_label_changes'] > 0:
            report_lines.append("## Label Changes Summary")
            report_lines.append(f"- Metrics with label changes: {label_stats['metrics_with_label_changes']}")
            report_lines.append(f"- Total labels removed: {label_stats['total_labels_removed']}")
            report_lines.append(f"- Total labels added: {label_stats['total_labels_added']}")
            if label_stats['common_labels_removed']:
                removed_preview = ', '.join(label_stats['common_labels_removed'][:5])
                if len(label_stats['common_labels_removed']) > 5:
                    removed_preview += "..."
                report_lines.append(f"- Common removed labels: {removed_preview}")
            if label_stats['common_labels_added']:
                added_preview = ', '.join(label_stats['common_labels_added'][:5])
                if len(label_stats['common_labels_added']) > 5:
                    added_preview += "..."
                report_lines.append(f"- Common added labels: {added_preview}")
            report_lines.append("")
        
        # Type changes summary
        type_changes = diff_data['type_changes']
        if type_changes:
            report_lines.append("## Type Changes Summary")
            report_lines.append(f"- Metrics with type changes: {len(type_changes)}")
            for metric, change in list(type_changes.items())[:5]:  # Show first 5
                report_lines.append(f"  - {metric}: {change['original']} → {change['generated']}")
            if len(type_changes) > 5:
                report_lines.append(f"  - ... and {len(type_changes) - 5} more")
            report_lines.append("")
        
        # Removed metrics
        if diff_data['removed_metrics']:
            report_lines.append("## Removed Metrics")
            for metric in diff_data['removed_metrics']:
                section = diff_tool.original[metric].section if metric in diff_tool.original else "Unknown"
                report_lines.append(f"- {metric} (from {section})")
            report_lines.append("")
        
        # Added metrics
        if diff_data['added_metrics']:
            report_lines.append("## Added Metrics")
            for metric in diff_data['added_metrics']:
                section = diff_tool.generated[metric].section if metric in diff_tool.generated else "Unknown"
                report_lines.append(f"- {metric} (in {section})")
            report_lines.append("")
        
        # Modified metrics (show top 10)
        if diff_data['modified_metrics']:
            report_lines.append("## Modified Metrics (Top 10)")
            count = 0
            for metric_name, changes in diff_data['modified_metrics'].items():
                if count >= 10:
                    report_lines.append(f"... and {len(diff_data['modified_metrics']) - 10} more modified metrics")
                    break
                
                report_lines.append(f"### {metric_name}")
                
                if 'description' in changes:
                    desc_change = changes['description']
                    report_lines.append("**Description changed:**")
                    if len(desc_change['original']) > 100 or len(desc_change['generated']) > 100:
                        report_lines.append(f"- Length change: {desc_change['length_diff']:+d} characters")
                        report_lines.append(f"- Original: {desc_change['original'][:100]}...")
                        report_lines.append(f"- Generated: {desc_change['generated'][:100]}...")
                    else:
                        report_lines.append(f"- Original: {desc_change['original']}")
                        report_lines.append(f"- Generated: {desc_change['generated']}")
                    report_lines.append("")
                
                if 'type' in changes:
                    report_lines.append("**Type changed:**")
                    report_lines.append(f"- {changes['type']['original']} → {changes['type']['generated']}")
                    report_lines.append("")
                
                if 'labels' in changes:
                    label_changes = changes['labels']
                    report_lines.append("**Labels changed:**")
                    report_lines.append(f"- Count: {label_changes['original_count']} → {label_changes['generated_count']}")
                    if label_changes['removed']:
                        report_lines.append(f"- Removed: {', '.join(label_changes['removed'])}")
                    if label_changes['added']:
                        report_lines.append(f"- Added: {', '.join(label_changes['added'])}")
                    report_lines.append("")
                
                if 'usage' in changes:
                    usage_change = changes['usage']
                    report_lines.append("**Usage changed:**")
                    report_lines.append(f"- Had usage: {usage_change['original_has_usage']} → {usage_change['generated_has_usage']}")
                    report_lines.append("")
                
                if 'section' in changes:
                    report_lines.append("**Section changed:**")
                    report_lines.append(f"- {changes['section']['original']} → {changes['section']['generated']}")
                
                report_lines.append("---")
                report_lines.append("")
                count += 1
        
        # Section changes
        if diff_data['section_changes']:
            report_lines.append("## Section Changes")
            for section, changes in diff_data['section_changes'].items():
                report_lines.append(f"### {section}")
                report_lines.append(f"- Metric count: {changes['original_count']} → {changes['generated_count']}")
                if changes['removed']:
                    removed_preview = ', '.join(changes['removed'][:5])
                    if len(changes['removed']) > 5:
                        removed_preview += f" ... ({len(changes['removed']) - 5} more)"
                    report_lines.append(f"- Removed: {removed_preview}")
                if changes['added']:
                    added_preview = ', '.join(changes['added'][:5])
                    if len(changes['added']) > 5:
                        added_preview += f" ... ({len(changes['added']) - 5} more)"
                    report_lines.append(f"- Added: {added_preview}")
                if changes['moved_out']:
                    report_lines.append(f"- Moved out: {', '.join(changes['moved_out'][:3])}...")
                if changes['moved_in']:
                    report_lines.append(f"- Moved in: {', '.join(changes['moved_in'][:3])}...")
                report_lines.append("")
        
        return '\n'.join(report_lines)


def main():
    """Main function to run the metrics diff tool"""
    parser = argparse.ArgumentParser(
        description='Compare Redpanda metrics documentation files (public and/or internal)',
        epilog='''
Examples:
  %(prog)s --original-public orig_pub.adoc --generated-public gen_pub.adoc
  %(prog)s --original-internal orig_int.adoc --generated-internal gen_int.adoc
  %(prog)s --original-public orig_pub.adoc --generated-public gen_pub.adoc --original-internal orig_int.adoc --generated-internal gen_int.adoc
        ''',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    # Public metrics arguments
    parser.add_argument('--original-public', help='Path to original (published) public metrics file')
    parser.add_argument('--generated-public', help='Path to generated (automated) public metrics file')
    
    # Internal metrics arguments
    parser.add_argument('--original-internal', help='Path to original (published) internal metrics file')
    parser.add_argument('--generated-internal', help='Path to generated (automated) internal metrics file')
    
    # Output arguments
    parser.add_argument('--output', help='Output file for the combined report (default: metrics_diff_report.md)')
    parser.add_argument('--json', help='Output file for JSON data (default: metrics_diff_data.json)')
    parser.add_argument('--verbose', '-v', action='store_true', help='Verbose output')
    parser.add_argument('--debug', action='store_true', help='Debug parsing (shows first 10 metrics found)')
    
    args = parser.parse_args()
    
    # Validate arguments
    if not any([args.original_public, args.original_internal]):
        print("Error: You must specify at least one type of metrics to compare.")
        print("Use --original-public and --generated-public for public metrics,")
        print("or --original-internal and --generated-internal for internal metrics,")
        print("or both.")
        sys.exit(1)
    
    if args.original_public and not args.generated_public:
        print("Error: --original-public requires --generated-public")
        sys.exit(1)
    
    if args.original_internal and not args.generated_internal:
        print("Error: --original-internal requires --generated-internal")
        sys.exit(1)
    
    # Initialize diff tools
    public_diff = None
    internal_diff = None
    
    # Process public metrics if provided
    if args.original_public and args.generated_public:
        try:
            print(f"Loading public metrics files...")
            print(f"  Original: {args.original_public}")
            with open(args.original_public, 'r', encoding='utf-8') as f:
                orig_public_content = f.read()
            
            print(f"  Generated: {args.generated_public}")
            with open(args.generated_public, 'r', encoding='utf-8') as f:
                gen_public_content = f.read()
            
            print("Parsing public metrics...")
            orig_public_parser = MetricsParser("===")  # Public metrics use ===
            gen_public_parser = MetricsParser("===")
            
            orig_public_metrics = orig_public_parser.parse_file(orig_public_content)
            gen_public_metrics = gen_public_parser.parse_file(gen_public_content)
            
            print(f"✓ Parsed {len(orig_public_metrics)} original public metrics")
            print(f"✓ Parsed {len(gen_public_metrics)} generated public metrics")
            
            public_diff = MetricsDiff(orig_public_metrics, gen_public_metrics, "public")
            
        except FileNotFoundError as e:
            print(f"Error: Could not find public metrics file '{e.filename}'")
            sys.exit(1)
        except Exception as e:
            print(f"Error processing public metrics: {e}")
            sys.exit(1)
    
    # Process internal metrics if provided
    if args.original_internal and args.generated_internal:
        try:
            print(f"Loading internal metrics files...")
            print(f"  Original: {args.original_internal}")
            with open(args.original_internal, 'r', encoding='utf-8') as f:
                orig_internal_content = f.read()
            
            print(f"  Generated: {args.generated_internal}")
            with open(args.generated_internal, 'r', encoding='utf-8') as f:
                gen_internal_content = f.read()
            
            print("Parsing internal metrics...")
            orig_internal_parser = MetricsParser("==")  # Internal metrics use ==
            gen_internal_parser = MetricsParser("==")
            
            orig_internal_metrics = orig_internal_parser.parse_file(orig_internal_content)
            gen_internal_metrics = gen_internal_parser.parse_file(gen_internal_content)
            
            print(f"✓ Parsed {len(orig_internal_metrics)} original internal metrics")
            print(f"✓ Parsed {len(gen_internal_metrics)} generated internal metrics")
            
            if args.debug:
                print("\nDEBUG: First 10 original internal metrics found:")
                for i, (name, metric) in enumerate(list(orig_internal_metrics.items())[:10]):
                    print(f"  {i+1:2d}. {name} (type: {metric.metric_type}, section: {metric.section})")
                
                print("\nDEBUG: First 10 generated internal metrics found:")
                for i, (name, metric) in enumerate(list(gen_internal_metrics.items())[:10]):
                    print(f"  {i+1:2d}. {name} (type: {metric.metric_type}, section: {metric.section})")
            
            internal_diff = MetricsDiff(orig_internal_metrics, gen_internal_metrics, "internal")
            
        except FileNotFoundError as e:
            print(f"Error: Could not find internal metrics file '{e.filename}'")
            sys.exit(1)
        except Exception as e:
            print(f"Error processing internal metrics: {e}")
            sys.exit(1)
    
    # Verbose output
    if args.verbose:
        if public_diff:
            print("\nPublic metrics summary:")
            pub_data = public_diff.compare_metrics()
            print(f"  Original: {pub_data['summary']['total_original']}")
            print(f"  Generated: {pub_data['summary']['total_generated']}")
            print(f"  Changes: {pub_data['summary']['modified_count']} modified, {pub_data['summary']['added_count']} added, {pub_data['summary']['removed_count']} removed")
        
        if internal_diff:
            print("\nInternal metrics summary:")
            int_data = internal_diff.compare_metrics()
            print(f"  Original: {int_data['summary']['total_original']}")
            print(f"  Generated: {int_data['summary']['total_generated']}")
            print(f"  Changes: {int_data['summary']['modified_count']} modified, {int_data['summary']['added_count']} added, {int_data['summary']['removed_count']} removed")
    
    # Generate reports
    print("\nAnalyzing differences...")
    report_generator = DualMetricsReportGenerator(public_diff, internal_diff)
    
    report_file = args.output or "metrics_diff_report.md"
    json_file = args.json or "metrics_diff_data.json"
    
    try:
        # Generate combined report
        report = report_generator.generate_combined_report(report_file)
        
        print("\n" + "="*60)
        print("METRICS DOCUMENTATION DIFF REPORT")
        print("="*60)
        print(report[:3000])  # Show first 3000 characters
        if len(report) > 3000:
            print(f"\n... (truncated, full report saved to {report_file})")
        
        # Save detailed JSON data
        combined_data = {}
        if public_diff:
            combined_data['public'] = public_diff.compare_metrics()
        if internal_diff:
            combined_data['internal'] = internal_diff.compare_metrics()
        
        with open(json_file, "w", encoding='utf-8') as f:
            json.dump(combined_data, f, indent=2, default=str)
        
        print(f"\n✓ Combined report saved to: {report_file}")
        print(f"✓ JSON data saved to: {json_file}")
        
        # Summary stats
        total_original = 0
        total_generated = 0
        total_changes = 0
        
        if public_diff:
            pub_data = public_diff.compare_metrics()
            total_original += pub_data['summary']['total_original']
            total_generated += pub_data['summary']['total_generated']
            total_changes += pub_data['summary']['modified_count'] + pub_data['summary']['added_count'] + pub_data['summary']['removed_count']
        
        if internal_diff:
            int_data = internal_diff.compare_metrics()
            total_original += int_data['summary']['total_original']
            total_generated += int_data['summary']['total_generated']
            total_changes += int_data['summary']['modified_count'] + int_data['summary']['added_count'] + int_data['summary']['removed_count']
        
        print(f"\n📊 Overall Summary:")
        print(f"   Total metrics: {total_original} → {total_generated} ({total_generated - total_original:+d})")
        print(f"   Total changes: {total_changes}")
        
        if public_diff and internal_diff:
            print(f"   Public metrics processed: ✓")
            print(f"   Internal metrics processed: ✓")
        elif public_diff:
            print(f"   Public metrics processed: ✓")
        elif internal_diff:
            print(f"   Internal metrics processed: ✓")
        
    except Exception as e:
        print(f"Error generating report: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()