#!/usr/bin/env python3
import os
import re
import json
import argparse
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Set


class TopicPropertyExtractor:
    def __init__(self, source_path: str):
        self.source_path = Path(source_path)
        self.topic_properties = {}
        self.cluster_mappings = {}
        self.enum_values = {}
        
    def extract_topic_properties(self) -> Dict:
        """Extract topic property constants from source files"""
        
        # Step 1: Discover all topic property constants
        self._discover_topic_properties()
        
        # Step 2: Find enum definitions for acceptable values
        self._discover_enum_values()
        
        # Step 3: Discover cluster property mappings from source code
        self._discover_cluster_mappings()
        
        # Step 4: Match properties with their validators and mappings
        self._correlate_properties_with_data()
        
        return {
            "topic_properties": self.topic_properties,
            "cluster_mappings": self.cluster_mappings,
            "enum_values": self.enum_values
        }
        
    def _discover_topic_properties(self):
        """Dynamically discover all topic property constants from source files"""
        
        # Search for all header files that might contain topic property constants
        topic_property_files = [
            "src/v/kafka/server/handlers/topics/types.h",
            "src/v/kafka/protocol/topic_properties.h",
            "src/v/cluster/topic_properties.h",
        ]
        
        for file_pattern in topic_property_files:
            file_path = self.source_path / file_pattern
            if file_path.exists():
                self._parse_topic_properties_from_file(file_path)
                
        # Also search for any other files that might contain topic_property_ constants
        for header_file in self.source_path.glob("src/**/*.h"):
            if any(pattern in str(header_file) for pattern in ["topic", "kafka"]):
                self._scan_file_for_topic_properties(header_file)
                
        print(f"Discovered {len(self.topic_properties)} topic properties")
        
    def _parse_topic_properties_from_file(self, file_path: Path):
        """Parse topic property constants from a specific file"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                
            # Pattern to match: inline constexpr std::string_view topic_property_xxx = "yyy";
            pattern = r'inline\s+constexpr\s+std::string_view\s+topic_property_(\w+)\s*=\s*"([^"]+)";'
            matches = re.findall(pattern, content)
            
            for var_name, property_name in matches:
                self.topic_properties[property_name] = {
                    "variable_name": f"topic_property_{var_name}",
                    "property_name": property_name,
                    "source_file": str(file_path.relative_to(self.source_path)),
                    "description": "",
                    "type": self._determine_property_type(property_name),
                    "acceptable_values": None,
                    "corresponding_cluster_property": None
                }
                
            print(f"Found {len(matches)} topic properties in {file_path}")
        except Exception as e:
            print(f"Error reading {file_path}: {e}")
            
    def _scan_file_for_topic_properties(self, file_path: Path):
        """Scan any file for topic_property_ constants"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                
            # Look for any topic_property_ declarations
            pattern = r'topic_property_(\w+)\s*=\s*"([^"]+)"'
            matches = re.findall(pattern, content)
            
            for var_name, property_name in matches:
                if property_name not in self.topic_properties:
                    self.topic_properties[property_name] = {
                        "variable_name": f"topic_property_{var_name}",
                        "property_name": property_name,
                        "source_file": str(file_path.relative_to(self.source_path)),
                        "description": "",
                        "type": self._determine_property_type(property_name),
                        "acceptable_values": None,
                        "corresponding_cluster_property": None
                    }
        except Exception as e:
            # Skip files that can't be read
            pass
            
    def _discover_enum_values(self):
        """Discover enum definitions that correspond to topic property acceptable values"""
        
        # Key enum files for topic property validation
        enum_files = [
            "src/v/model/compression.h",
            "src/v/model/fundamental.h",
            "src/v/model/timestamp.h",
        ]
        
        for file_pattern in enum_files:
            file_path = self.source_path / file_pattern
            if file_path.exists():
                self._parse_enums_from_file(file_path)
                
        # Also search other model files for enums
        for header_file in self.source_path.glob("src/v/model/**/*.h"):
            self._scan_file_for_enums(header_file)
            
        print(f"Discovered {len(self.enum_values)} enum types")
        
    def _parse_enums_from_file(self, file_path: Path):
        """Parse enum definitions from a file"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                
            # Pattern for enum class definitions
            enum_pattern = r'enum\s+class\s+(\w+)\s*[^{]*{([^}]+)}'
            enum_matches = re.findall(enum_pattern, content, re.DOTALL)
            
            for enum_name, enum_body in enum_matches:
                values = self._extract_enum_values(enum_body)
                if values:
                    self.enum_values[enum_name] = {
                        "source_file": str(file_path.relative_to(self.source_path)),
                        "values": values
                    }
                    
            # Pattern for regular enums too
            regular_enum_pattern = r'enum\s+(\w+)\s*{([^}]+)}'
            regular_matches = re.findall(regular_enum_pattern, content, re.DOTALL)
            
            for enum_name, enum_body in regular_matches:
                values = self._extract_enum_values(enum_body)
                if values:
                    self.enum_values[enum_name] = {
                        "source_file": str(file_path.relative_to(self.source_path)),
                        "values": values
                    }
                    
        except Exception as e:
            print(f"Error parsing enums from {file_path}: {e}")
            
    def _scan_file_for_enums(self, file_path: Path):
        """Scan any file for enum definitions"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                
            # Look for enum class definitions
            enum_pattern = r'enum\s+class\s+(\w+)\s*[^{]*{([^}]+)}'
            matches = re.findall(enum_pattern, content, re.DOTALL)
            
            for enum_name, enum_body in matches:
                if enum_name not in self.enum_values:
                    values = self._extract_enum_values(enum_body)
                    if values:
                            self.enum_values[enum_name] = {
                                "source_file": str(file_path.relative_to(self.source_path)),
                                "values": values
                            }
        except Exception as e:
            # Skip files that can't be read
            pass
            
    def _determine_property_type(self, property_name: str) -> str:
        """Determine the type of a property based on its name and usage patterns"""
        
        # Type mapping based on property name patterns
        if any(keyword in property_name for keyword in ["caching", "recovery", "read", "write", "delete"]):
            if property_name in ["write.caching", "redpanda.remote.recovery", "redpanda.remote.write", 
                               "redpanda.remote.read", "redpanda.remote.delete", "redpanda.remote.readreplica"]:
                return "boolean"
                
        elif any(suffix in property_name for suffix in [".bytes", ".ms", ".factor", ".lag.ms"]):
            return "integer"
            
        elif "ratio" in property_name:
            return "number"  
            
        elif property_name in ["cleanup.policy", "compression.type", "message.timestamp.type"]:
            return "string"  # enum-based strings
            
        # Default to string for unknown properties
        return "string"
        
    def _extract_enum_values(self, enum_body: str) -> List[str]:
        """Extract enum value names from enum body"""
        values = []
        
        # Pattern to match enum value declarations (handle various formats)
        value_patterns = [
            r'(\w+)\s*=\s*[^,}]+',  # name = value
            r'(\w+)\s*,',           # name,
            r'(\w+)\s*}'            # name}
        ]
        
        for pattern in value_patterns:
            matches = re.findall(pattern, enum_body)
            for match in matches:
                if match and match not in values and not match.isdigit():
                    values.append(match)
                    
        return values
        
    def _discover_cluster_mappings(self):
        """Discover topic-to-cluster property mappings from source code"""
        
        # Search in configuration and handler files for mappings
        search_patterns = [
            "src/v/config/**/*.cc",
            "src/v/config/**/*.h", 
            "src/v/kafka/server/handlers/**/*.cc",
            "src/v/kafka/server/handlers/**/*.h",
            "src/v/cluster/**/*.cc",
            "src/v/cluster/**/*.h"
        ]
        
        mapping_candidates = {}
        
        for pattern in search_patterns:
            for file_path in self.source_path.glob(pattern):
                if file_path.is_file():
                    candidates = self._find_mappings_in_file(file_path)
                    mapping_candidates.update(candidates)
                    
        # Process mapping candidates to find correlations
        self._process_mapping_candidates(mapping_candidates)
        
        print(f"Discovered {len(self.cluster_mappings)} cluster property mappings")
        
    def _find_mappings_in_file(self, file_path: Path) -> Dict[str, str]:
        """Find potential topic-to-cluster property mappings in a file"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                
            mappings = {}
            
            # Pattern 1: Look for configuration property definitions with proper cluster prop names
            # Example: config.get("log_cleanup_policy") or similar patterns
            config_patterns = [
                r'config\.get\("([^"]+)"\)',  # config.get("property_name")
                r'\.([a-z_]+(?:_[a-z]+)*)\(',  # method calls like .retention_bytes(
                r'([a-z_]+(?:_[a-z]+)*)\s*=',  # assignments like retention_bytes = 
            ]
            
            for pattern in config_patterns:
                matches = re.findall(pattern, content)
                for match in matches:
                    # Only consider names that look like cluster properties
                    if self._looks_like_cluster_property(match):
                        # Try to correlate with topic properties
                        topic_prop = self._correlate_cluster_to_topic_property(match)
                        if topic_prop and topic_prop in self.topic_properties:
                            mappings[topic_prop] = match
                    
            return mappings
            
        except Exception as e:
            return {}
            
    def _looks_like_cluster_property(self, prop_name: str) -> bool:
        """Check if a name looks like a cluster property"""
        # Cluster properties typically have specific patterns
        cluster_patterns = [
            r'^[a-z]+(_[a-z]+)*$',  # snake_case like log_cleanup_policy
            r'.*_default$',         # ends with _default
            r'.*_(ms|bytes|ratio|type|policy)$',  # ends with common suffixes
        ]
        
        return any(re.match(pattern, prop_name) for pattern in cluster_patterns) and len(prop_name) > 4
        
    def _correlate_cluster_to_topic_property(self, cluster_prop: str) -> Optional[str]:
        """Try to correlate a cluster property name to a topic property"""
        
        # Known correlation patterns
        correlations = {
            "log_cleanup_policy": "cleanup.policy",
            "log_compression_type": "compression.type", 
            "log_retention_ms": "retention.ms",
            "retention_bytes": "retention.bytes",
            "log_segment_ms": "segment.ms",
            "log_segment_size": "segment.bytes",
            "log_message_timestamp_type": "message.timestamp.type",
            "kafka_batch_max_bytes": "max.message.bytes",
            "default_topic_replication": "replication.factor",
            "write_caching_default": "write.caching",
        }
        
        # Direct lookup first
        if cluster_prop in correlations:
            return correlations[cluster_prop]
            
        # Pattern-based correlation for properties we haven't hardcoded
        # Convert cluster property naming to topic property naming
        topic_candidates = []
        
        # Remove common prefixes/suffixes
        cleaned = cluster_prop
        if cleaned.startswith("log_"):
            cleaned = cleaned[4:]
        if cleaned.endswith("_default"):
            cleaned = cleaned[:-8]
        if cleaned.endswith("_ms"):
            cleaned = cleaned[:-3] + ".ms"
        if cleaned.endswith("_bytes"):
            cleaned = cleaned[:-6] + ".bytes"
        if cleaned.endswith("_policy"):
            cleaned = cleaned[:-7] + ".policy"
        if cleaned.endswith("_type"):
            cleaned = cleaned[:-5] + ".type"
            
        # Convert snake_case to dot.case
        topic_candidate = cleaned.replace("_", ".")
        
        if topic_candidate in self.topic_properties:
            return topic_candidate
            
        return None
            
    def _process_mapping_candidates(self, mapping_candidates: Dict[str, str]):
        """Process and validate mapping candidates"""
        for topic_prop, cluster_prop in mapping_candidates.items():
            if topic_prop in self.topic_properties:
                self.cluster_mappings[topic_prop] = cluster_prop
                
    def _resolve_topic_property_name(self, var_name: str) -> Optional[str]:
        """Resolve topic_property_xxx variable to actual property name"""
        for prop_name, prop_data in self.topic_properties.items():
            if prop_data["variable_name"] == f"topic_property_{var_name}":
                return prop_name
        return None
        
    def _correlate_properties_with_data(self):
        """Correlate topic properties with their acceptable values and cluster mappings"""
        
        for prop_name, prop_data in self.topic_properties.items():
            # Update cluster mapping if found
            if prop_name in self.cluster_mappings:
                prop_data["corresponding_cluster_property"] = self.cluster_mappings[prop_name]
                
            # Update acceptable values based on property type
            prop_data["acceptable_values"] = self._determine_acceptable_values(prop_name, prop_data)
            
    def _determine_acceptable_values(self, prop_name: str, prop_data: Dict) -> str:
        """Determine acceptable values for a property based on runtime analysis"""
        
        # Check if it's an enum-based property
        if "compression" in prop_name:
            if "compression" in self.enum_values:
                values = self.enum_values["compression"]["values"]
                # Filter out special values like 'count', 'producer'
                filtered_values = [v for v in values if v not in ['count', 'producer']]
                return f"[`{'`, `'.join(filtered_values)}`]"
                
        elif "cleanup.policy" in prop_name:
            if "cleanup_policy_bitflags" in self.enum_values:
                values = self.enum_values["cleanup_policy_bitflags"]["values"]
                # Convert enum names to policy names
                policy_values = []
                for v in values:
                    if v == "deletion":
                        policy_values.append("delete")
                    elif v == "compaction":
                        policy_values.append("compact")
                if policy_values:
                    policy_values.append("compact,delete")  # Combined policy
                    return f"[`{'`, `'.join(policy_values)}`]"
                    
        elif "timestamp.type" in prop_name:
            return "[`CreateTime`, `LogAppendTime`]"
            
        elif prop_data.get("type") == "boolean":
            return "[`true`, `false`]"
            
        # For numeric properties, determine format based on type and name
        elif prop_data.get("type") == "number" and "ratio" in prop_name:
            return "[`0`, `1.0`]"  
        elif prop_data.get("type") == "integer":
            if ".factor" in prop_name:
                return "integer (1 or greater)"
            elif ".bytes" in prop_name:
                return "bytes (integer)"
            elif ".ms" in prop_name:
                return "milliseconds (integer)"
            else:
                return "integer"
        
        return ""  # Default to empty if unknown

    def generate_topic_properties_adoc(self, output_path: str):
        """Generate topic-properties.adoc file"""
        
        adoc_content = """= Topic Configuration Properties
