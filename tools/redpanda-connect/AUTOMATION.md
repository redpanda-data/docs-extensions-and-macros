# Redpanda Connect Connector Documentation Automation

## Overview

This automation generates comprehensive reference documentation for Redpanda Connect connectors, including inputs, outputs, processors, buffers, caches, rate limiters, metrics, tracers, scanners, and optionally Bloblang functions/methods.

The automation handles **multi-release attribution**, automatically detecting and processing intermediate releases that may have been missed, ensuring that changes are accurately attributed to their actual release version rather than being lumped together.

## Goals

### Primary Goals

1. **Generate Comprehensive Reference Docs**: Create AsciiDoc documentation for all Redpanda Connect components with:
   - Field descriptions with types, defaults, and options
   - Working code examples (minimal and advanced configurations)
   - Cross-references to related components
   - Metadata (status badges: stable, beta, experimental, deprecated)

2. **Accurate Version Attribution**: Track when each component and field was introduced:
   - Detect releases between the last documented version and latest
   - Process each release pair sequentially
   - Generate per-version change tracking
   - Maintain historical accuracy even when releases are skipped

3. **Platform Support Detection**: Identify and document platform availability:
   - **Cloud-supported**: Available in Redpanda Cloud (both serverless and BYOC)
   - **Self-hosted only**: Available only in self-hosted deployments
   - **Cloud-only**: Exclusive to Redpanda Cloud
   - **Cgo-required**: Requires cgo-enabled builds

4. **Change Detection & Reporting**: Generate detailed change reports:
   - New connectors and fields
   - Removed/deprecated components
   - Changed default values
   - Breaking changes (removed fields)

## How It Works

### Architecture Overview

```text
┌─────────────────────────────────────────────────────────────────┐
│ 1. Version Detection                                            │
│    • Read current version from antora.yml                       │
│    • Detect latest version from GitHub releases or rpk          │
│    • Discover all intermediate releases                         │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Sequential Release Processing (for each version pair)        │
│    ┌───────────────────────────────────────────────────────┐   │
│    │ For each pair (v[n] → v[n+1]):                        │   │
│    │   a. Fetch connector data for both versions           │   │
│    │   b. Run binary analysis (OSS, Cloud, cgo)            │   │
│    │   c. Generate version-specific diff                   │   │
│    │   d. Track changes with version attribution           │   │
│    └───────────────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Final Version Processing                                     │
│    • Generate AsciiDoc partials (fields & examples)             │
│    • Create full page drafts for new connectors (optional)      │
│    • Update navigation files                                    │
│    • Create master diff aggregating all changes                 │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Output Generation                                            │
│    • Individual diffs: connect-diff-X.X.X_to_Y.Y.Y.json        │
│    • Master diff: connect-diff-master-X.X.X_to_Z.Z.Z.json      │
│    • PR summary with per-version attribution                    │
│    • Writer action items                                        │
└─────────────────────────────────────────────────────────────────┘
```

### Multi-Release Processing

**Scenario**: antora.yml has version `4.50.0`, latest release is `4.54.0`

**Without Multi-Release (OLD behavior)**:
```text
4.50.0 ─────────────────────────► 4.54.0
         (all changes lumped)
```
Result: All changes from 4.51.0, 4.52.0, 4.53.0, and 4.54.0 are attributed to 4.54.0 ❌

**With Multi-Release (NEW behavior)**:
```text
4.50.0 ──► 4.51.0 ──► 4.52.0 ──► 4.53.0 ──► 4.54.0
   │          │          │          │          │
   diff1      diff2      diff3      diff4      │
   │          │          │          │          │
   └──────────┴──────────┴──────────┴──────────┘
                      │
                      ▼
              master-diff.json
          (accurate attribution)
```
Result: Each change is attributed to its actual release version ✅

### Version Detection Flow

1. **Determine Starting Version**:
   - Read `asciidoc.attributes.latest-connect-version` from `antora.yml`
   - OR use `--from-version` flag override
   - OR fallback to latest JSON file in `docs-data/`

2. **Determine Target Version**:
   - Use `--connect-version` flag (explicit version)
   - OR auto-detect latest stable release from GitHub
   - OR use local `rpk connect --version`

3. **Discover Intermediate Releases**:
   - Query GitHub Releases API: `repos/redpanda-data/connect/releases`
   - Filter to stable releases (exclude beta, RC, alpha)
   - Parse semver and find all versions between start and target
   - Sort chronologically

### Data Collection

For each version being processed:

1. **Connector Metadata** (via `rpk connect list`):
   ```json
   {
     "name": "kafka",
     "type": "inputs",
     "status": "stable",
     "description": "...",
     "summary": "...",
     "config": { /* full schema */ }
   }
   ```

