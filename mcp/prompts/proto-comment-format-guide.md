---
description: Proto comment format standards for RPC method documentation. Use this guide when writing proto files or reviewing proto PRs. These comments generate OpenAPI documentation, so correct formatting is critical.
version: 1.0.0
---

# Proto Comment Format Guide

Proto RPC comments generate OpenAPI documentation. Following the correct format ensures API docs are properly structured and professional.

## ⚠️ Important: Format Varies by API

**Admin API (ConnectRPC)** - Strict three-line format required
**Control Plane API (gRPC)** - Flexible format, options take precedence

## Admin API Required Format (Redpanda Repo)

**Applies to:** `proto/redpanda/core/admin/v2/**/*.proto`

All RPC method comments **MUST** follow this three-line structure:

```protobuf
// RpcMethodName
//
// Description of what the method does.
rpc RpcMethodName(Request) returns (Response) {
```

### Three Required Components

1. **Line 1**: RPC method name only (e.g., `// GetCluster`)
2. **Line 2**: Blank comment line (`//`)
3. **Line 3+**: Clear description of what the method does

### Field/Parameter Descriptions

**Message fields use standard proto comment format** (no blank line required).

**When reviewing field documentation, consider suggesting descriptions for fields where:**
- The purpose isn't obvious from the field name alone
- The field has special behavior or implications
- The relationship to other fields needs clarification
- API users might have questions about usage

**If unsure whether a field needs public-facing documentation, consult with the engineer.**

```protobuf
// Example from actual broker.proto
message GetBrokerRequest {
  // The node ID for the broker. If set to -1, the broker handling the RPC
  // request returns information about itself.
  int32 node_id = 1;
}

message Broker {
  // This broker's node ID.
  int32 node_id = 1;

  // The build this broker is running.
  BuildInfo build_info = 2;

  // The admin server information.
  AdminServer admin_server = 3;
}
```

**Field comment guidelines (when documenting):**
- Use `//` comment directly above the field
- Describe what the field represents and its purpose
- Explain behavior or impact (when populated, what it affects)
- **Skip format/constraint details** - buf validation annotations handle this
- Use present tense and end with period

## Why This Format Matters

**RPC Method Comments → OpenAPI Operations:**
- Line 1 (method name) → `summary` field
- Line 3+ (description) → `description` field
- Line 2 (blank) → Separator between summary and description

**Field Comments → OpenAPI Schema Descriptions:**
- Field comments → `description` field in request/response schemas
- Help developers understand what each parameter/property does
- Appear in generated API documentation and SDK comments

**Incorrect format** = Malformed OpenAPI docs

## Examples

### ✅ Correct Format (Admin API)

**These examples show the strict three-line format required for Admin API (ConnectRPC):**

```protobuf
service ShadowLinkService {
    // CreateShadowLink
    //
    // Creates a new shadow link between clusters.
    rpc CreateShadowLink(CreateShadowLinkRequest)
        returns (CreateShadowLinkResponse) {
        option (pbgen.rpc) = {
            authz: SUPERUSER
        };
    }

    // GetShadowLink
    //
    // Gets information about a specific shadow link.
    rpc GetShadowLink(GetShadowLinkRequest) returns (GetShadowLinkResponse) {
        option (pbgen.rpc) = {
            authz: SUPERUSER
        };
    }

    // DeleteShadowLink
    //
    // Deletes an existing shadow link.
    rpc DeleteShadowLink(DeleteShadowLinkRequest)
        returns (DeleteShadowLinkResponse) {
        option (pbgen.rpc) = {
            authz: SUPERUSER
        };
    }
}

// Example request message with well-documented fields
message GetShadowLinkRequest {
  // The name of the shadow link to get.
  string name = 1 [
    (google.api.field_behavior) = REQUIRED,
    (google.api.resource_reference) = {
      type: "redpanda.core.admin.ShadowLinkService/ShadowLink"
    }
  ];
}

// Example resource message
message ShadowLink {
  // The name of the shadow link.
  string name = 1 [(google.api.field_behavior) = REQUIRED];

  // The UUID of the shadow link.
  string uid = 2 [
    (google.api.field_behavior) = OUTPUT_ONLY,
    (google.api.field_info).format = UUID4
  ];

  // Shadow link configuration.
  ShadowLinkConfigurations configurations = 3;

  // Status of the shadow link.
  ShadowLinkStatus status = 4 [(google.api.field_behavior) = OUTPUT_ONLY];
}
```

### ❌ Common Mistakes

**No blank line separator:**
```protobuf
// GetShadowLink
// Gets information about a specific shadow link.
rpc GetShadowLink(GetShadowLinkRequest) returns (GetShadowLinkResponse) {
```
Problem: Summary and description concatenated without separation.

**Description on first line:**
```protobuf
// GetShadowLink gets information about a specific shadow link.
rpc GetShadowLink(GetShadowLinkRequest) returns (GetShadowLinkResponse) {
```
Problem: Entire sentence goes into summary field, making it too verbose.

**Field documentation:**
```protobuf
// ❌ Too vague
message Request {
  // ID
  string id = 1;
}

// ✅ Clear and specific
message Request {
  // The unique identifier of the shadow link.
  string id = 1;
}
```
*Note: Describe purpose/behavior, not format constraints (buf validation handles that).*

## Writing Style Guidelines

