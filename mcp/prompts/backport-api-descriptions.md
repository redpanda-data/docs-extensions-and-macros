---
description: Guide for backporting API description improvements from api-docs OpenAPI specs to source repository proto files. Ensures proto files remain the source of truth for API documentation. Supports Admin API (redpanda repo) and Control Plane API (cloudv2 repo).
version: 1.0.0
---

## ⚠️ CRITICAL: No Auto-Commit Policy

**AI agents and assistants using this MCP tool are READ-ONLY for this workflow.**

The `compare_proto_descriptions` tool:
- ✅ Analyzes and compares specs
- ✅ Identifies differences
- ✅ Suggests changes
- ✅ Validates proto format
- ❌ NEVER modifies repositories
- ❌ NEVER stages files
- ❌ NEVER creates commits
- ❌ NEVER pushes to remote

**Why?** Proto file changes require:
- Human review for correctness
- Understanding of API implications
- Proper commit message context
- Verification of generated output

**The user MUST manually:**
1. Review suggested changes
2. Edit proto files
3. Run generation commands
4. Stage files with `git add`
5. Create commit with appropriate message
6. Push and create PR

If an AI agent attempts to run `git add`, `git commit`, or `git push` during this workflow, this is an error and should be reported.

---

# API Description Backporting Guide

This guide explains how to backport manually-improved API descriptions from the api-docs repository back to the proto source files in the appropriate source repository (redpanda or cloudv2).

## The Problem

When we manually improve API documentation in api-docs (admin/redpanda-admin-api.yaml, controlplane/redpanda-controlplane-api.yaml, etc.), those improvements exist only in the generated OpenAPI specs. The next time specs are regenerated from proto files, the improvements are lost.

**Solution**: Backport description improvements to the proto source files.

## Critical Rules

**NEVER directly edit OpenAPI YAML files in api-docs for permanent changes** - they are generated from proto files and will be overwritten.

**ALWAYS backport improvements to proto files** - proto files are the source of truth.

**ONLY modify descriptions and summaries** - do not change method names, parameters, response types, or other structural elements.

**FOLLOW the required comment format** - see the Proto Comment Format Guide for details.

## Supported API Surfaces

### Admin API
- **Source Repository**: redpanda
- **Proto Files**: `proto/redpanda/core/admin/v2/*.proto`
- **API Docs Spec**: `admin/admin.yaml` (or `admin/admin-v2.yaml`)
- **Known Services**: BrokerService, ClusterService, ShadowLinkService, SecurityService, KafkaConnectionsService
- **Auto-discovery**: ✅ Enabled - new services are automatically detected

### Control Plane API
- **Source Repository**: cloudv2
- **Proto Files**: `proto/public/cloud/redpanda/api/controlplane/v1/*.proto`
- **API Docs Spec**: `cloud-controlplane/cloud-controlplane.yaml`
- **Known Services**: ClusterService, NetworkService, NetworkPeeringService, ResourceGroupService, OperationService, RegionService, ServerlessService, ServerlessRegionService, ServerlessPrivateLinkService, ShadowLinkService
- **Auto-discovery**: ✅ Enabled - new services are automatically detected

## How Auto-Discovery Works

The comparison tool uses a **hybrid approach**: checks hard-coded service mappings first (fast path), then auto-discovers unmapped services by scanning proto directories. New services work automatically without code changes. When auto-discovery triggers, you'll see:

```
Auto-discovering proto file for unmapped service: NewService
✓ Auto-discovered: NewService -> proto/redpanda/core/admin/v2/new_service.proto
  Consider adding to PROTO_FILE_MAPS for better performance
```

## Proto Comment Format Rules

Proto RPC comment format **varies by API surface**:

**📖 See [Proto Comment Format Guide](./proto-comment-format-guide.md) for complete format rules, examples, and PR review checklist.**

### Admin API (ConnectRPC) - Strict Format

**Repository:** redpanda
**Required three-line structure:**

```protobuf
// MethodName
//
// Description of what the method does.
rpc MethodName(Request) returns (Response) {
```

**Required:**
1. Line 1: Method name only
2. Line 2: Blank comment (`//`)
3. Line 3+: Clear description

### Control Plane API (gRPC) - Flexible Format

**Repository:** cloudv2
**Flexible format:**

- Multi-line comments without blank line separator are acceptable
- Options (proto annotations like `openapiv2_operation`) can define summary/description
- Options take precedence over comments if both present
- Focus on clarity and completeness over strict format

The comparison tool validates Admin API format automatically. Control Plane API validation focuses on presence and quality of descriptions.

## Detection: Finding Discrepancies

Run `compare_proto_descriptions` MCP tool:

```
Parameters:
  api_docs_spec: "admin/admin.yaml"  # or "cloud-controlplane/cloud-controlplane.yaml"
  source_branch: "dev"  # optional, defaults to "dev"
  output_format: "detailed"  # or "report" for summary
  validate_format: true
```

Tool auto-detects API surface, finds repos, generates/compares specs, validates format, and reports:
- Which RPCs have discrepancies
- Current vs. generated descriptions
- Format validation issues
- Proto file locations to update