2. **Binary Analysis** (download and inspect binaries):
   - **OSS binary**: Standard self-hosted build
   - **Cloud binary**: Redpanda Cloud serverless/BYOC build
   - **Cgo binary**: Build with cgo-enabled components

   Compares which connectors exist in each binary to determine:
   - `inCloud`: Present in both OSS and Cloud
   - `notInCloud`: Only in OSS (self-hosted only)
   - `cloudOnly`: Only in Cloud binary
   - `cgoOnly`: Only in cgo-enabled binary

3. **Metadata CSV** (optional, from GitHub):
   - Commercial names for connectors
   - Additional categorization info

### Change Detection

For each version pair `(oldVersion → newVersion)`:

```javascript
{
  "comparison": {
    "oldVersion": "4.50.0",
    "newVersion": "4.51.0",
    "timestamp": "2026-04-01T00:00:00.000Z"
  },
  "summary": {
    "newComponents": 3,      // New connectors
    "newFields": 15,          // New fields added to existing connectors
    "removedComponents": 0,
    "removedFields": 2,       // Breaking changes!
    "deprecatedComponents": 0,
    "deprecatedFields": 1,
    "changedDefaults": 0
  },
  "details": {
    "newComponents": [
      {
        "name": "postgres_cdc",
        "type": "inputs",
        "status": "beta",
        "version": "4.51.0",    // Attribution!
        "description": "..."
      }
    ],
    "newFields": [
      {
        "component": "inputs:kafka",
        "field": "rack_id",
        "description": "..."
      }
    ],
    // ... other change categories
  },
  "binaryAnalysis": {
    "ossVersion": "4.51.0",
    "cloudVersion": "4.52.0-rc1",
    "comparison": {
      "inCloud": [/*...*/],
      "notInCloud": [/*...*/],
      "cloudOnly": [/*...*/]
    },
    "cgoOnly": [/*...*/]
  }
}
```

## Output Specifications

### 1. AsciiDoc Documentation Files

#### Field Partials (`modules/components/partials/fields/{type}/{name}.adoc`)

```asciidoc
// This content is autogenerated. Do not edit manually.

== Fields

=== `field_name`

Description of the field with details.

*Type*: `string`

*Default*: `"default_value"`

*Options*: `option1`, `option2`, `option3`

[source,yaml]
----
# Example:
field_name: example_value
----

=== `another_field`

...
```

**Requirements**:
- All fields documented with type, default, options
- Code examples in YAML
- Cross-references using `xref:` syntax
- Conditional content for deprecated/experimental fields

#### Example Partials (`modules/components/partials/examples/{type}/{name}.adoc`)

```asciidoc
// This content is autogenerated. Do not edit manually.

== Examples

=== Minimal configuration

Basic setup with required fields only

[source,yaml]
----
input:
  kafka:
    addresses: ["localhost:9092"]
    topics: ["my_topic"]
----

=== Advanced configuration

Complete configuration with optional fields

[source,yaml]
----
input:
  kafka:
    addresses: ["localhost:9092"]
    topics: ["my_topic"]
    consumer_group: "my_group"
    checkpoint_limit: 1000
    # ... all fields
----
```

**Requirements**:
- Minimal example (required fields only)
- Advanced example (all meaningful fields)
- **Only output one example if they're identical** (no tabs needed)
- Use leading sentence: "Here's an example configuration:"
- Real-world, working configurations

#### Full Page Drafts (`modules/components/pages/{type}/{name}.adoc`)

Generated with `--draft-missing` flag for NEW connectors:

```asciidoc
= Connector Name
:type: input
:status: beta
:page-commercial-names: Commercial Name, Alternative Name

// tag::single-source[]

Brief summary of what this connector does.

== Common Use Cases

* Use case 1
* Use case 2

[tabs]
====
Common config::
+
include::redpanda-connect:components:partial$examples/inputs/connector_name.adoc[tag=common]

Advanced config::
+
include::redpanda-connect:components:partial$examples/inputs/connector_name.adoc[tag=advanced]
====

include::redpanda-connect:components:partial$fields/inputs/connector_name.adoc[]

// end::single-source[]
```

**Requirements**:
- Frontmatter with metadata
- Single-source tags for reuse in cloud docs
- Tabs for common vs advanced configs (only if different)
- Platform indicators (☁️ for cloud, 🔧 for cgo)

### 2. Data Files

#### Connector Data JSON (`docs-data/connect-{version}.json`)

Complete connector metadata for a specific version:

