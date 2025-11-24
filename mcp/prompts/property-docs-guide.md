# Property documentation update guide for LLMs

This guide explains how to update Redpanda property documentation when all property reference pages are auto-generated.

Critical rule: Never directly edit files in `/modules/reference/partials/properties/` - they are auto-generated and will be overwritten.

## The auto-generation system

All property documentation files are automatically generated from source code metadata.

Generated files (do not edit):
- `/modules/reference/partials/properties/broker-properties.adoc`
- `/modules/reference/partials/properties/cluster-properties.adoc`
- `/modules/reference/partials/properties/object-storage-properties.adoc`
- `/modules/reference/partials/properties/topic-properties.adoc`

Override file (edit this):
- `/docs-data/property-overrides.json`

## Why this matters

When a user asks you to:
- "Improve the description of cleanup.policy"
- "Add an example for kafka_qdc_enable"
- "Fix the documentation for compression.type"
- "Add related topics to retention.ms"

You must:
1. Update `/docs-data/property-overrides.json`
2. Run the doc-tools CLI to regenerate
3. Do not edit the generated `.adoc` files directly

## The override system

The override file provides human-curated content that supplements or replaces auto-generated content.

## File structure

Location: `docs-data/property-overrides.json`

Basic structure:
```json
{
  "properties": {
    "property_name": {
      "description": "Enhanced description text",
      "config_scope": "broker|cluster|topic",
      "category": "category-name",
      "example": [
        "Line 1 of example",
        "Line 2 of example"
      ],
      "related_topics": [
        "xref:path/to/doc.adoc[Link Text]",
        "xref:another/doc.adoc#anchor[Another Link]"
      ],
      "exclude_from_docs": false
    }
  }
}
```

## What can be overridden

Fields you can override:
- `description` - Enhance or replace property description
- `config_scope` - Specify broker/cluster/topic scope
- `category` - Categorize property
- `example` - Add YAML configuration examples (array of strings)
- `related_topics` - Add cross-references (array of AsciiDoc xref links)
- `exclude_from_docs` - Hide internal/deprecated properties
- `type` - Override detected type
- `default` - Override default value
- `accepted_values` - Override accepted values

## How to update overrides

### Step 1: Read the current override file
Always read the file first to preserve existing overrides.

### Step 2: Add or update property overrides
Modify the properties object.

### Step 3: Write back to file
Save the updated JSON.

### Step 4: Verify JSON is valid
Run: `python -c "import json; json.load(open('docs-data/property-overrides.json'))"`

## Regenerating documentation

### Prerequisites
Before running doc-tools, you must have:
1. A valid GitHub token with repo access to cloudv2 in the redpandadata organization
2. The token set as the GITHUB_TOKEN environment variable

### The doc-tools CLI
After updating overrides, regenerate documentation:

```bash
npx doc-tools generate property-docs \
  --tag "<redpanda-version>" \
  --generate-partials \
  --cloud-support \
  --overrides docs-data/property-overrides.json
```

Important notes:
- Always use `npx doc-tools` (not just `doc-tools`)
- The `--tag` flag specifies which Redpanda version to generate docs for
- The `--generate-partials` flag generates files in the partials directory
- The `--cloud-support` flag must ALWAYS be included - never exclude it
- The `--overrides` flag points to the property overrides JSON file

## Property description rules (MANDATORY)

### Never add cloud-specific conditional blocks
Do not include cloud-specific descriptions. These belong in metadata, not description text.

Wrong:
```
ifdef::env-cloud[]
This property is read-only in Redpanda Cloud.
endif::[]
```

Right:
```
Controls the maximum segment size for topics.
```

Reason: Cloud-specific information is displayed in the metadata table.

### Never add enterprise license includes
Do not include enterprise license markers in descriptions.

Wrong:
```
Enable shadow linking for disaster recovery.

include::reference:partial$enterprise-licensed-property.adoc[]
```

Right:
```
Enable shadow linking for disaster recovery.
```

Reason: Enterprise licensing information is displayed in the metadata table.

### Never add descriptions for deprecated properties
Do not add or update descriptions for properties marked as deprecated.

Process:
1. Check if the property is deprecated
2. If deprecated, remove any existing override
3. Never add new overrides for deprecated properties

### Keep descriptions focused
Descriptions should explain:
- What the property does
- When to use it
- How it relates to other properties
- Important behavioral details

