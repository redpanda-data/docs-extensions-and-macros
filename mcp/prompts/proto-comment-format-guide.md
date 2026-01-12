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

**Incorrect format** = Malformed OpenAPI docs = Confused developers using the API

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

**Example from actual cloudv2 cluster.proto:**

```protobuf
service ClusterService {
  // CreateCluster create a Redpanda cluster. The input contains the spec, that describes the cluster.
  // A Operation is returned. This task allows the caller to find out when the long-running operation of creating a cluster has finished.
  rpc CreateCluster(CreateClusterRequest) returns (CreateClusterOperation) {
    option (google.api.http) = {
      post: "/v1/clusters"
      body: "*"
    };
    option (grpc.gateway.protoc_gen_openapiv2.options.openapiv2_operation) = {
      summary: "Create cluster"
      description: "Create a Redpanda cluster. Returns a long-running operation. For more information, see [Use the Control Plane API](https://docs.redpanda.com/redpanda-cloud/manage/api/controlplane/). To check operation state, call `GET /v1/operations/{id}`. Refer to [Regions](https://docs.redpanda.com/api/doc/cloud-controlplane/topic/topic-regions-and-usage-tiers) for the list of available regions, zones, and tiers combinations for each cloud provider. For BYOC clusters, follow additional steps to [create a BYOC cluster](https://docs.redpanda.com/redpanda-cloud/manage/api/cloud-byoc-controlplane-api/#additional-steps-to-create-a-byoc-cluster)."
      responses: {
        key: "202"
        value: {
          description: "Accepted"
          schema: {
            json_schema: {ref: ".redpanda.api.controlplane.v1.CreateClusterOperation"}
          }
        }
      }
      responses: {
        key: "400"
        value: {
          description: "Bad Request"
          schema: {
            json_schema: {ref: ".google.rpc.Status"}
          }
        }
      }
      responses: {
        key: "409"
        value: {
          description: "Conflict"
          schema: {
            json_schema: {ref: ".google.rpc.Status"}
          }
        }
      }
      responses: {
        key: "500"
        value: {
          description: "Internal Server Error. Please reach out to support."
          schema: {
            json_schema: {ref: ".google.rpc.Status"}
          }
        }
      }
    };
  }
}
```

**Field-level option examples from actual cloudv2 cluster.proto:**

```protobuf
// mTLS configuration.
message MTLSSpec {
  bool enabled = 1 [(grpc.gateway.protoc_gen_openapiv2.options.openapiv2_field) = {description: "Whether mTLS is enabled."}];
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

## How to Validate Your Protos

**Note:** The steps below apply to Admin API (Redpanda repo). For Control Plane API validation steps, see the "As a PR Author" section.

### Admin API - Before Committing

1. **Visual check**: Look at each RPC comment
   - Is the method name on line 1?
   - Is line 2 blank?
   - Does the description start on line 3?

2. **Format code**: Run the formatter
   ```bash
   # Redpanda repo
   bazel run //tools:clang_format
   ```

3. **Generate OpenAPI**: Check the output
   ```bash
   # From api-docs repo
   npx doc-tools generate bundle-openapi --branch your-branch
   ```

4. **Review OpenAPI spec**: Check that summary/description fields look correct
   ```bash
   grep -A 5 "operationId.*YourMethod" admin/admin.yaml
   ```

### Admin API - During PR Review

Use the `compare_proto_descriptions` MCP tool to validate:
```javascript
compare_proto_descriptions({
  api_docs_spec: "admin/admin.yaml",
  source_branch: "your-pr-branch",
  validate_format: true  // Enforces strict three-line format
})
```

This will report any format violations.

### Control Plane API - During PR Review

Use the `compare_proto_descriptions` MCP tool to compare descriptions:
```javascript
compare_proto_descriptions({
  api_docs_spec: "cloud-controlplane/cloud-controlplane.yaml",
  source_branch: "your-pr-branch",
  validate_format: false  // No strict format enforcement for Control Plane
})
```

This will identify description discrepancies between api-docs and proto-generated specs.

## PR Review Checklist

### Admin API (ConnectRPC - Strict Format)

When reviewing `proto/redpanda/core/admin/v2/**/*.proto`:

**RPC Methods:**
- [ ] Each RPC has a comment
- [ ] First line is method name only (no description)
- [ ] Second line is blank (`//`)
- [ ] Description starts on third line
- [ ] Description is clear and concise (1-3 sentences)
- [ ] Description uses present tense
- [ ] Description ends with a period
- [ ] No implementation details in description

**Message Fields:**
- [ ] Identify fields missing documentation and recommend additions where appropriate
- [ ] For documented fields, verify descriptions are clear and specific
- [ ] Check that behavior and purpose are explained, not just format/constraints
- [ ] Confirm documented fields use present tense and end with period

### Control Plane API (gRPC - Flexible Format)

When reviewing `proto/public/cloud/redpanda/api/controlplane/v1/**/*.proto`:

