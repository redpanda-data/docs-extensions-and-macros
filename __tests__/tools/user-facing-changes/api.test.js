'use strict'

const { detect, kinds } = require('./helpers')
const { parseProto } = require('../../../tools/user-facing-changes/detectors/api')

const FILE = 'proto/redpanda/api/dataplane/v1/topic.proto'
const ADMIN = 'proto/redpanda/core/admin/v2/cluster.proto'

// Synthetic protos in the shapes the api surface routes. Nothing here is
// copied from a private repo.
const SOURCE = `syntax = "proto3";

package redpanda.api.dataplane.v1;

import "google/api/annotations.proto";

// A topic.
message Topic {
  // The topic name.
  string name = 1;
  int32 partition_count = 2;
  // Deprecated: use retention_ms.
  int64 retention_bytes = 3 [deprecated = true];
  map<string, string> configs = 4;
  message Config {
    string key = 1;
    string value = 2;
  }
  repeated Config config_list = 5;
}

enum CleanupPolicy {
  CLEANUP_POLICY_UNSPECIFIED = 0;
  CLEANUP_POLICY_DELETE = 1;
  CLEANUP_POLICY_COMPACT = 2;
}

message ListTopicsRequest {}
message ListTopicsResponse {
  repeated Topic topics = 1;
}
message CreateTopicRequest {
  Topic topic = 1;
}
message CreateTopicResponse {}

service TopicService {
  // ListTopics
  //
  // Lists topics.
  rpc ListTopics(ListTopicsRequest) returns (ListTopicsResponse) {
    option (google.api.http) = {
      get: "/v1/topics"
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "List topics"
      description: "Lists every topic in the cluster, with { braces } in prose."
    };
  }
  rpc CreateTopic(CreateTopicRequest) returns (CreateTopicResponse) {
    option (google.api.http) = {
      post: "/v1/topics"
      body: "topic"
    };
  }
}
`

const base = { [FILE]: SOURCE }
const edit = (from, to) => ({ [FILE]: SOURCE.replace(from, to) })

describe('parseProto', () => {
  test('reads rpcs, fields by number, nested messages and enum values', () => {
    const { rpcs, fields, enums, unresolved } = parseProto([{ startLine: 1, text: SOURCE }])
    expect(unresolved).toEqual([])
    expect([...rpcs.keys()]).toEqual(['TopicService.ListTopics', 'TopicService.CreateTopic'])
    expect(rpcs.get('TopicService.ListTopics')).toMatchObject({ summary: 'List topics', description: 'Lists every topic in the cluster, with { braces } in prose.', deprecated: false, line: 41 })
    expect([...fields.keys()]).toEqual([
      'Topic#1', 'Topic#2', 'Topic#3', 'Topic#4', 'Topic.Config#1', 'Topic.Config#2', 'Topic#5',
      'ListTopicsResponse#1', 'CreateTopicRequest#1'
    ])
    expect(fields.get('Topic#3')).toMatchObject({ name: 'retention_bytes', deprecated: true, type: 'int64' })
    expect(fields.get('Topic#4')).toMatchObject({ name: 'configs', type: 'map<string, string>' })
    expect(fields.get('Topic#5')).toMatchObject({ name: 'config_list', type: 'Config' })
    expect([...enums.keys()]).toEqual(['CleanupPolicy.CLEANUP_POLICY_UNSPECIFIED', 'CleanupPolicy.CLEANUP_POLICY_DELETE', 'CleanupPolicy.CLEANUP_POLICY_COMPACT'])
  })
})

