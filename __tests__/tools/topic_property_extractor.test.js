const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

describe('topic_property_extractor.py', () => {
  const scriptPath = path.resolve(__dirname, '../../tools/property-extractor/topic_property_extractor.py');
  const mockSourcePath = path.resolve(__dirname, 'mock-redpanda-src');
  const outputJson = path.resolve(__dirname, 'topic-properties-output.json');
  const outputAdoc = path.resolve(__dirname, 'topic-properties.adoc');

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
      // Add a mock config file to simulate a cluster property mapping
      const configDir = path.join(mockSourcePath, 'src/v/config');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'mock_config.cc'),
        'config.get("log_retention_ms");\nconfig.get("log_segment_size");\n'
      );
    }
  });

  afterAll(() => {
    // Cleanup
    if (fs.existsSync(outputJson)) fs.unlinkSync(outputJson);
    if (fs.existsSync(outputAdoc)) fs.unlinkSync(outputAdoc);
    fs.rmdirSync(mockSourcePath, { recursive: true });
  });

  it('extracts topic properties and generates JSON', () => {
    execSync(`python3 ${scriptPath} --source-path ${mockSourcePath} --output-json ${outputJson}`);
    const result = JSON.parse(fs.readFileSync(outputJson, 'utf8'));
    expect(result.topic_properties).toBeDefined();
    expect(result.topic_properties['retention.ms']).toBeDefined();
    expect(result.topic_properties['retention.ms'].property_name).toBe('retention.ms');
  });

  it('detects no-op properties correctly', () => {
    execSync(`python3 ${scriptPath} --source-path ${mockSourcePath} --output-json ${outputJson}`);
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
    execSync(`python3 ${scriptPath} --source-path ${mockSourcePath} --output-adoc ${outputAdoc}`);
    const adoc = fs.readFileSync(outputAdoc, 'utf8');
    
    // Should contain regular properties
    expect(adoc).toContain('= Topic Configuration Properties');
    expect(adoc).toContain('retention.ms');
    expect(adoc).toContain('segment.bytes');
    
    // Should NOT contain no-op properties in documentation
    expect(adoc).not.toContain('flush.messages');
    expect(adoc).not.toContain('segment.index.bytes');
    expect(adoc).not.toContain('preallocate');
  });
});