:page-aliases: reference:topic-properties.adoc
:description: Reference of topic configuration properties.

A topic-level property sets a Redpanda or Kafka configuration for a particular topic.

Many topic-level properties have corresponding xref:manage:cluster-maintenance/cluster-property-configuration.adoc[cluster properties] that set a default value for all topics of a cluster. To customize the value for a topic, you can set a topic-level property that overrides the value of the corresponding cluster property.

For information on how to configure topic properties, see xref:manage:cluster-maintenance/topic-property-configuration.adoc[].

NOTE: All topic properties take effect immediately after being set. 

== Topic property mappings

|===
| Topic property | Corresponding cluster property

"""
        
        # Add table rows ONLY for properties with cluster mappings
        for prop_name, prop_data in sorted(self.topic_properties.items()):
            cluster_prop = prop_data.get("corresponding_cluster_property")
            if cluster_prop:  # Only include if there's a cluster mapping
                anchor = prop_name.replace(".", "").replace("-", "").lower()
                adoc_content += f"| <<{anchor},`{prop_name}`>>\n"
                adoc_content += f"| xref:./cluster-properties.adoc#{cluster_prop}[`{cluster_prop}`]\n\n"
                
        adoc_content += """|===

== Topic properties

"""

        # Add individual property documentation - ONLY include properties with cluster mappings
        for prop_name, prop_data in sorted(self.topic_properties.items()):
            cluster_prop = prop_data.get("corresponding_cluster_property")
            
            # Skip properties without cluster mappings (as requested by user)
            if not cluster_prop:
                continue
                
            anchor = prop_name.replace(".", "").replace("-", "").lower()
            acceptable_values = prop_data.get("acceptable_values", "")
            prop_type = prop_data.get("type", "string")
            
            adoc_content += f"""