**RPC Methods:**
- [ ] Each RPC has comments OR options with OpenAPI descriptions
- [ ] If options present, verify summary/description are accurate
- [ ] If no options, ensure comments are clear and complete
- [ ] Comments follow Google style guide
- [ ] Descriptions use present tense and end with period
- [ ] Only review lines that were added/modified (or all if HEAD unchanged)
- [ ] Suggest comments for new RPCs without descriptions

**Message Fields:**
- [ ] Review openapiv2_field options - these generate schema descriptions in OpenAPI spec
- [ ] Verify field option descriptions are clear, accurate, and complete
- [ ] Check that examples in field options are realistic and helpful
- [ ] Identify fields missing options/documentation and recommend additions where appropriate
- [ ] For fields with standard comments (no options), verify descriptions explain purpose and behavior
- [ ] Confirm all field descriptions use present tense and end with period
- [ ] Ensure field descriptions focus on purpose/behavior, not format constraints (buf validation handles that)

## Common Mistakes and Fixes

### Admin API Format Errors

These apply to `proto/redpanda/core/admin/v2/**/*.proto`:

```protobuf
// ❌ Combined name and description on one line
// GetBroker returns broker information
rpc GetBroker(...)

// ❌ Missing blank line separator
// GetBroker
// Returns information about a single broker in the cluster.
rpc GetBroker(...)

// ✅ Correct: Name, blank line, description
// GetBroker
//
// Returns information about a single broker in the cluster.
rpc GetBroker(...)
```

## Using in PR Reviews

### As a Reviewer

**When you see incorrect format, leave a comment like:**

> The proto comment format doesn't match our standards. Please update to:
> ```protobuf
> // MethodName
> //
> // Description here.
> ```
>
> See the [proto comment format guide](link-to-this-prompt) for details.

**Or use the MCP tool to generate a validation report:**

Request: "Can you validate the proto comment format for the changes in this PR?"

The tool will generate a report of all format issues.

### As a PR Author

⚠️ **Note:** If you're using an AI agent or the MCP tool for assistance, remember that these tools only provide analysis and suggestions. YOU must manually execute all commands, verify changes, and create commits.

**Admin API (Redpanda Repo) - Before requesting review:**

1. **YOU** run formatter: `bazel run //tools:clang_format`
2. **YOU** regenerate files for ducktape tests: `tools/regenerate_ducktape_protos.sh`
3. **YOU** run buf generate: `buf generate --path proto`
4. **YOU** self-review: Check each RPC comment follows three-line format (method name, blank, description)
5. **YOU** test locally: Generate OpenAPI spec and verify output
6. (Optional) Preview documentation rendering with Bump CLI:
   - First generate the OpenAPI spec
   - Run `bump preview <path-to-admin-api-spec-yaml>`

**Control Plane API (CloudV2 Repo) - Before requesting review:**

1. **YOU** run formatter and linter:
   ```bash
   ./taskw proto:format
   ./taskw proto:lint
   ```
2. **YOU** regenerate OpenAPI specification:
   ```bash
   ./taskw proto:generate
   ```
   Note: If you have rebased from upstream, remember to run proto:generate again
3. **YOU** self-review: Check that RPCs have clear descriptions (comments or options)
4. **YOU** verify field options are accurate and complete
5. (Optional) Preview documentation rendering with Bump CLI:
   ```bash
   bump preview proto/gen/openapi/openapi.controlplane.prod.yaml
   ```

## Quick Reference Card

**Admin API Three-Line Format:**

```
✅ Correct Format:

// MethodName
//
// Clear description of what it does.
rpc MethodName(...) { }

❌ Wrong - No blank line:
// MethodName
// Description.
rpc MethodName(...) { }

❌ Wrong - Combined:
// MethodName does something.
rpc MethodName(...) { }

❌ Wrong - No method name:
// Description of method.
rpc MethodName(...) { }
```

## Questions?

- **"Why is the Admin API format so strict?"** → ConnectRPC's OpenAPI generation relies on this exact format for proper summary/description separation
- **"Why is Control Plane API format flexible?"** → gRPC with protoc-gen-openapi supports options that override comments, giving more flexibility
- **"Can I use multiple lines for description?"** →
  - Admin API: Yes! Just keep blank line after method name
  - Control Plane API: Yes, freely use multi-line comments
- **"What if I have both comments and options?"** → Options take precedence in Control Plane API; comments are used as fallback
- **"What about message/enum comments?"** → Those follow standard proto comment style (`//` above field) in both APIs
- **"Does this apply to internal services?"** → Strict format required for API-facing protos; recommended for consistency elsewhere

## Related Resources

- `compare_proto_descriptions` MCP tool - Automated format validation and comparison
- [API Description Backporting Guide](./backport-api-descriptions.md) - Workflow for backporting description improvements
- [Google API Documentation Style Guide](https://developers.google.com/style/api-reference-comments) - Writing style guidelines
- [Team Style Guide](../../team-standards/style-guide.md) - Redpanda documentation standards

---

**Remember**: Good proto comments = Good API documentation
