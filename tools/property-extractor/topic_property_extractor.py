#!/usr/bin/env python3
import os
import re
import json
import argparse
from pathlib import Path
import sys
from typing import Dict, List, Optional


class TopicPropertyExtractor:
    def __init__(self, source_path: str):
        self.source_path = Path(source_path)
        self.topic_properties = {}
        self.cluster_mappings = {}
        self.enum_values = {}
        self.noop_properties = set()
        
    def extract_topic_properties(self) -> Dict:
        """Extract topic property constants from source files"""
        
        # Step 1: Discover all topic property constants
        self._discover_topic_properties()
        
        # Step 2: Find enum definitions for acceptable values
        self._discover_enum_values()
        
        # Step 3: Discover no-op properties
        self._discover_noop_properties()
        
        # Step 4: Discover cluster property mappings from source code
        self._discover_cluster_mappings()
        
        # Step 5: Match properties with their validators and mappings
        self._correlate_properties_with_data()
        
        return {
            "topic_properties": self.topic_properties,
            "cluster_mappings": self.cluster_mappings,
            "enum_values": self.enum_values,
            "noop_properties": list(self.noop_properties)
        }
        
    def _discover_topic_properties(self):
        """Dynamically discover all topic property constants from source files"""
        
        # Priority files - parse these first with the most comprehensive patterns
        priority_files = [
            "src/v/kafka/server/handlers/topics/types.h",
            "src/v/kafka/protocol/topic_properties.h", 
            "src/v/cluster/topic_properties.h",
        ]
        
        for file_pattern in priority_files:
            file_path = self.source_path / file_pattern
            if file_path.exists():
                self._parse_topic_properties_from_file(file_path)
                
        # Comprehensive search - scan all header files that might contain properties
        search_patterns = [
            "src/**/*topic*.h",
            "src/**/*kafka*.h", 
            "src/**/*handler*.h",
            "src/**/*config*.h",
            "src/**/*property*.h",
        ]
        
        scanned_files = set()
        for pattern in search_patterns:
            for header_file in self.source_path.glob(pattern):
                if header_file not in scanned_files:
                    scanned_files.add(header_file)
                    self._scan_file_for_topic_properties(header_file)
                    
        # Also scan the specific types.h file that we know contains many properties
        types_files = list(self.source_path.glob("src/**/types.h"))
        for types_file in types_files:
            if types_file not in scanned_files:
                self._scan_file_for_topic_properties(types_file)
        
    def _parse_topic_properties_from_file(self, file_path: Path):
        """Parse topic property constants from a specific file"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                
            # Multiple patterns to catch all possible property definitions
            patterns = [
                # Pattern 1: inline constexpr std::string_view topic_property_xxx = "yyy";
                r'inline\s+constexpr\s+std::string_view\s+topic_property_(\w+)\s*=\s*"([^"]+)"\s*;',
                # Pattern 2: constexpr std::string_view topic_property_xxx = "yyy";
                r'constexpr\s+std::string_view\s+topic_property_(\w+)\s*=\s*"([^"]+)"\s*;',
                # Pattern 3: const std::string topic_property_xxx = "yyy";
                r'const\s+std::string\s+topic_property_(\w+)\s*=\s*"([^"]+)"\s*;',
                # Pattern 4: static const char* topic_property_xxx = "yyy";
                r'static\s+const\s+char\*\s+topic_property_(\w+)\s*=\s*"([^"]+)"\s*;',
            ]
            
            total_matches = 0
            for pattern in patterns:
                matches = re.findall(pattern, content)
                total_matches += len(matches)
                
                for var_name, property_name in matches:
                    # Only add if not already found (prefer inline constexpr definitions)
                    if property_name not in self.topic_properties:
                        self.topic_properties[property_name] = {
                            "variable_name": f"topic_property_{var_name}",
                            "property_name": property_name,
                            "defined_in": str(file_path.relative_to(self.source_path)),
                            "description": "",
                            "type": self._determine_property_type(property_name),
                            "acceptable_values": None,
                            "corresponding_cluster_property": None,
                            "is_noop": False  # Will be updated later in _correlate_properties_with_data
                        }
            print(f"Found {total_matches} topic properties in {file_path}")
        except Exception as e:
            print(f"Error reading {file_path}: {e}")
            
    def _scan_file_for_topic_properties(self, file_path: Path):
        """Scan any file for topic_property_ constants"""
        # Skip admin proxy files - they contain RPC service definitions, not topic properties
        if 'admin/proxy/' in str(file_path):
            return

        try:
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
                
            # Enhanced patterns to catch all property definitions
            patterns = [
                # Pattern 1: inline constexpr std::string_view topic_property_xxx = "yyy";
                r'inline\s+constexpr\s+std::string_view\s+topic_property_(\w+)\s*=\s*"([^"]+)"\s*;',
                # Pattern 2: constexpr std::string_view topic_property_xxx = "yyy";
                r'constexpr\s+std::string_view\s+topic_property_(\w+)\s*=\s*"([^"]+)"\s*;',
                # Pattern 3: topic_property_xxx = "yyy" (simple assignment)
                r'topic_property_(\w+)\s*=\s*"([^"]+)"',
                # Pattern 4: const std::string topic_property_xxx = "yyy";
                r'const\s+std::string\s+topic_property_(\w+)\s*=\s*"([^"]+)"\s*;',
                # Pattern 5: Look for string literals that look like topic properties
                r'"((?:redpanda\.|cleanup\.|compression\.|segment\.|flush\.|delete\.|replication\.|write\.|min\.|max\.|confluent\.)[^"]+)"'
            ]
            
            for pattern in patterns:
                matches = re.findall(pattern, content)
                
                for match in matches:
                    if len(match) == 2:
                        # Regular patterns with var_name and property_name
                        var_name, property_name = match
                    else:
                        # String literal pattern - generate var_name from property_name
                        property_name = match
                        var_name = re.sub(r'[^a-zA-Z0-9_]', '_', property_name)
                        var_name = re.sub(r'_+', '_', var_name).strip('_')
                    
                    # Validate this looks like a real topic property
                    if self._is_valid_topic_property(property_name) and property_name not in self.topic_properties:
                        self.topic_properties[property_name] = {
                            "variable_name": f"topic_property_{var_name}",
                            "property_name": property_name,
                            "defined_in": str(file_path.relative_to(self.source_path)),
                            "description": "",
                            "type": self._determine_property_type(property_name),
                            "acceptable_values": None,
                            "corresponding_cluster_property": None,
                            "is_noop": False  # Will be updated later in _correlate_properties_with_data
                        }
        except Exception as e:
            print(f"Debug: Skipping {file_path}: {e}", file=sys.stderr)
            
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
        
    def _discover_noop_properties(self):
        """Discover no-op properties from the allowlist_topic_noop_confs array"""
        
        # Look for the allowlist in types.h file
        types_file = self.source_path / "src/v/kafka/server/handlers/topics/types.h"
        if not types_file.exists():
            print("Warning: types.h file not found for no-op property detection")
            return
            
        try:
            with open(types_file, 'r', encoding='utf-8') as f:
                content = f.read()
                
            # Pattern to match the allowlist_topic_noop_confs array
            # Looks for the array declaration and captures all string literals within it
            pattern = r'allowlist_topic_noop_confs\s*=\s*\{([^}]+)\}'
            match = re.search(pattern, content, re.DOTALL)
            
            if match:
                array_content = match.group(1)
                # Extract all quoted strings from the array
                string_pattern = r'"([^"]+)"'
                noop_properties = re.findall(string_pattern, array_content)
                
                self.noop_properties = set(noop_properties)
                print(f"Found {len(self.noop_properties)} no-op properties")
            else:
                print("Warning: allowlist_topic_noop_confs array not found in types.h")
                
        except Exception as e:
            print(f"Error reading no-op properties from {types_file}: {e}")
        
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
                        "defined_in": str(file_path.relative_to(self.source_path)),
                        "values": values
                    }
                    
            # Pattern for regular enums too
            regular_enum_pattern = r'enum\s+(\w+)\s*{([^}]+)}'
            regular_matches = re.findall(regular_enum_pattern, content, re.DOTALL)
            
            for enum_name, enum_body in regular_matches:
                values = self._extract_enum_values(enum_body)
                if values:
                    self.enum_values[enum_name] = {
                        "defined_in": str(file_path.relative_to(self.source_path)),
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
                            "defined_in": str(file_path.relative_to(self.source_path)),
                            "values": values
                        }
        except Exception as e:
            print(f"Debug: Error scanning enums in {file_path}: {e}", file=sys.stderr)
            
    def _is_valid_topic_property(self, prop_name: str) -> bool:
        """Validate that a string looks like a real topic property"""

        # Must be non-empty and reasonable length
        if not prop_name or len(prop_name) < 3 or len(prop_name) > 100:
            return False

        # Must contain only valid characters for topic properties
        if not re.match(r'^[a-zA-Z][a-zA-Z0-9._-]*$', prop_name):
            return False

        # Reject Java-style package names (e.g., "redpanda.core.admin.Service")
        # Topic properties use lowercase with dots (e.g., "cleanup.policy", "segment.ms")
        # Split by dots and check each segment - reject if any segment after first has uppercase
        segments = prop_name.split('.')
        for i, segment in enumerate(segments):
            if i > 0 and segment and segment[0].isupper():
                return False
            
        # Known topic property prefixes/patterns
        valid_patterns = [
            r'^redpanda\.',
            r'^cleanup\.policy$',
            r'^compression\.type$',
            r'^segment\.',
            r'^flush\.',
            r'^delete\.',
            r'^replication\.factor$',
            r'^write\.caching$',
            r'^min\.',
            r'^max\.',
            r'^confluent\.',
            r'.*\.ms$',
            r'.*\.bytes$',
            r'.*\.ratio$',
        ]
        
        return any(re.match(pattern, prop_name, re.IGNORECASE) for pattern in valid_patterns)
            
    def _determine_property_type(self, property_name: str) -> str:
        """Determine the type of a property based on its name and usage patterns"""
        # Explicit exceptions / overrides for properties whose name contains
        # keywords that would otherwise map to boolean but which are actually
        # string-valued (for example, a bucket name).
        if property_name == "redpanda.remote.readreplica":
            # This topic property contains the read-replica bucket identifier
            # and should be treated as a string (not a boolean).
            return "string"
        # Explicit override: iceberg.delete is a boolean (whether to delete
        # the corresponding Iceberg table when the topic is deleted).
        if property_name == "redpanda.iceberg.delete":
            return "boolean"

        # Type mapping based on property name patterns (heuristic)
        if any(keyword in property_name for keyword in ["caching", "recovery", "read", "write", "delete"]):
            # Known boolean topic properties (keep list conservative)
            boolean_props = [
                "write.caching",
                "redpanda.remote.recovery",
                "redpanda.remote.write",
                "redpanda.remote.read",
                "redpanda.remote.delete",
            ]
            if property_name in boolean_props:
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
            print(f"Debug: Error finding mappings in {file_path}: {e}", file=sys.stderr)
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
                
            # Mark as no-op if found in the allowlist
            prop_data["is_noop"] = prop_name in self.noop_properties
                
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
            # Boolean properties don't need acceptable_values - it's redundant
            return ""

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
        
        # Add table rows ONLY for properties with cluster mappings and exclude no-ops
        for prop_name, prop_data in sorted(self.topic_properties.items()):
            cluster_prop = prop_data.get("corresponding_cluster_property")
            is_noop = prop_data.get("is_noop", False)
            if cluster_prop and not is_noop:  # Only include if there's a cluster mapping and not a no-op
                anchor = prop_name.replace(".", "").replace("-", "").lower()
                adoc_content += f"| <<{anchor},`{prop_name}`>>\n"
                adoc_content += f"| xref:./cluster-properties.adoc#{cluster_prop}[`{cluster_prop}`]\n\n"
                
        adoc_content += """|===

