const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

describe('topic_property_extractor.py', () => {
  const scriptPath = path.resolve(__dirname, '../../tools/property-extractor/topic_property_extractor.py');
  const mockSourcePath = path.resolve(__dirname, 'mock-redpanda-src');
  const outputJson = path.resolve(__dirname, 'topic-properties-output.json');
  const outputAdoc = path.resolve(__dirname, 'topic-properties.adoc');
  const clusterPropsJson = path.resolve(__dirname, 'mock-cluster-properties.json');

  beforeAll(() => {
    // Create a minimal mock Redpanda source tree
    if (!fs.existsSync(mockSourcePath)) {
      fs.mkdirSync(mockSourcePath, { recursive: true });
      // Create a mock header file with topic properties and no-op allowlist
      const headerDir = path.join(mockSourcePath, 'src/v/kafka/server/handlers/topics');
      fs.mkdirSync(headerDir, { recursive: true });
      fs.writeFileSync(
        path.join(headerDir, 'types.h'),
        `inline constexpr std::string_view topic_property_retention_ms = "retention.ms";
inline constexpr std::string_view topic_property_segment_bytes = "segment.bytes";
inline constexpr std::string_view topic_property_flush_messages = "flush.messages";
inline constexpr std::string_view topic_property_no_mapping = "redpanda.no.mapping";

// Mock allowlist for no-op properties
inline constexpr std::array<std::string_view, 3> allowlist_topic_noop_confs = {
  "flush.messages",
  "segment.index.bytes",
  "preallocate",
};
`
      );
      // Add a mock .cc file (should be ignored for property extraction)
      fs.writeFileSync(
        path.join(headerDir, 'types.cc'),
        `// Copyright 2025 Redpanda Data, Inc.\n#include "kafka/server/handlers/topics/types.h"\n// ...rest of the file...\n`
      );
      // Add a mock config_response_utils.cc file to simulate cluster property mappings
      const configDir = path.join(mockSourcePath, 'src/v/kafka/server/handlers/configs');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'config_response_utils.cc'),
        `// Mock config response utils
add_topic_config_if_requested(
    topic_property_retention_ms,
    config::shard_local_cfg().log_retention_ms.name(),
    config::shard_local_cfg().log_retention_ms.desc()
);

add_topic_config_if_requested(
    topic_property_segment_bytes,
    config::shard_local_cfg().log_segment_size.name(),
    config::shard_local_cfg().log_segment_size.desc()
);

add_topic_config_if_requested(
    topic_property_flush_messages,
    config::shard_local_cfg().flush_messages.name(),
    config::shard_local_cfg().flush_messages.desc()
);
`
      );

      // Create mock cluster properties JSON with default values
      const mockClusterProps = {
        properties: {
          log_retention_ms: {
            name: 'log_retention_ms',
            type: 'integer',
            default: 604800000,
            default_human_readable: '7 days',
            description: 'Retention time in milliseconds'
          },
          log_segment_size: {
            name: 'log_segment_size',
            type: 'integer',
            default: 1073741824,
            description: 'Segment size in bytes'
          },
          flush_messages: {
            name: 'flush_messages',
            type: 'integer',
            default: 100000,
            description: 'Number of messages before flush'
          }
        }
      };
      fs.writeFileSync(clusterPropsJson, JSON.stringify(mockClusterProps, null, 2));
    }
  });

  afterAll(() => {
    // Cleanup
    if (fs.existsSync(outputJson)) fs.unlinkSync(outputJson);
    if (fs.existsSync(outputAdoc)) fs.unlinkSync(outputAdoc);
    if (fs.existsSync(clusterPropsJson)) fs.unlinkSync(clusterPropsJson);
    fs.rmdirSync(mockSourcePath, { recursive: true });
  });

  it('extracts topic properties and generates JSON', () => {
    execSync(`python3 ${scriptPath} --source-path ${mockSourcePath} --output-json ${outputJson} --cluster-properties-json ${clusterPropsJson}`);
    const result = JSON.parse(fs.readFileSync(outputJson, 'utf8'));
    expect(result.topic_properties).toBeDefined();
    expect(result.topic_properties['retention.ms']).toBeDefined();
    expect(result.topic_properties['retention.ms'].property_name).toBe('retention.ms');
  });

  it('detects no-op properties correctly', () => {
    execSync(`python3 ${scriptPath} --source-path ${mockSourcePath} --output-json ${outputJson} --cluster-properties-json ${clusterPropsJson}`);
    const result = JSON.parse(fs.readFileSync(outputJson, 'utf8'));
    
    // Check that noop_properties array is present
    expect(result.noop_properties).toBeDefined();
    expect(Array.isArray(result.noop_properties)).toBe(true);
    expect(result.noop_properties).toContain('flush.messages');
    expect(result.noop_properties).toContain('segment.index.bytes');
    expect(result.noop_properties).toContain('preallocate');
    
    // Check that flush.messages is marked as no-op
    if (result.topic_properties['flush.messages']) {
      expect(result.topic_properties['flush.messages'].is_noop).toBe(true);
    }
    
    // Check that regular properties are not marked as no-op
    expect(result.topic_properties['retention.ms'].is_noop).toBe(false);
    expect(result.topic_properties['segment.bytes'].is_noop).toBe(false);
  });

  it('excludes no-op properties from AsciiDoc generation', () => {
    execSync(`python3 ${scriptPath} --source-path ${mockSourcePath} --output-adoc ${outputAdoc} --cluster-properties-json ${clusterPropsJson}`);
    const adoc = fs.readFileSync(outputAdoc, 'utf8');

    // Should contain regular properties in the documentation
    expect(adoc).toContain('= Topic Configuration Properties');
    expect(adoc).toContain('retention.ms');
    expect(adoc).toContain('segment.bytes');

    // Should NOT contain no-op properties in documentation
    expect(adoc).not.toContain('flush.messages');
    expect(adoc).not.toContain('segment.index.bytes');
    expect(adoc).not.toContain('preallocate');

    // Properties with cluster mappings should appear in the mappings table
    expect(adoc).toMatch(/Topic property mappings[\s\S]*retention\.ms[\s\S]*log_retention_ms/);
    expect(adoc).toMatch(/Topic property mappings[\s\S]*segment\.bytes[\s\S]*log_segment_size/);
  });

  it('documents properties without cluster mappings', () => {
    execSync(`python3 ${scriptPath} --source-path ${mockSourcePath} --output-adoc ${outputAdoc} --cluster-properties-json ${clusterPropsJson}`);
    const adoc = fs.readFileSync(outputAdoc, 'utf8');

    // Property without cluster mapping should appear in the main documentation
    expect(adoc).toContain('redpanda.no.mapping');

    // Extract the mappings table section (between "Topic property mappings" and "== Topic properties")
    const mappingsSection = adoc.match(/Topic property mappings[\s\S]*?(?===\s+Topic properties)/);

    // Property without mapping should NOT appear in the mappings table
    if (mappingsSection) {
      expect(mappingsSection[0]).not.toContain('redpanda.no.mapping');
    }

    // But it should appear in the Topic properties section
    const propertiesSection = adoc.match(/==\s+Topic properties[\s\S]*/);
    expect(propertiesSection[0]).toContain('redpanda.no.mapping');

    // And should not have a "Related cluster property" line
    const noMappingSection = adoc.match(/===\s+redpanda\.no\.mapping[\s\S]*?---/);
    expect(noMappingSection).toBeTruthy();
    expect(noMappingSection[0]).not.toContain('Related cluster property');
  });

  it('populates default values from cluster properties', () => {
    execSync(`python3 ${scriptPath} --source-path ${mockSourcePath} --output-json ${outputJson} --cluster-properties-json ${clusterPropsJson}`);
    const result = JSON.parse(fs.readFileSync(outputJson, 'utf8'));

    // Check that default values are populated from cluster properties
    expect(result.topic_properties['retention.ms'].default).toBe(604800000);
    expect(result.topic_properties['retention.ms'].default_human_readable).toBe('7 days');
    expect(result.topic_properties['segment.bytes'].default).toBe(1073741824);

    // Property without cluster mapping should not have a default
    expect(result.topic_properties['redpanda.no.mapping'].default).toBeNull();
  });

  it('populates default values in JSON for use by Handlebars templates', () => {
    // The Python script doesn't format defaults in AsciiDoc - that's handled by Handlebars
    // But it should populate the default field in the JSON output
    execSync(`python3 ${scriptPath} --source-path ${mockSourcePath} --output-json ${outputJson} --cluster-properties-json ${clusterPropsJson}`);
    const result = JSON.parse(fs.readFileSync(outputJson, 'utf8'));

    // Verify the JSON has raw default values that Handlebars will format
    expect(result.topic_properties['retention.ms'].default).toBe(604800000);
    expect(result.topic_properties['retention.ms'].default_human_readable).toBe('7 days');
    expect(result.topic_properties['segment.bytes'].default).toBe(1073741824);
  });
});
