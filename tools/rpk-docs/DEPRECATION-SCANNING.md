# Automatic Deprecation Detection for rpk Commands

## Overview

The rpk documentation automation now automatically scans Go source code to detect commands marked as `Hidden: true` or `Deprecated: "message"` in Cobra command definitions. This ensures deprecated commands are properly documented with warnings even though they don't appear in `rpk --print-tree` output.

## How It Works

### 1. Source Code Scanning

The `scan-deprecated-commands.js` module scans the rpk Go source code looking for:

```go
cmd := &cobra.Command{
    Use:        "admin",
    Hidden:     true,
    Deprecated: "use `rpk cluster` subcommands; see...",
}
```

It extracts:
- Command name (`Use` field)
- Hidden status (`Hidden: true`)
- Deprecation message (`Deprecated: "..."`)

### 2. Automatic Override Generation

When detected, the scanner automatically generates overrides in `rpk-overrides.json`:

```json
{
  "commands": {
    "rpk redpanda admin": {
      "deprecated": true,
      "deprecatedInVersion": "v26.x",
      "replacement": "Use xref:reference:rpk/rpk-cluster/rpk-cluster.adoc[`rpk cluster`] instead.",
      "deprecatedMessage": "use `rpk cluster` subcommands; see...",
      "_note": "Hidden: true, found by scanning Go source"
    }
  }
}
```

### 3. Template Rendering

The Handlebars template (`command.hbs`) automatically renders deprecation warnings:

```handlebars
{{#if deprecated}}
[CAUTION]
====
This command is deprecated{{#if deprecatedInVersion}} as of {{deprecatedInVersion}}{{/if}}.
{{#if replacement}} {{{replacement}}}{{/if}}
====
{{/if}}
```

This generates:

```asciidoc
[CAUTION]
====
This command is deprecated as of v26.x. Use xref:reference:rpk/rpk-cluster/rpk-cluster.adoc[`rpk cluster`] instead.
====
```

## Integration

The deprecation scanner runs automatically during documentation generation:

1. **After building rpk** - Source code is available
2. **Before generating docs** - Overrides are updated first
3. **Writes to overrides.json** - Automatically merges detected deprecations

To trigger manually:

```bash
# Scan source and update overrides
node tools/rpk-docs/scan-deprecated-commands.js \
  /path/to/redpanda/src/go/rpk \
  docs-data/rpk-overrides.json
```

## Currently Detected Commands

As of the latest scan (June 8, 2026):

1. `rpk benchmark` - Hidden (internal testing command)
2. `rpk cloud resourcegroup` - Hidden (internal/unreleased)
3. `rpk redpanda admin` - **Deprecated** in favor of `rpk cluster`
4. `rpk redpanda admin brokers` - **Deprecated** → use `rpk cluster brokers`
5. `rpk redpanda admin config` - **Deprecated** → use `rpk cluster config`
6. `rpk redpanda admin partitions` - **Deprecated** → use `rpk cluster info --detailed`

## Limitations

### Hidden Commands Not in Tree

Commands with `Hidden: true` don't appear in `rpk --print-tree` output, so:
- They won't be auto-generated from scratch
- Existing docs files are preserved
- Overrides contain metadata for future use

### Subcommand Detection

The scanner finds commands with their own `NewCommand()` function but doesn't detect subcommands added via `cmd.AddCommand()`. For example:

- ✅ Detects: `rpk redpanda admin` (has NewCommand in admin.go)
- ❌ Misses: `rpk redpanda admin brokers list` (subcommand of brokers)

**Workaround**: Manually add subcommand deprecations to overrides or enhance scanner to follow AddCommand calls.

## File Locations

- **Scanner**: `tools/rpk-docs/scan-deprecated-commands.js`
- **Integration**: `tools/rpk-docs/rpk-docs-handler.js` (Step 5)
- **Template**: `tools/rpk-docs/templates/command.hbs`
- **Overrides**: `docs-data/rpk-overrides.json`

## Future Enhancements

1. **Follow AddCommand chains** - Detect all subcommand deprecations
2. **Extract deprecation versions** - Parse version info from comments/git history
3. **Build xref links automatically** - Generate xrefs from deprecation messages
4. **Scan for removed commands** - Compare against previous versions to detect removals

## Example: rpk redpanda admin

### Source Code

```go
func NewCommand(fs afero.Fs, p *config.Params) *cobra.Command {
    cmd := &cobra.Command{
        Use:        "admin",
        Short:      "Talk to the Redpanda admin listener",
        Hidden:     true,
        Deprecated: "use `rpk cluster` subcommands; see `rpk cluster brokers`, `rpk cluster info --detailed`, `rpk cluster config list --node-id`, and `rpk cluster loggers`",
    }
    // ...
}
```

### Generated Override

```json
{
  "rpk redpanda admin": {
    "deprecated": true,
    "replacement": "Use xref:reference:rpk/rpk-cluster/rpk-cluster.adoc[`rpk cluster`] instead.",
    "deprecatedMessage": "use `rpk cluster` subcommands; see `rpk cluster brokers`, `rpk cluster info --detailed`, `rpk cluster config list --node-id`, and `rpk cluster loggers`",
    "_note": "Hidden: true, found by scanning Go source"
  }
}
```

### Generated Documentation

```asciidoc
= rpk redpanda admin
:unsupported-os: macOS, Windows

include::reference:partial$unsupported-os-rpk.adoc[]

[CAUTION]
====
This command is deprecated. Use xref:reference:rpk/rpk-cluster/rpk-cluster.adoc[`rpk cluster`] instead.
====

Talk to the Redpanda admin listener.
```

## Testing

Test the scanner:

```bash
# Test on local source
node tools/rpk-docs/scan-deprecated-commands.js ~/Documents/redpanda/src/go/rpk

# Test with override merging
node tools/rpk-docs/scan-deprecated-commands.js \
  ~/Documents/redpanda/src/go/rpk \
  docs-data/rpk-overrides.json
```

Test full automation:

```bash
cd /path/to/docs
npx doc-tools generate rpk-docs --ref dev
# Check for "Scanning source for deprecated/hidden commands..." in output
```