Follow [Google Developer Documentation Style Guide](https://developers.google.com/style/api-reference-comments):

- ✅ Use sentence case and present tense ("Returns...", "Creates...")
- ✅ Be specific about what the method does (1-3 sentences)
- ✅ End with a period
- ❌ Don't include implementation details or use passive voice
- ❌ Don't be vague or overly verbose

**Example:**
```protobuf
// ✅ Good: Clear and concise
// Returns configuration and health information for a specific broker.

// ❌ Bad: Too much implementation detail
// This method retrieves broker data from the internal metadata cache
// and returns it to the caller after performing validation checks.
```

## Control Plane API Format (CloudV2 Repo)

**Applies to:** `proto/public/cloud/redpanda/api/controlplane/v1/**/*.proto`

Control Plane API uses **gRPC with protoc-gen-openapi** for OpenAPI generation. The format requirements are more flexible:

**Note:** Throughout this section, "options" refers to proto annotations (e.g., `openapiv2_operation`, `openapiv2_field`) that provide OpenAPI-specific metadata.

### General Review Guidelines

When reviewing Control Plane proto comments:

1. **Options take precedence** - If a service or RPC includes options that update OpenAPI summary/description, these override code comments
2. **Review comments when no options** - If no options are present, ensure code comments are clear and follow style guide
3. **Code comments format** - Use standard `//` comments above RPC definitions
4. **Context-appropriate descriptions** - Suggest comments based on context if missing
5. **Follow Google style** - All descriptions should follow [Google API Documentation Style Guide](https://developers.google.com/style/api-reference-comments)

### Example - Control Plane API (Flexible Format)

**RPC with options (from cloudv2 cluster.proto):**
```protobuf
service ClusterService {
  // CreateCluster create a Redpanda cluster. The input contains the spec, that describes the cluster.
  // A Operation is returned. This task allows the caller to find out when the long-running operation of creating a cluster has finished.
  rpc CreateCluster(CreateClusterRequest) returns (CreateClusterOperation) {
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Create cluster"
      description: "Create a Redpanda cluster. Returns a long-running operation..."
      // responses, examples, etc. can also be defined here
    };
  }
}
```

**Field-level options:**
```protobuf
message MTLSSpec {
  bool enabled = 1 [(grpc.gateway.protoc_gen_openapiv2.options.openapiv2_field) = {
    description: "Whether mTLS is enabled."
  }];
  repeated string ca_certificates_pem = 2 [(grpc.gateway.protoc_gen_openapiv2.options.openapiv2_field) = {
    description: "CA certificate in PEM format."
    example: "[\"-----BEGIN CERTIFICATE-----\\nMII........\\n-----END CERTIFICATE-----\"]"
  }];
}
```

**Key differences from Admin API:**
- ✅ Multi-line comments without blank line separator are acceptable
- ✅ Options can define summary/description (override comments)
- ✅ Options can include detailed response definitions and examples
- ✅ Field-level options can provide descriptions and examples
- ✅ Focus on clarity and completeness over strict format

### When Options are Present

If RPC includes OpenAPI options like `openapiv2_operation`, you can skip reviewing comments for that RPC - the options take precedence.

### When to Review

- ✅ Review new or modified services/RPCs
- ✅ Suggest comments if missing and no options present
- ✅ Ensure comments match current behavior if code changed
- ❌ Skip review if comprehensive options are present

## Validation and PR Workflow

### Using the MCP Tool

**Admin API (validate format):**
```javascript
compare_proto_descriptions({
  api_docs_spec: "admin/admin.yaml",
  source_branch: "your-pr-branch",
  validate_format: true  // Enforces strict three-line format
})
```

**Control Plane API (compare descriptions):**
```javascript
compare_proto_descriptions({
  api_docs_spec: "cloud-controlplane/cloud-controlplane.yaml",
  source_branch: "your-pr-branch",
  validate_format: false
})
```

### Before Submitting PR

⚠️ **Manual execution required** - AI agents provide analysis only; YOU must run all commands.

**Admin API (Redpanda):**
```bash
bazel run //tools:clang_format
tools/regenerate_ducktape_protos.sh
buf generate --path proto
# Self-review: Check three-line format (method name, blank, description)
# Optional: bump preview <path-to-admin-api-spec>
```

**Control Plane API (CloudV2):**
```bash
./taskw proto:format
./taskw proto:lint
./taskw proto:generate  # Re-run after rebase
# Self-review: Check RPCs have clear descriptions (comments or options)
# Optional: bump preview proto/gen/openapi/openapi.controlplane.prod.yaml
```

## PR Review Checklist

**Admin API** (`proto/redpanda/core/admin/v2/**/*.proto`):
- [ ] RPCs follow three-line format: name, blank line, description
- [ ] Descriptions: clear (1-3 sentences), present tense, end with period, no implementation details
- [ ] Fields: recommend docs where appropriate, verify clarity, explain purpose/behavior (not format)

**Control Plane API** (`proto/public/cloud/redpanda/api/controlplane/v1/**/*.proto`):
- [ ] RPCs have comments OR options with descriptions
- [ ] If options present, verify accuracy; if not, ensure comments are clear
- [ ] Field options: verify descriptions and examples are clear, accurate, helpful
- [ ] Follow Google style guide, present tense, period at end

## FAQ

- **Why is Admin API format strict?** ConnectRPC requires this for proper OpenAPI summary/description separation
- **Can descriptions be multi-line?** Yes for both APIs (Admin: keep blank line after name; Control Plane: flexible)
- **Comments vs. options?** In Control Plane API, options take precedence over comments

## Related Resources

- `compare_proto_descriptions` MCP tool - Automated format validation and comparison
- [API Description Backporting Guide](./backport-api-descriptions.md) - Workflow for backporting description improvements
- [Google API Documentation Style Guide](https://developers.google.com/style/api-reference-comments) - Writing style guidelines
- [Team Style Guide](../../team-standards/style-guide.md) - Redpanda documentation standards

---

**Remember**: Good proto comments = Good API documentation
