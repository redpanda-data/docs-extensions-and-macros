/**
 * Unit tests for proto-analysis module
 * Tests proto file parsing, line number finding, PREVIEW detection, and format validation
 */

const { describe, test, expect } = require('@jest/globals');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  PROTO_FILE_MAPS,
  findRpcLineNumber,
  extractCurrentDescription,
  extractPreviewRpcs,
  findPreviewServices,
  filterPreviewChanges,
  checkRpcCommentFormat,
  findProtoFileForService,
  autoDiscoverProtoFile,
  findProtoFilesRecursive
} = require('../../bin/mcp-tools/proto-analysis');

describe('Proto Analysis Module', () => {
  // Test fixtures
  const testProtoDir = path.join(os.tmpdir(), 'proto-analysis-test-' + Date.now());

  beforeAll(() => {
    // Create test directory structure
    fs.mkdirSync(testProtoDir, { recursive: true });
    fs.mkdirSync(path.join(testProtoDir, 'proto'), { recursive: true });
  });

  afterAll(() => {
    // Cleanup
    fs.rmSync(testProtoDir, { recursive: true, force: true });
  });

  describe('PROTO_FILE_MAPS', () => {
    test('contains admin API mappings', () => {
      expect(PROTO_FILE_MAPS.admin).toBeDefined();
      expect(PROTO_FILE_MAPS.admin.repo).toBe('redpanda');
      expect(PROTO_FILE_MAPS.admin.services).toBeDefined();
      expect(PROTO_FILE_MAPS.admin.services.BrokerService).toContain('broker.proto');
    });

    test('contains controlplane API mappings', () => {
      expect(PROTO_FILE_MAPS.controlplane).toBeDefined();
      expect(PROTO_FILE_MAPS.controlplane.repo).toBe('cloudv2');
      expect(PROTO_FILE_MAPS.controlplane.services).toBeDefined();
      expect(PROTO_FILE_MAPS.controlplane.services.ClusterService).toContain('cluster.proto');
    });

    test('does not contain connect API mappings', () => {
      expect(PROTO_FILE_MAPS.connect).toBeUndefined();
    });
  });

  describe('findRpcLineNumber', () => {
    test('finds RPC with three-line comment format', () => {
      const testFile = path.join(testProtoDir, 'test-admin.proto');
      const protoContent = `syntax = "proto3";

// GetBroker
//
// Retrieves information about a specific broker.
rpc GetBroker(GetBrokerRequest) returns (GetBrokerResponse) {}
`;
      fs.writeFileSync(testFile, protoContent);

      const result = findRpcLineNumber(testFile, 'GetBroker');

      expect(result.found).toBe(true);
      expect(result.rpcLineNumber).toBe(6);
      expect(result.rpcDefinition).toContain('GetBroker');
    });

    test('finds RPC with openapiv2_operation annotation', () => {
      const testFile = path.join(testProtoDir, 'test-controlplane.proto');
      const protoContent = `syntax = "proto3";

rpc CreateCluster(CreateClusterRequest) returns (CreateClusterResponse) {
  option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
    summary: "Create cluster"
    description: "Creates a new Redpanda cluster."
  };
}
`;
      fs.writeFileSync(testFile, protoContent);

      const result = findRpcLineNumber(testFile, 'CreateCluster');

      expect(result.found).toBe(true);
      expect(result.rpcLineNumber).toBe(3);
      // Line 3 is the rpc line, descriptionLineNumber will be same when no openapiv2 above it
      expect(result.descriptionLineNumber).toBe(3);
      expect(result.rpcDefinition).toContain('openapiv2_operation');
    });

    test('returns error when RPC not found', () => {
      const testFile = path.join(testProtoDir, 'empty.proto');
      fs.writeFileSync(testFile, 'syntax = "proto3";');

      const result = findRpcLineNumber(testFile, 'NonExistent');

      expect(result.found).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('handles file read errors gracefully', () => {
      const result = findRpcLineNumber('/nonexistent/file.proto', 'Test');

      expect(result.found).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('extractCurrentDescription', () => {
    test('extracts description from openapiv2_operation', () => {
      const rpcDef = `rpc Test(Req) returns (Res) {
  option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
    description: "This is a test description."
  };
}`;

      const result = extractCurrentDescription(rpcDef);

      expect(result).toBe('This is a test description.');
    });

    test('extracts description from three-line comment format', () => {
      const rpcDef = `// GetBroker
//
// Retrieves broker information.
// Additional details here.
rpc GetBroker(Req) returns (Res) {}`;

      const result = extractCurrentDescription(rpcDef);

      expect(result).toBe('Retrieves broker information. Additional details here.');
    });

    test('multi-line descriptions are normalized to single-line', () => {
      const multiLineRpc = `// ListKafkaConnections
//
// Returns information about the cluster's Kafka connections, collected
// and ordered across all brokers.
rpc ListKafkaConnections(Req) returns (Res) {}`;

      const result = extractCurrentDescription(multiLineRpc);

      // Verify line breaks are replaced with spaces
      expect(result).toBe('Returns information about the cluster\'s Kafka connections, collected and ordered across all brokers.');
      expect(result).not.toContain('\n');
    });

    test('returns null when no description found', () => {
      const rpcDef = `rpc Test(Req) returns (Res) {}`;

      const result = extractCurrentDescription(rpcDef);

      expect(result).toBeNull();
    });
  });

  describe('extractPreviewRpcs', () => {
    test('finds PREVIEW RPCs in proto content', () => {
      const protoContent = `service TestService {
  rpc NormalRpc(Req) returns (Res) {}

  rpc PreviewRpc(Req) returns (Res) {
    option (google.api.method_visibility).restriction = "PREVIEW";
  }

  rpc AnotherPreview(Req) returns (Res) {
    option (google.api.method_visibility).restriction = "PREVIEW";
  }
}`;

      const result = extractPreviewRpcs(protoContent);

      expect(result).toHaveLength(2);
      expect(result).toContain('TestService_PreviewRpc');
      expect(result).toContain('TestService_AnotherPreview');
    });

    test('returns empty array when no service found', () => {
      const result = extractPreviewRpcs('syntax = "proto3";');

      expect(result).toEqual([]);
    });

    test('returns empty array when no PREVIEW RPCs', () => {
      const protoContent = `service TestService {
  rpc NormalRpc(Req) returns (Res) {}
}`;

      const result = extractPreviewRpcs(protoContent);

      expect(result).toEqual([]);
    });
  });

  describe('filterPreviewChanges', () => {
    test('filters out PREVIEW operations', () => {
      const differences = [
        { operationId: 'TestService_NormalRpc' },
        { operationId: 'TestService_PreviewRpc' },
        { operationId: 'redpanda.core.admin.v2.BrokerService.GetBroker' },
        { operationId: 'redpanda.core.admin.v2.TestService.PreviewOp' }
      ];

      const previewItems = new Set(['TestService_PreviewRpc', 'TestService_PreviewOp']);

      const result = filterPreviewChanges(differences, previewItems);

      expect(result.filtered).toHaveLength(2);
      expect(result.skipped).toHaveLength(2);
      expect(result.filtered[0].operationId).toBe('TestService_NormalRpc');
      expect(result.skipped[0].operationId).toBe('TestService_PreviewRpc');
    });

    test('handles dot-notation operationIds', () => {
      const differences = [
        { operationId: 'redpanda.core.admin.v2.BrokerService.GetBroker' }
      ];

      const previewItems = new Set(['BrokerService_GetBroker']);

      const result = filterPreviewChanges(differences, previewItems);

      expect(result.filtered).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
    });
  });

  describe('checkRpcCommentFormat', () => {
    test('validates correct three-line format', () => {
      const protoContent = `// GetBroker
//
// Retrieves broker information.
rpc GetBroker(Req) returns (Res) {}`;

      const result = checkRpcCommentFormat(protoContent, 'GetBroker');

      expect(result.valid).toBe(true);
    });

    test('detects missing RPC name on first line', () => {
      const protoContent = `// Retrieves broker information
//
// More details here.
rpc GetBroker(Req) returns (Res) {}`;

      const result = checkRpcCommentFormat(protoContent, 'GetBroker');

      expect(result.valid).toBe(false);
      expect(result.issue).toContain('First line should be');
    });

    test('detects missing blank comment line', () => {
      const protoContent = `// GetBroker
// Retrieves broker information.
rpc GetBroker(Req) returns (Res) {}`;

      const result = checkRpcCommentFormat(protoContent, 'GetBroker');

      expect(result.valid).toBe(false);
      // Could be either "too short" or "Second line should be blank" depending on parsing
      expect(result.issue.toLowerCase()).toContain('blank');
    });

    test('detects comment too short', () => {
      const protoContent = `// GetBroker
rpc GetBroker(Req) returns (Res) {}`;

      const result = checkRpcCommentFormat(protoContent, 'GetBroker');

      expect(result.valid).toBe(false);
      expect(result.issue).toContain('too short');
    });

    test('returns error when RPC not found', () => {
      const protoContent = `syntax = "proto3";`;

      const result = checkRpcCommentFormat(protoContent, 'NonExistent');

      expect(result.valid).toBe(false);
      expect(result.issue).toContain('not found');
    });
  });

  describe('findProtoFileForService', () => {
    test('constructs path for known services', () => {
      // Mock repo path (doesn't need to exist for hard-coded mapping)
      const mockRepo = '/mock/redpanda';

      const result = findProtoFileForService(mockRepo, 'admin', 'BrokerService');

      // Should construct path even if it doesn't exist (returns null when file not found)
      // Function tries to find file, returns null if not exists
      expect(result).toBeNull(); // File doesn't exist in mock path
    });

    test('returns null for unknown API surface', () => {
      const result = findProtoFileForService('/mock/repo', 'unknown', 'TestService');

      expect(result).toBeNull();
    });

    test('returns null for unknown service', () => {
      const result = findProtoFileForService('/mock/repo', 'admin', 'UnknownService');

      expect(result).toBeNull();
    });
  });

  describe('findProtoFilesRecursive', () => {
    beforeEach(() => {
      // Create test directory structure
      const protoDir = path.join(testProtoDir, 'proto');
      fs.mkdirSync(path.join(protoDir, 'subdir'), { recursive: true });
      fs.mkdirSync(path.join(protoDir, 'node_modules'), { recursive: true });

      fs.writeFileSync(path.join(protoDir, 'service.proto'), 'content');
      fs.writeFileSync(path.join(protoDir, 'subdir', 'nested.proto'), 'content');
      fs.writeFileSync(path.join(protoDir, 'common.proto'), 'content');
      fs.writeFileSync(path.join(protoDir, 'node_modules', 'ignored.proto'), 'content');
    });

    test('recursively finds all .proto files', () => {
      const protoDir = path.join(testProtoDir, 'proto');
      const result = findProtoFilesRecursive(protoDir);

      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result.some(f => f.includes('service.proto'))).toBe(true);
      expect(result.some(f => f.includes('nested.proto'))).toBe(true);
    });

    test('skips common.proto files', () => {
      const protoDir = path.join(testProtoDir, 'proto');
      const result = findProtoFilesRecursive(protoDir);

      expect(result.some(f => f.includes('common.proto'))).toBe(false);
    });

    test('skips node_modules directories', () => {
      const protoDir = path.join(testProtoDir, 'proto');
      const result = findProtoFilesRecursive(protoDir);

      expect(result.some(f => f.includes('node_modules'))).toBe(false);
    });

    test('handles non-existent directories gracefully', () => {
      const result = findProtoFilesRecursive('/nonexistent');

      expect(result).toEqual([]);
    });
  });

  describe('Integration: Full proto analysis workflow', () => {
    test('can parse, validate, and extract from real proto structure', () => {
      // Create a realistic proto file
      const testFile = path.join(testProtoDir, 'realistic.proto');
      const protoContent = `syntax = "proto3";

package redpanda.api.test.v1;

service TestService {
  // GetResource
  //
  // Retrieves a resource by ID.
  rpc GetResource(GetResourceRequest) returns (GetResourceResponse) {}

  rpc CreateResource(CreateResourceRequest) returns (CreateResourceResponse) {
    option (google.api.method_visibility).restriction = "PREVIEW";
  }
}

message GetResourceRequest {
  string id = 1;
}

message GetResourceResponse {
  string name = 1;
}
`;
      fs.writeFileSync(testFile, protoContent);

      // Test the full workflow
      const lineInfo = findRpcLineNumber(testFile, 'GetResource');
      expect(lineInfo.found).toBe(true);
      expect(lineInfo.rpcDefinition).toBeDefined();
      expect(lineInfo.rpcLineNumber).toBe(9);

      // Format validation should pass
      const formatCheck = checkRpcCommentFormat(protoContent, 'GetResource');
      expect(formatCheck.valid).toBe(true);

      // PREVIEW detection should work
      const previewRpcs = extractPreviewRpcs(protoContent);
      expect(previewRpcs).toContain('TestService_CreateResource');
      expect(previewRpcs).not.toContain('TestService_GetResource');
    });
  });
});
