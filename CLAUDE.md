# Redpanda Documentation Extensions and Automation

This repository contains tools that help write and maintain Redpanda's technical documentation. Think of it as a toolbox that automatically generates documentation from source code, so technical writers don't have to manually update documentation every time the software changes.

## What this repository does

This toolbox helps Redpanda's documentation team in several ways. When Redpanda releases a new version, these tools extract information from the code (like configuration options, commands, and features) and create documentation pages automatically. They provide reusable templates and shortcuts that ensure all docs look and work the same way. Instead of manually documenting hundreds of configuration options or commands, these tools do it automatically. The repository also includes a bridge that lets Claude Code (an AI assistant) help with documentation tasks through natural conversation.

## Documentation for this repository

### If you write documentation

The [Command Reference](CLI_REFERENCE.adoc) shows all the commands you can run to generate documentation. You'll learn how to get version numbers, generate different types of docs, and set up AI assistant integration.

The [AI Assistant User Guide](mcp/USER_GUIDE.adoc) explains how to use Claude Code to help with documentation. It includes step-by-step setup instructions, describes what tasks the AI can help with, and shows you how to troubleshoot problems.

The [AI Cost Guide](mcp/COSTS.adoc) breaks down how much it costs to use AI features. It shows the price per operation (ranging from $0.017 to $0.190), explains which AI model to choose for different tasks, and provides tips to reduce costs.

### If you build or maintain these tools

The [Contributing Guide](CONTRIBUTING.adoc) helps developers working on this codebase. It covers how to set up your development environment, run tests, and submit changes.

The [AI Integration Developer Guide](mcp/DEVELOPMENT.adoc) explains how the system is designed, how to add new AI-powered tools, and how to test your changes.

The [Command Interface Specification](mcp/CLI_INTERFACE.adoc) defines the technical contract for command-line tools. It specifies how commands should be structured, what output format to use, and how to handle errors.

The [Antora Extensions Guide](extensions/README.adoc) documents custom build system plugins. Antora is the documentation build system Redpanda uses. Extensions are add-ons that give Antora new capabilities. Examples include automatically fetching version numbers and generating navigation menus.

The [AsciiDoc Shortcuts Guide](macros/README.adoc) explains reusable documentation snippets. AsciiDoc is the markup language used for writing docs (like Markdown but more powerful). Macros are shortcuts that let you insert complex content with simple commands. Examples include tooltips for technical terms and links to configuration options.

## Automatic documentation generators

These tools read Redpanda's source code and automatically create documentation pages.

### Connector documentation generator

Location: [`tools/redpanda-connect/`](tools/redpanda-connect/)

Redpanda Connect has hundreds of connectors (plugins that connect to different systems like Kafka, databases, and cloud services). When new versions are released, connectors are added, removed, or changed. This tool automatically detects those changes and updates the documentation.

See the [AUTOMATION.md](tools/redpanda-connect/AUTOMATION.md) and [README.adoc](tools/redpanda-connect/README.adoc) for detailed documentation.

The tool works by running Redpanda Connect command-line tools to get a list of all connectors. It compares the list to the previous version to find what changed. Then it downloads the actual software to determine which connectors work in the cloud versus self-hosted environments. It creates documentation pages for each connector with all its configuration options. Finally, it generates a summary for pull requests showing what documentation needs updating.

Run it like this:

```bash
npx doc-tools generate rpcn-connector-docs --fetch-connectors
```

The tool includes several special features. Multi-version tracking means if you miss documenting several releases (say 4.81.0 through 4.85.0), it processes each release separately to correctly attribute which features appeared in which version. Platform detection automatically figures out if a connector works in Redpanda Cloud, self-hosted Redpanda, or both. Binary analysis detects connectors that require special compilation (CGO). Change summaries create a detailed summary of all changes across multiple releases for pull requests.

### Configuration properties generator

Location: [`tools/property-extractor/`](tools/property-extractor/)

Redpanda has hundreds of configuration settings (things like memory limits, timeout values, and security options). These are defined in C++ code. Instead of manually documenting each one, this tool reads the C++ code and generates documentation automatically.

See [README.adoc](tools/property-extractor/README.adoc) for detailed documentation.

The tool downloads Redpanda source code for a specific version, then parses the C++ code to find configuration property definitions. It extracts property names, default values, descriptions, and valid ranges. The tool creates both JSON data files and documentation pages. You can override auto-generated descriptions with custom text when needed.

Run it like this:

```bash
npx doc-tools generate property-docs --tag v25.3.1
```