```json
{
  "inputs": [
    {
      "name": "kafka",
      "status": "stable",
      "plugin": true,
      "description": "...",
      "summary": "...",
      "config": {
        "type": "object",
        "fields": [
          {
            "name": "addresses",
            "type": "array",
            "description": "...",
            "default": [],
            "kind": "scalar"
          }
        ]
      },
      "requiresCgo": false,
      "cloudOnly": false
    }
  ],
  "outputs": [...],
  "processors": [...],
  // ... other component types
}
```

**Retention**: Only the latest version is kept after processing completes.

#### Individual Diff JSON (`docs-data/connect-diff-{v1}_to_{v2}.json`)

Changes between two consecutive versions:

```json
{
  "comparison": {
    "oldVersion": "4.50.0",
    "newVersion": "4.51.0",
    "timestamp": "2026-04-01T10:00:00.000Z"
  },
  "summary": {
    "newComponents": 3,
    "newFields": 15,
    "removedFields": 2,
    "deprecatedFields": 1
  },
  "details": {
    "newComponents": [...],
    "newFields": [...],
    "removedFields": [...],
    "deprecatedFields": [...],
    "changedDefaults": [...]
  },
  "binaryAnalysis": {
    "versions": {
      "oss": "4.51.0",
      "cloud": "4.52.0",
      "cgo": "4.52.0"
    },
    "comparison": {
      "inCloud": [...],
      "notInCloud": [...],
      "cloudOnly": [...]
    },
    "cgoOnly": [...],
    "details": {
      "cloudSupported": [...],
      "selfHostedOnly": [...],
      "cloudOnly": [...]
    }
  }
}
```

**Retention**: Kept for intermediate versions during processing, cleaned up after master diff is created.

#### Master Diff JSON (`docs-data/connect-diff-master-{v1}_to_{vN}.json`)

Aggregated changes across multiple releases:

```json
{
  "metadata": {
    "generatedAt": "2026-04-01T10:00:00.000Z",
    "startVersion": "4.50.0",
    "endVersion": "4.54.0",
    "processedReleases": 4
  },
  "totalSummary": {
    "versions": ["4.51.0", "4.52.0", "4.53.0", "4.54.0"],
    "releaseCount": 4,
    "newComponents": 12,
    "newFields": 45,
    "removedFields": 5,
    "deprecatedFields": 3
  },
  "releases": [
    {
      "fromVersion": "4.50.0",
      "toVersion": "4.51.0",
      "date": "2024-05-01T00:00:00.000Z",
      "summary": {...},
      "details": {...},
      "binaryAnalysis": {...}
    },
    {
      "fromVersion": "4.51.0",
      "toVersion": "4.52.0",
      // ...
    }
    // ... one entry per release
  ]
}
```

**Purpose**: Provides writers with accurate per-version attribution for changelog/release notes.

### 3. PR Summary

Automatically generated PR description with platform indicators and action items:

```markdown
## 📊 Redpanda Connect Documentation Update

**📦 Multi-Release Update:** 4.50.0 → 4.54.0
**Releases Processed:** 4
**Cloud Version:** 4.55.0

### Total Changes Across All Releases

- **12** new connectors
- **45** new fields across 4 release(s)
- **5** removed fields ⚠️
- **3** deprecated fields

### Changes Per Release

#### 🔖 Version 4.51.0

**New Connectors (3):**
- `postgres_cdc` (inputs, beta) ☁️
- `tigerbeetle_cdc` (inputs, beta) 🔧
- `mongodb_cdc` (inputs, stable) ☁️

**New Fields:** 12 added
**⚠️ Removed Fields:** 2

#### 🔖 Version 4.52.0

**New Connectors (5):**
- `oracledb_cdc` (inputs, experimental) ☁️
- `elasticsearch_v9` (outputs, stable)
- ...

**New Fields:** 18 added

#### 🔖 Version 4.53.0

_No changes in this release_

#### 🔖 Version 4.54.0

**New Connectors (4):**
...

### ✍️ Writer Action Items

**Document New Connectors:**

- [ ] Document new `postgres_cdc` inputs from **4.51.0** ☁️
- [ ] Document new `tigerbeetle_cdc` inputs from **4.51.0** 🔧
- [ ] Document new `mongodb_cdc` inputs from **4.51.0** ☁️
- [ ] Document new `oracledb_cdc` inputs from **4.52.0** ☁️
- [ ] Document new `a2a_message` processors from **4.54.0** ☁️

### ☁️ Cloud Docs Update Required

**12** new connectors are available in Redpanda Cloud.

**Action:** Submit a separate PR to cloud-docs repository.

**For connectors in pages:**
\```asciidoc
include::redpanda-connect:components:page$type/name.adoc[tag=single-source]
\```

**For cloud-only connectors (in partials):**
\```asciidoc
include::redpanda-connect:components:partial$components/cloud-only/type/name.adoc[tag=single-source]
\```

### 🔧 Cgo Requirements

The following new connectors require cgo-enabled builds:

- `tigerbeetle_cdc` (inputs)
- `zmq4` (inputs, outputs)
- `ffi` (processors)

[Cgo installation instructions included]

<details>
<summary><strong>📋 Detailed Changes</strong> (click to expand)</summary>

[Comprehensive breakdown of all changes]

</details>
```

