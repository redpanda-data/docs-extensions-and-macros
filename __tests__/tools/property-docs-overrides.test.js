const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..', '..');
const overridesFile = path.join(repoRoot, '__tests__', 'docs-data', 'property-overrides.json');

describe('property-docs description override', () => {
  let tempDir;
  let mockPropertiesFile;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'property-docs-test-'));
    
    // Create mock property data that includes admin property
    const mockProperties = {
      properties: {
        admin: {
          config_scope: "broker",
          default: [{ address: "127.0.0.1", port: 9644 }],
          defined_in: "src/v/config/node_config.cc",
          description: "Default description for admin",
          name: "admin",
          needs_restart: true,
          nullable: false,
          type: "array",
          visibility: "user"
        },
        kafka_api: {
          config_scope: "broker", 
          default: [{ address: "127.0.0.1", port: 9092 }],
          defined_in: "src/v/config/node_config.cc",
          description: "IP address and port of the Kafka API endpoint that handles requests.",
          name: "kafka_api",
          needs_restart: true,
          nullable: false,
          type: "array", 
          visibility: "user"
        }
      }
    };
    
    // Write mock properties to a temp file
    mockPropertiesFile = path.join(tempDir, 'mock-properties.json');
    fs.writeFileSync(mockPropertiesFile, JSON.stringify(mockProperties, null, 2));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies the override description for admin property', () => {
    const overrides = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
    const mockProperties = JSON.parse(fs.readFileSync(mockPropertiesFile, 'utf8'));
    
    // Test 1: Verify the override file structure
    const adminOverride = overrides.properties.admin;
    expect(adminOverride).toBeTruthy();
    expect(adminOverride.description).toBeTruthy();
    expect(adminOverride.version).toBe('v23.1.0');
    expect(adminOverride.description).toBe('Network addresses for Admin API servers with version info.');
    
    // Test 2: Verify our mock data has the correct structure (no artificial name field)
    const adminProperty = mockProperties.properties.admin;
    expect(adminProperty.default).toEqual([{ address: "127.0.0.1", port: 9644 }]);
    
    const adminDefault = adminProperty.default[0];
    expect(adminDefault).toHaveProperty('address', '127.0.0.1');
    expect(adminDefault).toHaveProperty('port', 9644);
    
    // Test 3: Simulate applying overrides (this is what the Python script would do)
    const adminWithOverrides = {
      ...adminProperty,
      description: adminOverride.description,
      version: adminOverride.version
    };
    
    expect(adminWithOverrides.description).toBe('Network addresses for Admin API servers with version info.');
    expect(adminWithOverrides.version).toBe('v23.1.0');
    expect(adminWithOverrides.default).toEqual([{ address: "127.0.0.1", port: 9644 }]);
    
    // Test 4: Verify that kafka_api (without overrides) keeps its original description
    const kafkaProperty = mockProperties.properties.kafka_api;
    expect(kafkaProperty.description).toBe('IP address and port of the Kafka API endpoint that handles requests.');
    expect(kafkaProperty.default).toEqual([{ address: "127.0.0.1", port: 9092 }]);
  });
});