== Topic properties

"""

        # Add individual property documentation - ONLY include properties with cluster mappings and exclude no-ops
        for prop_name, prop_data in sorted(self.topic_properties.items()):
            cluster_prop = prop_data.get("corresponding_cluster_property")
            is_noop = prop_data.get("is_noop", False)
            
            # Skip properties without cluster mappings or no-op properties
            if not cluster_prop or is_noop:
                continue
                
            anchor = prop_name.replace(".", "").replace("-", "").lower()
            acceptable_values = prop_data.get("acceptable_values", "")
            prop_type = prop_data.get("type", "string")
            
            adoc_content += f"""
[[{anchor}]]
=== {prop_name}

*Type:* {prop_type}

"""
            # If the property type is boolean, never include an Accepted values section
            if acceptable_values and str(prop_type).lower() not in ("boolean", "bool"):
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
    
    # Calculate properties that will be included in documentation (non-no-op with cluster mappings)
    documented_props = [prop for prop, data in result['topic_properties'].items() 
                       if data.get('corresponding_cluster_property') and not data.get('is_noop', False)]
    
    print(f"Found {len(result['topic_properties'])} total properties ({len(documented_props)} documented, {len(result['noop_properties'])} no-op)")
    
    if args.output_json:
        with open(args.output_json, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2)
        print(f"Topic properties JSON saved to: {args.output_json}")
        
    if args.output_adoc:
        extractor.generate_topic_properties_adoc(args.output_adoc)


if __name__ == "__main__":
    main()
