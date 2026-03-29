# llms.txt and Sitemap Setup

This document explains how to set up the llms.txt and sitemap for Redpanda documentation.

## Overview

The Redpanda documentation provides AI-optimized formats including:

- **llms.txt**: Curated overview following the llms.txt standard
- **llms-full.txt**: Complete documentation export
- **Component-specific exports**: ROOT-full.txt, cloud-full.txt, etc.
- **sitemap.adoc**: Comprehensive documentation structure reference

## Setup Instructions

### 1. Add llms.adoc to docs repository

In the `docs` repository (https://github.com/redpanda-data/docs), create or update:

**File**: `modules/home/pages/llms.adoc`

```asciidoc
# Redpanda Documentation

> Redpanda is a streaming data platform for developers. Build real-time applications without the complexity of Apache Kafka.

## About This Documentation

Redpanda documentation is available at {site-url} and provides comprehensive guides for:

- **Self-Managed Redpanda**: Deploy and manage Redpanda on your own infrastructure
- **Redpanda Cloud**: Fully-managed serverless streaming platform
- **Redpanda Connect**: High-performance data pipeline tool
- **Redpanda Console**: Web UI for managing and monitoring clusters

## AI-Optimized Documentation Access

### Interactive MCP Server

**https://docs.redpanda.com/mcp** - Model Context Protocol server for Claude Code

The Redpanda Documentation MCP server provides AI agents with tools to:

- Generate reference documentation (property docs, metrics, CLI commands, connectors)
- Access versioned content and API specifications
- Query documentation structure and navigate components
- Validate configurations and check compatibility

**Setup for Claude Code:**
```bash
npx doc-tools setup-mcp
```

After setup, restart Claude Code to load the server.

### Static Exports

- **{site-url}/llms.txt**: This curated overview
- **{site-url}/llms-full.txt**: Complete documentation export
- **{site-url}/ROOT-full.txt**: Self-Managed documentation only
- **{site-url}/cloud-full.txt**: Cloud documentation only
- **{site-url}/redpanda-connect-full.txt**: Connect documentation only
- **Individual markdown pages**: Each HTML page has a .md equivalent

[Continue with sections about Documentation Structure, Key Topics, etc.]
```

### 2. Add sitemap.adoc to docs repository

**File**: `modules/home/pages/sitemap.adoc`

Create a comprehensive sitemap documenting:
- All documentation components
- Version structure
- Key topic areas
- Navigation patterns
- AI-optimized formats

See the complete template in `preview/home/modules/ROOT/pages/sitemap.adoc` in this repository.

### 3. Configure playbook

Ensure your Antora playbook includes the required extensions:

```yaml
antora:
  extensions:
  - require: '@redpanda-data/docs-extensions-and-macros/extensions/convert-to-markdown'
  - require: '@redpanda-data/docs-extensions-and-macros/extensions/convert-llms-to-txt'
  - require: '@redpanda-data/docs-extensions-and-macros/extensions/add-pages-to-root'
    files:
    - home:ROOT:attachment$sitemap.adoc  # Optional: add sitemap to root
```

### 4. Verify generation

After building the site:

1. **Check llms.txt**: `{site-url}/llms.txt` should contain the curated overview
2. **Check llms-full.txt**: `{site-url}/llms-full.txt` should contain all pages
3. **Check component exports**: `{site-url}/ROOT-full.txt`, etc.
4. **Check markdown pages**: Every HTML page should have a .md file

## How It Works

### Extension Flow

1. **convert-to-markdown**: Converts all HTML pages to markdown, stores in `page.markdownContents`
2. **convert-llms-to-txt**:
   - Extracts markdown from llms.adoc page
   - Generates llms-full.txt from all markdown pages
   - Generates component-specific full.txt files
   - Places all at site root

### Attributes

The llms.adoc page can use:

- `{site-url}`: Replaced with playbook.site.url or DEPLOY_PRIME_URL (for previews)
- Any global attributes from add-global-attributes extension

### Content Updates

To update llms.txt content:

1. Edit `modules/home/pages/llms.adoc` in the docs repository
2. Rebuild the documentation
3. llms.txt will be regenerated automatically

## MCP Server Information

The MCP server at **https://docs.redpanda.com/mcp** provides:

### Available Tools

- **generate_property_docs**: Generate Redpanda configuration property documentation
- **generate_metrics_docs**: Generate metrics reference documentation
- **generate_rpk_docs**: Generate rpk CLI reference documentation
- **generate_rpcn_connector_docs**: Generate Redpanda Connect connector documentation
- **generate_helm_docs**: Generate Helm chart documentation
- **generate_crd_docs**: Generate Kubernetes CRD documentation
- **generate_bundle_openapi**: Bundle OpenAPI specifications
- **get_redpanda_version**: Get latest Redpanda version information
- **get_console_version**: Get latest Console version information
- **get_antora_structure**: Get documentation component structure

### Setup

Writers can set up the MCP server with:

```bash
npx doc-tools setup-mcp
```

This configures Claude Code to use the doc-tools MCP server for documentation automation.

### Usage

After setup, Claude Code can:

- Generate reference documentation: "Generate property docs for v25.3.1"
- Check versions: "What's the latest Redpanda version?"
- Query structure: "Show me the Antora component structure"
- Access documentation: "Generate metrics docs for the latest version"

## Testing

To test the llms.txt generation locally:

1. Build documentation with test-git-dates-playbook.yml or local-antora-playbook.yml
2. Check `docs/llms.txt` exists
3. Verify content includes MCP server information
4. Check markdown exports are working

## Reference Templates

Complete reference templates are available in this repository:

- `preview/home/modules/ROOT/pages/llms.adoc`: llms.txt content template
- `preview/home/modules/ROOT/pages/sitemap.adoc`: Sitemap template

Copy these to the docs repository and customize as needed.