The tool creates several files. `docs-data/cluster-properties-{version}.json` contains all cluster-level settings. `docs-data/topic-properties-{version}.json` contains all topic-level settings. `modules/.../partials/cluster-properties.adoc` is the documentation page for cluster settings. `modules/.../partials/topic-properties.adoc` is the documentation page for topic settings.

### Metrics documentation generator

Location: [`tools/metrics-extractor/`](tools/metrics-extractor/)

Redpanda exposes hundreds of metrics (measurements like CPU usage, message throughput, and disk I/O) for monitoring. These metrics are defined in C++ code. This tool automatically generates documentation for all metrics.

The tool downloads Redpanda source code and uses a specialized parser (Tree-sitter) to understand C++ code structure. It finds metric definitions in the code, extracts metric names, types, and descriptions, then generates reference documentation pages.

Run it like this:

```bash
npx doc-tools generate metrics-docs --tag v25.3.1
```

### Command-line tool documentation generator

Location: [`tools/gen-rpk-ascii.py`](tools/gen-rpk-ascii.py)

Redpanda's command-line tool (rpk) has dozens of commands with many options. Instead of manually documenting each command, this tool runs the commands to extract their help text and generates documentation.

The tool downloads Redpanda source code, builds the rpk command-line tool, runs each command with the `--help` flag to get usage information, then converts the help text into documentation pages.

Run it like this:

```bash
npx doc-tools generate rpk-docs --tag v25.3.1
```

### Helm chart documentation generator

Location: [`tools/generate-cli-docs.js`](tools/generate-cli-docs.js)

Helm charts are packages used to deploy Redpanda on Kubernetes. They have many configuration values. This tool reads the `values.yaml` file (where all options are defined) and generates documentation.

Run it like this:

```bash
npx doc-tools generate helm-spec --tag v25.1.2
```

### Kubernetes resource documentation generator

Kubernetes Custom Resource Definitions (CRDs) define how Redpanda integrates with Kubernetes. These are complex YAML structures. This tool generates documentation from the CRD definitions.

Run it like this:

```bash
npx doc-tools generate crd-spec --tag operator/v25.1.2
```

### Cloud regions table generator

Location: [`tools/cloud-regions/`](tools/cloud-regions/)

Redpanda Cloud is available in different regions (like us-east-1, eu-west-1) with different tiers (free, paid, enterprise). This information is stored in a YAML file. This tool converts it into a documentation table.

Run it like this:

```bash
npx doc-tools generate cloud-regions
```

### API documentation bundler

Location: [`tools/bundle-openapi.js`](tools/bundle-openapi.js)

Redpanda's API documentation is split into many small OpenAPI files. This tool combines them into single, complete API specification files that documentation tools can use.

Run it like this:

```bash
npx doc-tools generate bundle-openapi --tag v25.3.1 --surface both
```

## Command-line tools

These utility commands help with documentation tasks.

### Get version numbers

These commands check GitHub to find the latest version numbers, which you need when generating documentation.

```bash
# Find the latest Redpanda version
npx doc-tools get-redpanda-version

# Find the latest Redpanda Console version
npx doc-tools get-console-version
```

### Download files from GitHub

Sometimes you need files from GitHub repositories. This command downloads them for you.

```bash
# Download a specific directory from GitHub
npx doc-tools fetch \
  --owner redpanda-data \
  --repo redpanda \
  --remote-path src/v/config \
  --save-dir ./fetched
```

### Set up AI assistant integration

These commands configure Claude Code (an AI assistant) to work with these documentation tools.

```bash
# Connect Claude Code to these tools
npx doc-tools setup-mcp --local

# Check that everything is configured correctly
npx doc-tools validate-mcp

# See what version you have installed
npx doc-tools mcp-version
```

### Install testing tools

This installs everything needed to test the documentation tools (Docker images, Python packages, etc).

```bash
# Set up a complete testing environment
npx doc-tools install-test-dependencies
```

## Antora build system extensions

Location: [`extensions/`](extensions/)

Antora is the tool that builds Redpanda's documentation website from source files. These extensions add new capabilities to Antora.

See [extensions/README.adoc](extensions/README.adoc) for more details.

Version management extensions automatically fetch the latest version numbers from GitHub instead of hardcoding them. Content generation extensions create index pages, category lists, and other structured content automatically. Navigation extensions manage page visibility, redirects, and links between different versions. Third-party integration extensions connect to search engines (Algolia), show end-of-life banners, and suggest related content. File processing extensions package attachments, replace variables, and collect code samples.

## AsciiDoc shortcuts (macros)

Location: [`macros/`](macros/)

Shortcuts let you insert complex documentation elements with simple commands. AsciiDoc is the markup language used for writing Redpanda docs (similar to Markdown but more powerful).

