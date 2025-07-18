#!/usr/bin/env python3
"""
AsciiDoc Metrics Comparison Tool

This script compares two AsciiDoc files containing Redpanda metrics documentation.
It extracts metric information from both files and provides detailed comparison results.
Handles different heading levels (== vs ===) for the same metrics.
"""

import re
import argparse
from typing import Dict, List, Tuple, Optional
from dataclasses import dataclass
from difflib import SequenceMatcher


@dataclass
class Metric:
    """Represents a single metric with its properties."""
    name: str
    description: str
    type_info: str
    labels: List[str]
    usage: str
    related_topics: List[str]
    raw_content: str
    heading_level: str  # Added to track original heading level


class MetricsParser:
    """Parser for extracting metrics from AsciiDoc files."""
    
    def __init__(self):
        # Updated pattern to match both == and === metric sections
        # This pattern captures metrics that start with redpanda_, vectorized_, or similar prefixes
        self.metric_pattern = re.compile(
            r'^(={2,3})\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\n\n(.*?)(?=\n={2,3}|\n=(?!=)|\Z)',
            re.DOTALL | re.MULTILINE
        )
        
    def parse_file(self, content: str) -> Dict[str, Metric]:
        """Parse AsciiDoc content and extract metrics."""
        metrics = {}
        
        matches = self.metric_pattern.findall(content)
        
        for match in matches:
            heading_level = match[0]  # == or ===
            metric_name = match[1].strip()
            metric_content = match[2].strip()
            
            # Only process if it looks like a metric name (contains underscore and doesn't start with uppercase)
            if '_' in metric_name and not metric_name[0].isupper():
                try:
                    metric = self._parse_metric_content(metric_name, metric_content, heading_level)
                    metrics[metric_name] = metric
                except Exception as e:
                    print(f"Warning: Failed to parse metric {metric_name}: {e}")
                
        return metrics
    
    def _parse_metric_content(self, name: str, content: str, heading_level: str) -> Metric:
        """Parse individual metric content."""
        lines = content.split('\n')
        
        # Extract description (first non-empty line before *Type*)
        description = ""
        type_info = ""
        labels = []
        usage = ""
        related_topics = []
        
        i = 0
        # Get description
        while i < len(lines):
            line = lines[i].strip()
            if line and not line.startswith('*Type*'):
                description = line
                break
            i += 1
        
        # Extract other fields
        current_section = None
        section_content = []
        
        for line in lines:
            line = line.strip()
            
            if line.startswith('*Type*:'):
                if current_section:
                    self._process_section(current_section, section_content, locals())
                current_section = 'type'
                section_content = [line.replace('*Type*:', '').strip()]
                
            elif line.startswith('*Labels*:'):
                if current_section:
                    self._process_section(current_section, section_content, locals())
                current_section = 'labels'
                section_content = []
                
            elif line.startswith('*Usage*:'):
                if current_section:
                    self._process_section(current_section, section_content, locals())
                current_section = 'usage'
                section_content = []
                
            elif line.startswith('*Related topics*:'):
                if current_section:
                    self._process_section(current_section, section_content, locals())
                current_section = 'related'
                section_content = []
                
            elif line.startswith('---'):
                if current_section:
                    self._process_section(current_section, section_content, locals())
                break
                
            elif current_section and line:
                section_content.append(line)
        
        # Process final section
        if current_section:
            self._process_section(current_section, section_content, locals())
        
        return Metric(
            name=name,
            description=description,
            type_info=type_info,
            labels=labels,
            usage=usage,
            related_topics=related_topics,
            raw_content=content,
            heading_level=heading_level
        )
    
    def _process_section(self, section: str, content: List[str], local_vars: dict):
        """Process content for specific sections."""
        if section == 'type':
            local_vars['type_info'] = ' '.join(content).strip()
        elif section == 'labels':
            # Extract labels, handling various formats
            for line in content:
                if line.startswith('*') or line.startswith('-'):
                    # Remove markdown formatting and extract label
                    clean_line = re.sub(r'[*`-]', '', line).strip()
                    if clean_line:
                        local_vars['labels'].append(clean_line)
        elif section == 'usage':
            local_vars['usage'] = ' '.join(content).strip()
        elif section == 'related':
            local_vars['related_topics'] = content.copy()