## Backporting: Applying Changes

### Prerequisites

1. **Clone and update source repositories** - Ensure you have the latest code from upstream:
   - For Admin API: `redpanda` repo on latest `dev` branch (`git checkout dev && git pull upstream dev`)
   - For Control Plane API: `cloudv2` repo on latest `main` branch (`git checkout main && git pull upstream main`)
2. **Repository auto-detection** - The tool will find repos using:
   - Explicit path parameters passed to the tool
   - Environment variables (`REDPANDA_REPO_PATH`, `CLOUDV2_REPO_PATH`, `API_DOCS_REPO_PATH`)
   - Sibling directories (e.g., `../redpanda`, `../cloudv2`, `../api-docs`)
3. **Create a new branch** from the updated base branch (e.g., `docs/update-proto-descriptions`)
4. **Have both api-docs and source repo accessible**

**Best Practice**: Backport descriptions soon after improving them in api-docs to keep changes fresh and minimize drift.

**Environment Variables (Optional):**
```bash
export REDPANDA_REPO_PATH="$HOME/workspace/redpanda"
export CLOUDV2_REPO_PATH="$HOME/workspace/cloudv2"
```

### Step 1: Read proto files

Read each proto file identified in the comparison report using the Read tool.

### Step 2: Update RPC method comments

For each RPC method with a description difference:

**Admin API:** Use Edit tool to apply three-line format (see Proto Comment Format Rules above).

**Example:**
```protobuf
Old:  // Gets information about a specific shadow link.
      rpc GetShadowLink(...)

New:  // GetShadowLink
      //
      // Gets information about a specific shadow link.
      rpc GetShadowLink(...)
```

**Control Plane API:** Update comments (flexible format) or `openapiv2_operation` options (see format rules above).

### Step 3: Quality checks before regeneration

- ✅ Only description/summary changed (no structural changes)
- ✅ Format correct (see Proto Comment Format Rules)
- ✅ Clear, concise, consistent style
- ✅ Follows Google Style Guide

### Step 4: Regenerate derived files

**For redpanda repository:**

After updating proto files, regenerate Go and Python code:

```bash
# 1. Format code
bazel run //tools:clang_format

# 2. Regenerate files for ducktape tests
tools/regenerate_ducktape_protos.sh

# 3. Run buf generate
buf generate --path proto
```

**Critical:** Use `--path proto` flag with buf to avoid symlink issues.

**For cloudv2 repository:**

After updating proto files:

```bash
# 1. Format code and lint
./taskw proto:format
./taskw proto:lint

# 2. Regenerate OpenAPI spec and generated code
./taskw proto:generate
```

**Note:** If you have rebased from upstream, remember to run `proto:generate` again.

### Step 5: Verify changes

```bash
git status
```

Expected changes:
- Proto files (your manual edits)
- Possibly: Generated Go files (`*.pb.go`)
- Possibly: Generated Python files (`*.py`, `*.pyi`)

Note: Generated files may not change if only comments were updated.

## Validation: Ensuring Correctness

### Admin API Validation

**Step 1: Generate OpenAPI bundle**

Use the `generate_bundle_openapi` MCP tool:

```
Parameters:
  branch: "docs/update-proto-descriptions"
  surface: "admin"
  repo: "/path/to/redpanda"  # or auto-detected
```

Or run manually:
```bash
npx doc-tools generate bundle-openapi \
  --branch docs/update-proto-descriptions \
  --surface admin \
  --repo /path/to/redpanda
```

**Step 2: Verify descriptions**

Check the generated spec in the redpanda repo:

```bash
grep -A 5 "operationId.*GetBroker" admin/redpanda-admin-api.yaml
```

The `summary` and `description` fields should match your proto comment improvements.

### Control Plane API Validation

**Step 1: Check generated spec**

After running `./taskw proto:generate` in the cloudv2 repo (Step 4 above), the OpenAPI spec is generated at:

```
proto/gen/openapi/openapi.controlplane.prod.yaml
```

**Step 2: Verify descriptions**

Check the generated spec in the cloudv2 repo:

```bash
grep -A 5 "operationId.*CreateCluster" proto/gen/openapi/openapi.controlplane.prod.yaml
```

The `summary` and `description` fields should match your proto comment or option improvements.

**Note:** The Control Plane API spec is generated directly in the cloudv2 repo by `./taskw proto:generate`. There is no separate bundle-openapi step for Control Plane API.

### Final Verification (Both APIs)

Run the comparison tool again to verify all discrepancies are resolved:

**For Admin API:**
```
Parameters:
  api_docs_spec: "admin/admin.yaml"
  source_branch: "docs/update-proto-descriptions"
  output_format: "report"
```

**For Control Plane API:**
```
Parameters:
  api_docs_spec: "cloud-controlplane/cloud-controlplane.yaml"
  source_branch: "docs/update-proto-descriptions"
  output_format: "report"
```

Should show: "✅ No description discrepancies found."

