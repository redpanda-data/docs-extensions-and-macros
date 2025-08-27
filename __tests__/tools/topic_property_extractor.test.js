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
      // Create a mock header file with a topic property
      const headerDir = path.join(mockSourcePath, 'src/v/kafka/server/handlers/topics');
      fs.mkdirSync(headerDir, { recursive: true });
      fs.writeFileSync(
        path.join(headerDir, 'types.h'),
        'inline constexpr std::string_view topic_property_retention_ms = "retention.ms";\n'
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
        'config.get("log_retention_ms");\n'
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

  it('generates AsciiDoc output', () => {
    execSync(`python3 ${scriptPath} --source-path ${mockSourcePath} --output-adoc ${outputAdoc}`);
    const adoc = fs.readFileSync(outputAdoc, 'utf8');
    expect(adoc).toContain('= Topic Configuration Properties');
    expect(adoc).toContain('retention.ms');
  });
});