class MetricsComparator:
    """Compares two sets of metrics and provides detailed analysis."""
    
    def __init__(self):
        self.similarity_threshold = 0.8
    
    def compare(self, file1_metrics: Dict[str, Metric], file2_metrics: Dict[str, Metric]) -> dict:
        """Compare two sets of metrics and return detailed results."""
        
        file1_names = set(file1_metrics.keys())
        file2_names = set(file2_metrics.keys())
        
        # Find differences
        only_in_file1 = file1_names - file2_names
        only_in_file2 = file2_names - file1_names
        common_metrics = file1_names & file2_names
        
        # Analyze common metrics for description improvements
        improved_descriptions = []
        different_properties = []
        heading_level_differences = []
        
        for metric_name in common_metrics:
            metric1 = file1_metrics[metric_name]
            metric2 = file2_metrics[metric_name]
            
            # Check for heading level differences
            if metric1.heading_level != metric2.heading_level:
                heading_level_differences.append({
                    'name': metric_name,
                    'file1_level': metric1.heading_level,
                    'file2_level': metric2.heading_level
                })
            
            # Compare descriptions
            if metric1.description != metric2.description:
                similarity = self._calculate_similarity(metric1.description, metric2.description)
                
                improved_descriptions.append({
                    'name': metric_name,
                    'file1_desc': metric1.description,
                    'file2_desc': metric2.description,
                    'similarity': similarity,
                    'likely_improvement': len(metric1.description) > len(metric2.description) and similarity > 0.5
                })
            
            # Compare other properties
            differences = self._compare_metric_properties(metric1, metric2)
            if differences:
                different_properties.append({
                    'name': metric_name,
                    'differences': differences
                })
        
        return {
            'file1_unique': sorted(only_in_file1),
            'file2_unique': sorted(only_in_file2),
            'common_count': len(common_metrics),
            'improved_descriptions': improved_descriptions,
            'different_properties': different_properties,
            'heading_level_differences': heading_level_differences,
            'total_file1': len(file1_metrics),
            'total_file2': len(file2_metrics)
        }
    
    def _calculate_similarity(self, text1: str, text2: str) -> float:
        """Calculate similarity between two text strings."""
        return SequenceMatcher(None, text1.lower(), text2.lower()).ratio()
    
    def _compare_metric_properties(self, metric1: Metric, metric2: Metric) -> List[str]:
        """Compare properties of two metrics and return list of differences."""
        differences = []
        
        if metric1.type_info != metric2.type_info:
            differences.append(f"Type: '{metric1.type_info}' vs '{metric2.type_info}'")
        
        if set(metric1.labels) != set(metric2.labels):
            differences.append(f"Labels differ")
        
        if metric1.usage != metric2.usage:
            differences.append(f"Usage differs")
        
        return differences


