# Sitemap to Markdown Converter Extension

Automatically generates human-readable and AI-friendly markdown versions of sitemap.xml files.

## Purpose

This extension converts sitemap.xml files into sitemap.md files that are:
- **Human-readable**: Easy to browse documentation structure
- **AI-friendly**: Perfect for LLMs to understand site organization
- **SEO-complementary**: Markdown version supplements XML for search engines

## Usage

Add to your Antora playbook:

```yaml
antora:
  extensions:
  - require: '@redpanda-data/docs-extensions-and-macros/extensions/convert-sitemap-to-markdown'
```

## What It Does

For each sitemap XML file in your published site, the extension:

1. **Finds all sitemaps**: Detects `sitemap.xml`, `sitemap-0.xml`, `sitemap-1.xml`, etc.
2. **Parses the XML** using xml2js
3. **Organizes URLs** by path/component
4. **Generates individual markdown files** for each sitemap:
   - Grouped sections by component
   - Human-readable page titles
   - Metadata (last modified, change frequency, priority)
   - Direct links to pages
5. **Creates master sitemap** (`sitemap-all.md`): When multiple sitemaps exist, generates a combined view of all pages

## Generated Format

### For Standard Sitemaps

```markdown
# Sitemap

> Documentation sitemap generated from sitemap.xml

## Pages

Total pages: 1234

### Current

- [Get Started](https://docs.redpanda.com/current/get-started/) (modified: 2026-03-29)
- [Quick Start](https://docs.redpanda.com/current/get-started/quick-start/) (modified: 2026-03-28)

### Redpanda Cloud

- [Cloud Overview](https://docs.redpanda.com/redpanda-cloud/) (modified: 2026-03-27)
...
```

### For Sitemap Indexes

```markdown
# Sitemap

> Documentation sitemap generated from sitemap.xml

## Sitemap Index

This sitemap index contains 5 sub-sitemap(s):

- [sitemap-0.xml](https://docs.redpanda.com/sitemap-0.xml) (modified: 2026-03-29)
- [sitemap-1.xml](https://docs.redpanda.com/sitemap-1.xml) (modified: 2026-03-29)
...
```

## Benefits

✅ **AI Discovery**: LLMs can quickly understand documentation structure
✅ **Human Browsing**: Easy to navigate complete site map
✅ **Automated**: No manual maintenance required
✅ **Complementary**: Works alongside XML sitemaps for SEO
✅ **Metadata Rich**: Includes modification dates and page organization

## Technical Details

- **Event**: Runs on `beforePublish` event
- **Dependencies**: xml2js for XML parsing
- **Performance**: Fast - processes all sitemaps in <1 second
- **Output**: Creates `.md` file alongside each `.xml` file

## Example Output

### Individual Sitemap Files

Given multiple sitemaps:
- `/docs/sitemap.xml` → `/docs/sitemap.md` (sitemap index)
- `/docs/sitemap-0.xml` → `/docs/sitemap-0.md` (first 1000 pages)
- `/docs/sitemap-1.xml` → `/docs/sitemap-1.md` (next 1000 pages)
- etc.

### Master Combined Sitemap

The extension also creates `/docs/sitemap-all.md` combining all pages:

```markdown
# Complete Documentation Sitemap

> Combined view of all 2145 documentation pages from 3 sitemap(s)

## Source Sitemaps

- [sitemap.xml](sitemap.md)
- [sitemap-0.xml](sitemap-0.md)
- [sitemap-1.xml](sitemap-1.md)

## Pages

Total pages: 2145

### Current
- [Home](https://docs.redpanda.com/current/) (modified: 2026-03-29)
- [Get Started](https://docs.redpanda.com/current/get-started/) (modified: 2026-03-29)
...
```

### Individual Sitemap Example

Each individual sitemap markdown file (e.g., `sitemap-0.md`):

```markdown
# Sitemap

> Documentation sitemap generated from sitemap.xml

## Pages

Total pages: 432

### Current
- [Home](https://docs.redpanda.com/current/) (modified: 2026-03-29, priority: 1.0)
- [Get Started](https://docs.redpanda.com/current/get-started/) (modified: 2026-03-29, priority: 0.9)
- [Deploy](https://docs.redpanda.com/current/deploy/) (modified: 2026-03-28, priority: 0.9)

### Redpanda Cloud
- [Cloud Home](https://docs.redpanda.com/redpanda-cloud/) (modified: 2026-03-27, priority: 0.9)
- [Quick Start](https://docs.redpanda.com/redpanda-cloud/get-started/) (modified: 2026-03-26, priority: 0.8)

### Redpanda Connect
- [Connect Home](https://docs.redpanda.com/redpanda-connect/) (modified: 2026-03-25, priority: 0.9)
- [Components](https://docs.redpanda.com/redpanda-connect/components/) (modified: 2026-03-24, priority: 0.8)
```

## Use Cases

1. **AI Agents**: Provide sitemap.md to LLMs for quick site navigation
2. **Documentation Planning**: Review complete site structure at a glance
3. **Content Audits**: Identify gaps or outdated content by date
4. **User Discovery**: Help users find content through browseable map
5. **Quality Checks**: Verify all expected pages are published

## Implementation

- **Extension**: `extensions/convert-sitemap-to-markdown.js`
- **Dependencies**: xml2js (automatically installed)
- **Config**: No configuration needed - works out of the box