**Indicators**:
- ☁️ = Cloud-supported (available in Redpanda Cloud)
- 🔧 = Requires cgo-enabled build
- ⚠️ = Breaking change (removed fields)

## CLI Usage

### Basic Usage

```bash
# Generate docs for latest version
npx doc-tools generate rpcn-connector-docs --fetch-connectors

# Generate docs for specific version
npx doc-tools generate rpcn-connector-docs \
  --fetch-connectors \
  --connect-version 4.54.0

# Process intermediate releases with custom starting version
npx doc-tools generate rpcn-connector-docs \
  --fetch-connectors \
  --from-version 4.50.0 \
  --connect-version 4.54.0
```

### CLI Flags

| Flag | Description | Default |
|------|-------------|---------|
| `--fetch-connectors` | Fetch fresh connector data using rpk | - |
| `--connect-version <version>` | Target Connect version to process | Auto-detect latest |
| `--from-version <version>` | Override starting version (instead of antora.yml) | Read from antora.yml |
| `--skip-intermediate` | Disable multi-release processing (legacy mode) | Multi-release enabled |
| `--cloud-version <version>` | Specific cloud binary version | Auto-detect latest |
| `--cgo-version <version>` | Specific cgo binary version | Same as cloud |
| `--draft-missing` | Generate full page drafts for new connectors | false |
| `--update-whats-new` | Update whats-new.adoc with changes | false |
| `--include-bloblang` | Include Bloblang functions/methods | false |
| `--overrides <path>` | JSON file with description overrides | `docs-data/overrides.json` |

### Examples

#### Catchup After Missed Releases

```bash
# antora.yml has 4.50.0, but latest is 4.54.0
# This will process all 4 intermediate releases

npx doc-tools generate rpcn-connector-docs \
  --fetch-connectors \
  --draft-missing \
  --update-whats-new
```

**Output**:
- Processes: 4.50.0→4.51.0, 4.51.0→4.52.0, 4.52.0→4.53.0, 4.53.0→4.54.0
- Creates: 4 individual diffs + 1 master diff
- Generates: Partials, drafts, PR summary with per-version attribution

#### Legacy Single-Version Mode

```bash
# Disable multi-release processing (old behavior)

npx doc-tools generate rpcn-connector-docs \
  --fetch-connectors \
  --skip-intermediate
```

#### Custom Version Range

```bash
# Process releases between specific versions

npx doc-tools generate rpcn-connector-docs \
  --fetch-connectors \
  --from-version 4.52.0 \
  --connect-version 4.54.0
```

## File Structure

```
docs-extensions-and-macros/
├── tools/redpanda-connect/
│   ├── rpcn-connector-docs-handler.js      # Main orchestration
│   ├── generate-rpcn-connector-docs.js     # Doc generation logic
│   ├── report-delta.js                     # Diff generation
│   ├── pr-summary-formatter.js             # PR summary formatting
│   ├── github-release-utils.js             # GitHub API integration
│   ├── multi-version-summary.js            # Master diff aggregation
│   ├── connector-binary-analyzer.js        # Binary download & analysis
│   └── update-whats-new.js                 # Release notes updates
│
├── docs-data/                              # Generated data (gitignored)
│   ├── connect-{version}.json              # Connector metadata (latest only)
│   ├── connect-diff-{v1}_to_{v2}.json     # Individual diffs (intermediate)
│   └── connect-diff-master-{v1}_to_{vN}.json  # Master diff (kept)
│
└── modules/components/
    ├── pages/{type}/{name}.adoc            # Full pages (manually created or drafted)
    └── partials/
        ├── fields/{type}/{name}.adoc       # Auto-generated field docs
        └── examples/{type}/{name}.adoc     # Auto-generated examples
```

## Testing

### Unit Tests

```bash
# Run all tests
npm test

# Test specific modules
npm test -- __tests__/tools/github-release-utils.test.js
npm test -- __tests__/tools/pr-summary-formatter.test.js
```