## User Creates Commit and PR

**⚠️ Manual user action required - AI agents must not execute these commands.**

### Review and Commit

```bash
# Review changes
git diff  # Verify: only proto/generated files changed, descriptions correct, format correct

# Add proto files (and generated files if changed)
git add proto/.../*.proto

# Commit with message
git commit
```

**Commit message format:**
```
docs[/proto]: improve [API name] API descriptions

- Add proper format (RPC name, blank line, description) [if Admin API]
- Backport improvements from api-docs
- Update [specific operations changed]

Ensures proto files remain source of truth for API documentation.
```

### Push and PR

```bash
git push origin docs/update-proto-descriptions
```

**PR targets:** `dev` branch (redpanda), repo-specific guidelines (cloudv2). Note: docs-only change.

## Workflow Summary

1. **Detect**: Use `compare_proto_descriptions` tool
2. **Create branch**: `docs/update-proto-descriptions` in source repo
3. **Update**: Edit proto file comments (RPC name, blank, description)
4. **Format**: Run repository-specific formatting (clang_format for redpanda)
5. **Regenerate**: Run proto code generation commands
6. **Verify**: Use `generate_bundle_openapi` tool to check
7. **User commits**: User creates commit with clear message
8. **User creates PR**: User submits to appropriate branch

## Common Issues

**Issue**: "Could not find redpanda repository"
**Fix**: Clone redpanda as sibling directory, or set `REDPANDA_REPO_PATH` environment variable

**Issue**: "Could not find cloudv2 repository"
**Fix**: Clone cloudv2 as sibling directory, or set `CLOUDV2_REPO_PATH` environment variable

**Issue**: "Could not locate api-docs repository"
**Fix**: Clone api-docs as sibling directory to docs-extensions-and-macros, or set `API_DOCS_REPO_PATH` environment variable

**Issue**: "too many links" error from buf generate
**Fix**: Use `--path proto` flag (or `--path proto/public/cloud` for cloudv2)

**Issue**: Bazel build fails on macOS
**Fix**: Use `buf generate --path proto` instead of full bazel build (documentation-only changes don't need full build)

**Issue**: Changes lost after OpenAPI regeneration
**Fix**: Ensure you updated proto files, not OpenAPI YAML directly

**Issue**: Format validation fails
**Fix**: Ensure RPC name is on first line, blank line second, description third+

**Issue**: Generated files don't show changes
**Fix**: This is normal - proto comments don't always affect generated code, only OpenAPI specs

**Issue**: API surface auto-detection fails
**Fix**: Explicitly specify `api_surface` parameter ("admin" or "controlplane")

## Repository Detection

The tool auto-detects all required repositories (redpanda, cloudv2, api-docs) using three strategies:

1. **Explicit path parameters** - Pass directly to tool (`redpanda_repo_path`, `cloudv2_repo_path`, `api_docs_repo_path`)
2. **Environment variables** - `REDPANDA_REPO_PATH`, `CLOUDV2_REPO_PATH`, `API_DOCS_REPO_PATH`
3. **Sibling directories** - Auto-detects `../redpanda`, `../cloudv2`, `../api-docs` relative to MCP server

**Recommended Setup:** Clone all repos as siblings to docs-extensions-and-macros:

```bash
cd <parent-directory-of-docs-extensions-and-macros>
git clone https://github.com/redpanda-data/redpanda.git
git clone https://github.com/redpanda-data/cloudv2.git
git clone https://github.com/redpanda-data/api-docs.git
```

**Alternative:** Set environment variables:
```bash
export REDPANDA_REPO_PATH="$HOME/workspace/redpanda"
export CLOUDV2_REPO_PATH="$HOME/workspace/cloudv2"
export API_DOCS_REPO_PATH="$HOME/workspace/api-docs"
```

**Path Resolution:** Relative paths in `api_docs_spec` (e.g., `"admin/admin.yaml"`) resolve within api-docs repo; absolute paths used as-is.

If detection fails, you'll receive an error with setup instructions.

## Related Resources

- `compare_proto_descriptions` MCP tool - Automated format validation and comparison
- `generate_bundle_openapi` MCP tool - OpenAPI spec generation
- [Proto Comment Format Guide](./proto-comment-format-guide.md) - Format rules and PR review checklist
- [Google API Documentation Style Guide](https://developers.google.com/style/api-reference-comments) - Writing style guidelines
- [Team Style Guide](../../team-standards/style-guide.md) - Redpanda documentation standards

## Workflow Example

**User:** "I've improved API descriptions in admin/admin.yaml. Can you check if they need backporting?"

**Claude:** Uses `compare_proto_descriptions` tool → finds discrepancies → reads proto files → updates RPC comments with proper format → runs formatter and regeneration scripts → generates OpenAPI bundle to verify → reports success

**User:** Reviews diff, commits, creates PR

## Notes for LLMs

- Use comparison tool first to understand scope
- Focus on descriptions only - never change API structure
- Validate format before and after changes
- Let users create commits/PRs - don't do it automatically
- Handle multiple APIs separately