See [macros/README.adoc](macros/README.adoc) for more details.

The `glossterm` macro adds tooltips that explain technical terms when users hover over them. The `config_ref` macro creates links to configuration property documentation. The `helm_ref` macro creates links to Helm chart configuration values. The `components_by_category` macro shows all Redpanda Connect connectors organized by category. The `component_table` macro creates a searchable table of connectors.

## AI assistant integration (MCP server)

Location: [`mcp/`](mcp/)

A bridge connects Claude Code (an AI assistant) to these documentation tools. Once you set it up, you can ask Claude to generate documentation in plain English instead of memorizing commands.

See [mcp/README.adoc](mcp/README.adoc) for more details.

Set it up like this:

```bash
cd /path/to/docs-extensions-and-macros
npm install
npx doc-tools setup-mcp --local
```

Claude can perform several tasks for you. The `get_redpanda_version` tool looks up the latest version numbers. The `generate_property_docs` tool creates configuration property documentation. The `generate_metrics_docs` tool creates metrics documentation. The `generate_rpk_docs` tool creates command-line tool documentation. The `generate_rpcn_connector_docs` tool creates connector documentation. The `generate_helm_docs` tool creates Helm chart documentation. The `generate_crd_docs` tool creates Kubernetes resource documentation. The `generate_bundle_openapi` tool bundles API documentation. The `generate_cloud_regions` tool creates cloud regions tables. The `review_generated_docs` tool checks generated documentation for quality issues. The `get_antora_structure` tool analyzes the documentation repository structure.

Example conversation:

```
You: "What's the latest Redpanda version?"
Claude: "Let me check... The latest version is v25.3.1"

You: "Generate property docs for that version"
Claude: "I'll generate the configuration property documentation for v25.3.1..."
        [runs the command and shows you the results]
```

## Installation

### Using these tools in your documentation project

If you maintain a Redpanda documentation site and want to use these tools:

```bash
npm install @redpanda-data/docs-extensions-and-macros
```

### Setting up for development

If you want to improve these tools or fix bugs, download the code and install dependencies:

```bash
# Download the code
git clone git@github.com:redpanda-data/docs-extensions-and-macros.git
cd docs-extensions-and-macros

# Install dependencies
npm install

# Run tests to make sure everything works
npm test
```

### Using your local changes in another project

If you're working on these tools and want to test them in a documentation project, create a link in this repository, then use the link in your documentation project:

```bash
# In this repository, create a link
cd docs-extensions-and-macros
npm link

# In your documentation project, use the link
cd ../your-docs-repo
npm link @redpanda-data/docs-extensions-and-macros
```

## Testing

Run all tests:

```bash
npm test
```

Test only AI integration features:

```bash
npm test -- __tests__/mcp/
```

Test only documentation generators:

```bash
npm test -- __tests__/tools/
```

Run tests and see how much code is covered by tests:

```bash
npm run test:coverage
```

## How this repository is organized

```
docs-extensions-and-macros/
├── bin/
│   └── doc-tools.js          # Main command-line entry point
├── extensions/               # Antora build system plugins
│   ├── version-fetcher/      # Auto-fetch version numbers
│   ├── config-ref/           # Link to config properties
│   └── ...
├── macros/                   # AsciiDoc shortcuts
│   ├── glossary/             # Tooltip definitions
│   ├── config-ref/           # Config property links
│   └── ...
├── mcp/                      # AI assistant integration
│   ├── server.js             # MCP server implementation
│   ├── USER_GUIDE.adoc       # How to use AI features
│   ├── DEVELOPMENT.adoc      # How to build AI features
│   └── ...
├── tools/                    # Documentation generators
│   ├── redpanda-connect/     # Connector docs automation
│   ├── property-extractor/   # Config properties automation
│   ├── metrics-extractor/    # Metrics automation
│   ├── cloud-regions/        # Cloud regions table
│   └── ...
├── cli-utils/                # Shared command-line utilities
├── __tests__/                # Automated tests
├── CLI_REFERENCE.adoc        # Complete command reference
└── README.adoc               # Main repository documentation
```

## Contributing

See [CONTRIBUTING.adoc](CONTRIBUTING.adoc) for information on how to set up your development environment, coding standards to follow, how to write tests, and how to submit your changes.

## Getting help

Found a bug? [Report it on GitHub Issues](https://github.com/redpanda-data/docs-extensions-and-macros/issues).

Have a question? [Ask on GitHub Issues](https://github.com/redpanda-data/docs-extensions-and-macros/issues).

Want a new feature? [Suggest it on GitHub Issues](https://github.com/redpanda-data/docs-extensions-and-macros/issues).