def print_comparison_results(results: dict, file1_name: str, file2_name: str):
    """Print detailed comparison results."""
    
    print(f"\n{'='*60}")
    print(f"METRICS COMPARISON REPORT")
    print(f"{'='*60}")
    print(f"File 1 ({file1_name}): {results['total_file1']} metrics")
    print(f"File 2 ({file2_name}): {results['total_file2']} metrics")
    print(f"Common metrics: {results['common_count']}")
    
    # Heading level differences
    if results['heading_level_differences']:
        print(f"\n📏 HEADING LEVEL DIFFERENCES:")
        print(f"   Count: {len(results['heading_level_differences'])}")
        for item in results['heading_level_differences']:
            print(f"   - {item['name']}: {item['file1_level']} vs {item['file2_level']}")
    
    # Metrics only in file 1 (should be removed)
    if results['file1_unique']:
        print(f"\n🗑️  METRICS TO REMOVE (only in {file1_name}):")
        print(f"   Count: {len(results['file1_unique'])}")
        for metric in results['file1_unique']:
            print(f"   - {metric}")
    
    # Metrics only in file 2 (missing from file 1)
    if results['file2_unique']:
        print(f"\n📝 METRICS MISSING FROM {file1_name}:")
        print(f"   Count: {len(results['file2_unique'])}")
        for metric in results['file2_unique']:
            print(f"   - {metric}")
    
    # Description improvements
    if results['improved_descriptions']:
        print(f"\n✨ POTENTIAL DESCRIPTION IMPROVEMENTS:")
        print(f"   Count: {len(results['improved_descriptions'])}")
        
        for item in results['improved_descriptions']:
            print(f"\n   📊 {item['name']}:")
            print(f"      Similarity: {item['similarity']:.2f}")
            
            if item['likely_improvement']:
                print(f"      🔍 LIKELY IMPROVEMENT (File 1 has longer description)")
            
            print(f"      File 1: {item['file1_desc'][:100]}{'...' if len(item['file1_desc']) > 100 else ''}")
            print(f"      File 2: {item['file2_desc'][:100]}{'...' if len(item['file2_desc']) > 100 else ''}")
    
    # Other property differences
    if results['different_properties']:
        print(f"\n🔧 OTHER PROPERTY DIFFERENCES:")
        print(f"   Count: {len(results['different_properties'])}")
        
        for item in results['different_properties']:
            print(f"\n   📊 {item['name']}:")
            for diff in item['differences']:
                print(f"      - {diff}")


def main():
    """Main function to run the comparison tool."""
    parser = argparse.ArgumentParser(description='Compare AsciiDoc metrics files')
    parser.add_argument('file1', help='First AsciiDoc file (formatted)')
    parser.add_argument('file2', help='Second AsciiDoc file (factual)')
    parser.add_argument('--output', '-o', help='Output file for results')
    parser.add_argument('--debug', action='store_true', help='Enable debug output')
    
    args = parser.parse_args()
    
    # Read files
    try:
        with open(args.file1, 'r', encoding='utf-8') as f:
            content1 = f.read()
        with open(args.file2, 'r', encoding='utf-8') as f:
            content2 = f.read()
    except FileNotFoundError as e:
        print(f"Error: File not found - {e}")
        return 1
    except Exception as e:
        print(f"Error reading files: {e}")
        return 1
    
    # Parse metrics
    parser = MetricsParser()
    print("Parsing first file...")
    metrics1 = parser.parse_file(content1)
    print("Parsing second file...")
    metrics2 = parser.parse_file(content2)
    
    if args.debug:
        print(f"Debug: Found {len(metrics1)} metrics in file1")
        print(f"Debug: Found {len(metrics2)} metrics in file2")
        if metrics1:
            print(f"Debug: Sample metrics from file1: {list(metrics1.keys())[:5]}")
        if metrics2:
            print(f"Debug: Sample metrics from file2: {list(metrics2.keys())[:5]}")
    
    # Compare metrics
    comparator = MetricsComparator()
    results = comparator.compare(metrics1, metrics2)
    
    # Print results
    print_comparison_results(results, args.file1, args.file2)
    
    # Save to file if requested
    if args.output:
        try:
            import sys
            from io import StringIO
            
            # Capture output
            old_stdout = sys.stdout
            sys.stdout = captured_output = StringIO()
            print_comparison_results(results, args.file1, args.file2)
            sys.stdout = old_stdout
            
            # Write to file
            with open(args.output, 'w', encoding='utf-8') as f:
                f.write(captured_output.getvalue())
            
            print(f"\nResults saved to: {args.output}")
        except Exception as e:
            print(f"Error saving output: {e}")
    
    return 0


if __name__ == '__main__':
    exit(main())