Descriptions should NOT include:
- Version availability (metadata)
- Cloud availability (metadata)
- Enterprise license requirements (metadata)
- Requires restart (metadata)
- Default values (metadata)
- Type information (metadata)

### Use consistent formatting
Use AsciiDoc formatting in descriptions:
- `` `property_name` `` for property names
- `xref:module:path/to/doc.adoc[Link Text]` for cross-references (always use full resource IDs with module prefix)
- `<<anchor,text>>` for internal document references
- `\n\n` for paragraph breaks

Important: Always use full Antora resource IDs with module prefixes in xref links, never relative paths.

Wrong:
```json
{
  "description": "When `segment.bytes` is set, it overrides xref:./cluster-properties.adoc#log_segment_size[`log_segment_size`]."
}
```

Right:
```json
{
  "description": "When `segment.bytes` is set, it overrides xref:reference:properties/cluster-properties.adoc#log_segment_size[`log_segment_size`]."
}
```

Common module prefixes:
- `reference:` for reference documentation
- `manage:` for management documentation
- `deploy:` for deployment documentation
- `get-started:` for getting started guides

### Prefix self-managed-only links
Some documentation pages only exist in self-managed deployments. Prefix these with `self-managed-only:`.

Example:
```json
{
  "kafka_connections_max": {
    "related_topics": [
      "self-managed-only:xref:manage:cluster-maintenance/configure-client-connections.adoc[Limit client connections]"
    ]
  }
}
```

### Remove duplicate links
Always remove duplicates from related_topics lists.

### Normalize xref links to full resource IDs
After updating overrides, normalize all xref links to use full Antora resource IDs.

## Common scenarios

### Improve a property description
1. Read the override file
2. Update the description field
3. Write back to override file
4. Use the `generate_property_docs` MCP tool to regenerate the documentation
5. If that tool is not available, tell the user to run:
   `npx doc-tools generate property-docs --tag "<version>" --generate-partials --cloud-support --overrides docs-data/property-overrides.json`

### Add an example
1. Add an `example` array with YAML lines to the property override
2. Use the `generate_property_docs` MCP tool to regenerate

### Add related topics
1. Add `related_topics` array with AsciiDoc xref links
2. Use the `generate_property_docs` MCP tool to regenerate

### Fix incorrect metadata
1. Override specific fields like `default` or `type`
2. Use the `generate_property_docs` MCP tool to regenerate

### Hide internal properties
1. Set `exclude_from_docs: true`
2. Use the `generate_property_docs` MCP tool to regenerate

## Validation

After updating overrides:
1. Validate JSON syntax
2. Check for common mistakes (example/related_topics are arrays, xref format)
3. Verify after regeneration

## Summary for LLMs

When asked to update property documentation:

1. Update `/docs-data/property-overrides.json`
2. Run the doc-tools CLI with the correct command (including all required flags)
3. Never edit `/modules/reference/partials/properties/*.adoc` directly

Critical requirements:
- Must have GITHUB_TOKEN environment variable set
- Must ALWAYS include `--cloud-support` flag
- Must use `npx doc-tools`
- Must include all flags: `--tag`, `--generate-partials`, `--cloud-support`, `--overrides`

Property description rules (mandatory):
- Never add enterprise license includes
- Never add descriptions for deprecated properties
- Keep descriptions focused on behavior, not metadata
- Use AsciiDoc formatting
- Always use full Antora resource IDs with module prefixes in xref links
- Prefix self-managed-only links with `self-managed-only:`
- Remove duplicate links

Your workflow:
1. Always read the override file first to preserve existing overrides
2. Make your changes to the property overrides
3. Validate JSON syntax after changes
4. Use the `generate_property_docs` MCP tool to regenerate the documentation
   - Set version parameter to the Redpanda version
   - Set generate_partials to true
5. If the tool is not available, provide the user with the command:
   `npx doc-tools generate property-docs --tag "<version>" --generate-partials --cloud-support --overrides docs-data/property-overrides.json`
6. Explain what was changed and what files will be regenerated
7. If generation fails, remind the user they need GITHUB_TOKEN set with cloudv2 repo access

Quality checks you must perform:
- Clean up any inappropriate content from descriptions (no enterprise includes, no cloud conditionals)
- Remove any overrides for deprecated properties
- Normalize all xref links to full Antora resource IDs with module prefixes
- Remove duplicate links from related_topics arrays