**Coverage**:
- ✅ Version parsing and semver comparisons
- ✅ Prerelease filtering (beta/RC/alpha)
- ✅ Intermediate release discovery
- ✅ Platform detection (cloud vs self-hosted)
- ✅ PR summary formatting (single and multi-version)
- ✅ Diff generation and change detection

### Integration Testing

```bash
# Create test environment
mkdir -p /tmp/test-automation/{docs-data,modules/components/pages}

# Create mock antora.yml
echo 'name: test
version: main
asciidoc:
  attributes:
    latest-connect-version: "4.50.0"' > /tmp/test-automation/antora.yml

# Run automation
cd /tmp/test-automation
npx doc-tools generate rpcn-connector-docs \
  --from-version 4.50.0 \
  --connect-version 4.54.0 \
  --fetch-connectors
```

**Verify**:
- ✅ Multiple diffs created (one per release pair)
- ✅ Master diff with accurate attribution
- ✅ AsciiDoc partials generated
- ✅ antora.yml updated to latest version
- ✅ Only latest JSON retained

## Dependencies

### Runtime Dependencies
- `@octokit/rest` - GitHub API client for release discovery
- `semver` - Semantic version parsing and comparison
- `handlebars` - Template engine for doc generation
- `js-yaml` - YAML parsing for antora.yml

### External Tools
- `rpk` - Redpanda CLI for fetching connector metadata
- `git` - For cloning repositories to fetch binary versions

## Error Handling

### GitHub API Rate Limiting
- **Without token**: 60 requests/hour
- **With token**: 5,000 requests/hour
- **Handling**: Cache responses, graceful degradation to single-version mode

### Missing Intermediate Data
- Automatically fetches from GitHub releases
- Downloads binaries for specified versions
- Falls back to rpk if available locally

### Network Failures
- Retries with exponential backoff
- Continues processing with partial data
- Logs warnings for manual review

## Edge Cases

### No Intermediate Releases
- Behaves like legacy single-version mode
- No master diff created
- Standard PR summary generated

### Beta/RC Versions
- Automatically filtered out
- Only stable GA releases processed
- Explicit override with `--include-prerelease` (not yet implemented)

### Identical Consecutive Versions
- Skips diff generation
- Logs "No changes detected"
- Updates metadata only

### Binary Unavailability
- Continues without binary analysis
- Platform indicators omitted from output
- Warning logged for manual verification

## Future Enhancements

1. **Bloblang Full Support**: Currently optional, could be made default
2. **Automated PR Creation**: Auto-submit PRs with generated content
3. **CI/CD Integration**: GitHub Actions workflow for weekly runs
4. **Historical Backfill**: Process all historical releases for complete attribution
5. **Diff Visualization**: Web UI to browse changes across versions
6. **Custom Templates**: User-provided Handlebars templates for docs

## Maintenance

### Updating Templates
Templates are in `tools/redpanda-connect/templates/`:
- `connector-fields.hbs` - Field documentation template
- `connector-examples.hbs` - Examples template
- `connector-full.hbs` - Full page draft template

### Updating Overrides
Override file: `docs-data/overrides.json` (or `--overrides` flag)

```json
{
  "inputs": {
    "kafka": {
      "fields": {
        "addresses": {
          "description": "Custom description override",
          "examples": ["localhost:9092"]
        }
      }
    }
  }
}
```

Supports `$ref` syntax for deduplication:
```json
{
  "inputs": {
    "kafka": {
      "fields": {
        "tls": { "$ref": "#/common/tls" }
      }
    }
  },
  "common": {
    "tls": {
      "description": "TLS configuration (reused across components)"
    }
  }
}
```

## Troubleshooting

### "No releases found in the specified range"
- **Cause**: Invalid version range or no releases exist between versions
- **Fix**: Verify versions exist on GitHub, check semver format

### "GitHub API rate limit exceeded"
- **Cause**: Too many API requests without authentication
- **Fix**: Set `GITHUB_TOKEN` environment variable

### "Binary analysis failed"
- **Cause**: Unable to download binaries (network, permissions, etc.)
- **Fix**: Check network, ensure write permissions to temp directories

### "Versions match, skipping diff"
- **Cause**: Already at target version, no work needed
- **Fix**: This is expected behavior, no action needed

## Contact & Support

For issues or questions:
- **GitHub Issues**: [docs-extensions-and-macros repository](https://github.com/redpanda-data/docs-extensions-and-macros/issues)
- **Slack**: #docs channel
- **Docs**: Internal Confluence documentation

---

**Last Updated**: 2026-04-01
**Version**: 1.0.0
**Maintainers**: Redpanda Docs Team