describe('api detector', () => {
  test('a new field is added, a removed field is high', () => {
    const r = detect(base, edit('  repeated Config config_list = 5;', '  repeated Config config_list = 5;\n  // Replication factor.\n  int32 replication_factor = 6;'))
    expect(kinds(r)).toEqual([['added', 'Topic.replication_factor']])
    expect(r.findings[0]).toMatchObject({ surface: 'api', severity: 'medium', file: FILE, line: 21 })
    expect(r.findings[0].affected_pages).toEqual(['https://docs.redpanda.com/api/doc/cloud-dataplane/'])
    const r2 = detect(base, edit('  int32 partition_count = 2;\n', ''))
    expect(kinds(r2)).toEqual([['removed', 'Topic.partition_count']])
    expect(r2.findings[0].severity).toBe('high')
  })

  test('the same field number under a new name is a rename, with no addition or removal', () => {
    const r = detect(base, edit('int32 partition_count = 2;', 'int32 partitions = 2;'))
    expect(kinds(r)).toEqual([['renamed', 'Topic.partitions']])
    expect(r.findings[0].summary).toMatch(/renamed from `partition_count` to `partitions`/)
  })

  test('a field that gains [deprecated = true] is deprecated; a type change is behaviour', () => {
    const r = detect(base, edit('int32 partition_count = 2;', 'int32 partition_count = 2 [deprecated = true];'))
    expect(kinds(r)).toEqual([['deprecated', 'Topic.partition_count']])
    const r2 = detect(base, edit('int32 partition_count = 2;', 'int64 partition_count = 2;'))
    expect(kinds(r2)).toEqual([['behaviour', 'Topic.partition_count']])
    expect(r2.findings[0].detail).toBe('type-changed')
  })

  test('a new rpc is added, a removed rpc is high, option deprecated is a deprecation', () => {
    const r = detect(base, edit('  rpc CreateTopic(', '  rpc DeleteTopic(DeleteTopicRequest) returns (DeleteTopicResponse) {}\n  rpc CreateTopic('))
    expect(kinds(r)).toEqual([['added', 'TopicService.DeleteTopic']])
    const r2 = detect(base, edit(/  rpc CreateTopic\([\s\S]*?\n  }\n/, ''))
    expect(kinds(r2)).toEqual([['removed', 'TopicService.CreateTopic']])
    const r3 = detect(base, edit('      body: "topic"\n    };', '      body: "topic"\n    };\n    option deprecated = true;'))
    expect(kinds(r3)).toEqual([['deprecated', 'TopicService.CreateTopic']])
  })

  test('a changed openapiv2 summary is a low-severity behaviour finding', () => {
    const r = detect(base, edit('summary: "List topics"', 'summary: "List all topics"'))
    expect(kinds(r)).toEqual([['behaviour', 'TopicService.ListTopics']])
    expect(r.findings[0]).toMatchObject({ severity: 'low', detail: 'openapiv2-summary-changed' })
  })

  test('enum values added and removed', () => {
    const r = detect(base, edit('  CLEANUP_POLICY_COMPACT = 2;', '  CLEANUP_POLICY_COMPACT = 2;\n  CLEANUP_POLICY_COMPACT_DELETE = 3;'))
    expect(kinds(r)).toEqual([['added', 'CleanupPolicy.CLEANUP_POLICY_COMPACT_DELETE']])
    const r2 = detect(base, edit('  CLEANUP_POLICY_COMPACT = 2;\n', ''))
    expect(kinds(r2)).toEqual([['removed', 'CleanupPolicy.CLEANUP_POLICY_COMPACT']])
  })

  test('an Admin API v2 proto routes to the admin reference', () => {
    const src = 'syntax = "proto3";\npackage redpanda.core.admin.v2;\nservice ClusterService {\n  rpc GetHealth(GetHealthRequest) returns (GetHealthResponse) {}\n}\n'
    const r = detect({ [ADMIN]: src }, { [ADMIN]: src.replace('  rpc GetHealth(', '  rpc GetStatus(GetStatusRequest) returns (GetStatusResponse) {}\n  rpc GetHealth(') })
    expect(kinds(r)).toEqual([['added', 'ClusterService.GetStatus']])
    expect(r.findings[0].affected_pages).toEqual(['https://docs.redpanda.com/api/doc/admin/v2/'])
  })
})

describe('api detector: negative controls', () => {
  test('a comment change is the lint\'s and yields nothing', () => {
    expect(detect(base, edit('  // The topic name.', '  // The name of the topic.')).findings).toEqual([])
    expect(detect(base, edit('  // Lists topics.', '  // Lists the topics.')).findings).toEqual([])
  })

  test('http annotation and import changes yield nothing', () => {
    expect(detect(base, edit('get: "/v1/topics"', 'get: "/v1/topics/list"')).findings).toEqual([])
    expect(detect(base, edit('import "google/api/annotations.proto";', 'import "google/api/annotations.proto";\nimport "google/protobuf/timestamp.proto";')).findings).toEqual([])
  })

  test('reordering fields and messages yields nothing', () => {
    const r = detect(base, edit('  string name = 1;\n  int32 partition_count = 2;', '  int32 partition_count = 2;\n  string name = 1;'))
    expect(r.findings).toEqual([])
  })

  test('a proto outside the routed trees is ignored', () => {
    const P = 'proto/redpanda/core/internal/v1/x.proto'
    expect(detect({ [P]: SOURCE }, { [P]: SOURCE.replace('int32 partition_count = 2;', '') }).findings).toEqual([])
  })
})