[[{anchor}]]
=== {prop_name}

*Type:* {prop_type}

"""
            if acceptable_values:
                adoc_content += f"*Accepted values:* {acceptable_values}\n\n"
            
            adoc_content += "*Default:* null\n\n"
            adoc_content += f"*Related cluster property:* xref:./cluster-properties.adoc#{cluster_prop}[`{cluster_prop}`]\n\n"
            adoc_content += "---\n\n"

        # Write the file
        output_dir = os.path.dirname(output_path)
        if output_dir:  # Only create directory if there's a path
            os.makedirs(output_dir, exist_ok=True)
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(adoc_content)
            
        print(f"Generated topic properties documentation: {output_path}")


def main():
    parser = argparse.ArgumentParser(description="Extract topic properties from Redpanda source code")
    parser.add_argument("--source-path", required=True, help="Path to Redpanda source code")
    parser.add_argument("--output-json", help="Output JSON file path")
    parser.add_argument("--output-adoc", help="Output AsciiDoc file path")
    
    args = parser.parse_args()
    
    extractor = TopicPropertyExtractor(args.source_path)
    result = extractor.extract_topic_properties()
    
    print(f"Total topic properties found: {len(result['topic_properties'])}")
    print(f"Topic properties with cluster mappings: {len(result['cluster_mappings'])}")
    print(f"Enum types discovered: {len(result['enum_values'])}")
    
    if args.output_json:
        with open(args.output_json, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2)
        print(f"Topic properties JSON saved to: {args.output_json}")
        
    if args.output_adoc:
        extractor.generate_topic_properties_adoc(args.output_adoc)


if __name__ == "__main__":
    main()
