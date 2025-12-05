#!/usr/bin/env node

/**
 * MCP Server for Redpanda Documentation Tools
 *
 * This server exposes domain-specific documentation tools to Claude Code
 * via the Model Context Protocol.
 *
 * Features:
 * - Context-aware: Works from any repository based on cwd
 * - Antora intelligence: Understands component/module structure
 * - Automation: Run doc-tools generate commands
 */

const fs = require('fs');
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { findRepoRoot, executeTool } = require('./mcp-tools');
const { initializeJobQueue, getJob, listJobs } = require('./mcp-tools/job-queue');

// Get version from package.json
const packageJson = require('../package.json');

// Create the MCP server
const server = new Server(
  {
    name: 'redpanda-doc-tools-assistant',
    version: packageJson.version,
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
  }
);

// Tool definitions - Writer-friendly documentation tools
const tools = [
  {
    name: 'get_antora_structure',
    description: 'Get information about the Antora documentation structure in the current repository, including components, modules, and available directories. Use this to understand the docs organization.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_redpanda_version',
    description: 'Get the latest Redpanda version information including version number, Docker tag, and release notes URL. Writers use this to find out what version to document.',
    inputSchema: {
      type: 'object',
      properties: {
        beta: {
          type: 'boolean',
          description: 'Whether to get the latest beta/RC version instead of stable (optional, defaults to false)'
        }
      },
      required: []
    }
  },
  {
    name: 'get_console_version',
    description: 'Get the latest Redpanda Console version information including version number, Docker tag, and release notes URL.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'generate_property_docs',
    description: 'Generate Redpanda configuration property documentation for a specific version. Creates JSON and optionally AsciiDoc partials with all configuration properties. Writers use this when updating docs for a new Redpanda release. Can run in background with progress streaming.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: 'Git tag for released content (e.g., "25.3.1", "v25.3.1", or "latest"). Auto-prepends "v" if not present. Use tags for GA or beta releases.'
        },
        branch: {
          type: 'string',
          description: 'Branch name for in-progress content (e.g., "dev", "main"). Use branches for documentation under development.'
        },
        generate_partials: {
          type: 'boolean',
          description: 'Whether to generate AsciiDoc partials (cluster-properties.adoc, topic-properties.adoc, etc.). Default: false (only generates JSON)'
        },
        background: {
          type: 'boolean',
          description: 'Run as background job with progress updates. Returns job ID immediately instead of waiting. Default: false (run synchronously)'
        }
      },
      required: []
    }
  },
  {
    name: 'generate_metrics_docs',
    description: 'Generate Redpanda metrics documentation for a specific version. Creates the public metrics reference page. Writers use this when updating metrics docs for a new release. Can run in background with progress streaming.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: 'Git tag for released content (e.g., "25.3.1" or "v25.3.1"). Auto-prepends "v" if not present. Use tags for GA or beta releases.'
        },
        branch: {
          type: 'string',
          description: 'Branch name for in-progress content (e.g., "dev", "main"). Use branches for documentation under development.'
        },
        background: {
          type: 'boolean',
          description: 'Run as background job with progress updates. Returns job ID immediately instead of waiting. Default: false (run synchronously)'
        }
      },
      required: []
    }
  },
  {
    name: 'generate_rpk_docs',
    description: 'Generate RPK command-line documentation for a specific version. Creates AsciiDoc files for all rpk commands. Writers use this when updating CLI docs for a new release. Can run in background with progress streaming.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: 'Git tag for released content (e.g., "25.3.1" or "v25.3.1"). Auto-prepends "v" if not present. Use tags for GA or beta releases.'
        },
        branch: {
          type: 'string',
          description: 'Branch name for in-progress content (e.g., "dev", "main"). Use branches for documentation under development.'
        },
        background: {
          type: 'boolean',
          description: 'Run as background job with progress updates. Returns job ID immediately instead of waiting. Default: false (run synchronously)'
        }
      },
      required: []
    }
  },
  {
    name: 'generate_rpcn_connector_docs',
    description: 'Generate Redpanda Connect connector documentation. Creates component documentation for all connectors. Writers use this when updating connector reference docs.',
    inputSchema: {
      type: 'object',
      properties: {
        fetch_connectors: {
          type: 'boolean',
          description: 'Fetch latest connector data using rpk (optional, defaults to false)'
        },
        draft_missing: {
          type: 'boolean',
          description: 'Generate full-doc drafts for connectors missing in output (optional, defaults to false)'
        },
        update_whats_new: {
          type: 'boolean',
          description: 'Update whats-new.adoc with new section from diff JSON (optional, defaults to false)'
        },
        include_bloblang: {
          type: 'boolean',
          description: 'Include Bloblang functions and methods in generation (optional, defaults to false)'
        },
        data_dir: {
          type: 'string',
          description: 'Directory where versioned connect JSON files live (optional)'
        },
        old_data: {
          type: 'string',
          description: 'Optional override for old data file (for diff)'
        },
        csv: {
          type: 'string',
          description: 'Path to connector metadata CSV file (optional)'
        },
        overrides: {
          type: 'string',
          description: 'Path to optional JSON file with overrides'
        }
      },
      required: []
    }
  },
  {
    name: 'generate_helm_docs',
    description: 'Generate Helm chart documentation. Creates AsciiDoc documentation for Helm charts from local directories or GitHub repositories. Writers use this when updating Helm chart reference docs.',
    inputSchema: {
      type: 'object',
      properties: {
        chart_dir: {
          type: 'string',
          description: 'Chart directory (contains Chart.yaml) or root containing multiple charts, or a GitHub URL (optional, defaults to Redpanda operator charts)'
        },
        tag: {
          type: 'string',
          description: 'Git tag for released content when using GitHub URL (e.g., "25.1.2" or "v25.1.2"). Auto-prepends "v" if not present. For redpanda-operator repository, also auto-prepends "operator/".'
        },
        branch: {
          type: 'string',
          description: 'Branch name for in-progress content when using GitHub URL (e.g., "dev", "main").'
        },
        readme: {
          type: 'string',
          description: 'Relative README.md path inside each chart dir (optional, defaults to "README.md")'
        },
        output_dir: {
          type: 'string',
          description: 'Where to write all generated AsciiDoc files (optional, defaults to "modules/reference/pages")'
        },
        output_suffix: {
          type: 'string',
          description: 'Suffix to append to each chart name including extension (optional, defaults to "-helm-spec.adoc")'
        }
      },
      required: []
    }
  },
  {
    name: 'generate_cloud_regions',
    description: 'Generate cloud regions table documentation. Creates a Markdown or AsciiDoc table of cloud regions and tiers from GitHub YAML data. Writers use this when updating cloud region documentation.',
    inputSchema: {
      type: 'object',
      properties: {
        output: {
          type: 'string',
          description: 'Output file path relative to repo root (optional, defaults to "cloud-controlplane/x-topics/cloud-regions.md")'
        },
        format: {
          type: 'string',
          description: 'Output format: "md" (Markdown) or "adoc" (AsciiDoc) (optional, defaults to "md")',
          enum: ['md', 'adoc']
        },
        owner: {
          type: 'string',
          description: 'GitHub repository owner (optional, defaults to "redpanda-data")'
        },
        repo: {
          type: 'string',
          description: 'GitHub repository name (optional, defaults to "cloudv2-infra")'
        },
        path: {
          type: 'string',
          description: 'Path to YAML file in repository (optional)'
        },
        ref: {
          type: 'string',
          description: 'Git reference - branch, tag, or commit SHA (optional, defaults to "integration")'
        },
        template: {
          type: 'string',
          description: 'Path to custom Handlebars template relative to repo root (optional)'
        },
        dry_run: {
          type: 'boolean',
          description: 'Print output to stdout instead of writing file (optional, defaults to false)'
        }
      },
      required: []
    }
  },
  {
    name: 'generate_crd_docs',
    description: 'Generate Kubernetes CRD (Custom Resource Definition) documentation. Creates AsciiDoc documentation for Kubernetes operator CRDs. Writers use this when updating operator reference docs.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: 'Operator release tag (e.g., "operator/v25.1.2", "25.1.2", or "v25.1.2"). Auto-prepends "operator/" for redpanda-operator repository.'
        },
        branch: {
          type: 'string',
          description: 'Branch name for in-progress content (e.g., "dev", "main").'
        },
        source_path: {
          type: 'string',
          description: 'CRD Go types directory or GitHub URL (optional, defaults to Redpanda operator repo)'
        },
        depth: {
          type: 'number',
          description: 'How many levels deep to generate (optional, defaults to 10)'
        },
        templates_dir: {
          type: 'string',
          description: 'Asciidoctor templates directory (optional)'
        },
        output: {
          type: 'string',
          description: 'Where to write the generated AsciiDoc file (optional, defaults to "modules/reference/pages/k-crd.adoc")'
        }
      },
      required: []
    }
  },
  {
    name: 'generate_bundle_openapi',
    description: 'Bundle Redpanda OpenAPI fragments. Creates complete OpenAPI 3.1 documents for admin and/or connect APIs by bundling fragments from the Redpanda repository. Writers use this when updating API reference docs.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: {
          type: 'string',
          description: 'Git tag for released content (e.g., "v24.3.2" or "24.3.2"). Use tags for GA or beta releases.'
        },
        branch: {
          type: 'string',
          description: 'Branch name for in-progress content (e.g., "dev", "main"). Use branches for documentation under development.'
        },
        repo: {
          type: 'string',
          description: 'Repository URL (optional, defaults to Redpanda repo)'
        },
        surface: {
          type: 'string',
          description: 'Which API surface(s) to bundle (optional, defaults to "both")',
          enum: ['admin', 'connect', 'both']
        },
        out_admin: {
          type: 'string',
          description: 'Output path for admin API (optional, defaults to "admin/redpanda-admin-api.yaml")'
        },
        out_connect: {
          type: 'string',
          description: 'Output path for connect API (optional, defaults to "connect/redpanda-connect-api.yaml")'
        },
        admin_major: {
          type: 'string',
          description: 'Admin API major version (optional, defaults to "v2.0.0")'
        },
        use_admin_major_version: {
          type: 'boolean',
          description: 'Use admin major version for info.version instead of git tag (optional, defaults to false)'
        },
        quiet: {
          type: 'boolean',
          description: 'Suppress logs (optional, defaults to false)'
        }
      },
      required: []
    }
  },
  {
    name: 'review_generated_docs',
    description: 'Review recently generated documentation for quality issues. Checks for missing descriptions, invalid formatting, DRY violations, and other quality problems. Uses the quality criteria from the property-docs-guide and rpcn-connector-docs-guide prompts. Can generate a formatted markdown report for easy review.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_type: {
          type: 'string',
          description: 'Type of documentation to review',
          enum: ['properties', 'metrics', 'rpk', 'rpcn_connectors']
        },
        version: {
          type: 'string',
          description: 'Version of the docs to review (required for properties, metrics, rpk; e.g., "25.3.1" or "v25.3.1")'
        },
        generate_report: {
          type: 'boolean',
          description: 'Generate a formatted markdown report file for easy review (default: true)'
        }
      },
      required: ['doc_type']
    }
  },
  {
    name: 'run_doc_tools_command',
    description: 'Advanced: Run a raw doc-tools command. Only use this if none of the specific tools above fit your needs. Requires knowledge of doc-tools CLI syntax.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The doc-tools command to run (without "npx doc-tools" prefix)'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'get_job_status',
    description: 'Get the status and progress of a background job. Use this to check on long-running documentation generation tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: {
          type: 'string',
          description: 'Job ID returned when the job was created'
        }
      },
      required: ['job_id']
    }
  },
  {
    name: 'list_jobs',
    description: 'List all background jobs with optional filtering. Use this to see recent documentation generation jobs and their status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by job status (optional)',
          enum: ['pending', 'running', 'completed', 'failed']
        },
        tool: {
          type: 'string',
          description: 'Filter by tool name (optional)'
        }
      },
      required: []
    }
  }
];

// Prompt definitions - Contextual guides for complex workflows
const prompts = [
  {
    name: 'property-docs-guide',
    description: 'Comprehensive guide for updating Redpanda property documentation using the override system. Use this when working with configuration properties.',
    arguments: []
  },
  {
    name: 'rpcn-connector-docs-guide',
    description: 'Comprehensive guide for updating Redpanda Connect connector reference documentation using the overrides system with $ref syntax. Use this when working with connector documentation.',
    arguments: []
  }
];

/**
 * Load prompt content from markdown file
 * @param {string} name - Name of the prompt
 * @returns {string} Prompt content
 */
function getPromptContent(name) {
  // Validate name to prevent path traversal
  if (!name || typeof name !== 'string' || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid prompt name: ${name}`);
  }

  const promptPath = path.join(__dirname, '..', 'mcp', 'prompts', `${name}.md`);
  try {
    return fs.readFileSync(promptPath, 'utf8');
  } catch (err) {
    console.error(`Error loading prompt ${name}: ${err.message}`);
    throw new Error(`Prompt not found: ${name}`);
  }
}

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle list prompts request
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts };
});

// Handle get prompt request
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === 'property-docs-guide') {
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: getPromptContent('property-docs-guide')
          }
        }
      ]
    };
  }

  if (name === 'rpcn-connector-docs-guide') {
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: getPromptContent('rpcn-connector-docs-guide')
          }
        }
      ]
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Handle job management tools
  if (name === 'get_job_status') {
    const job = getJob(args.job_id);
    if (!job) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `Job not found: ${args.job_id}`,
              suggestion: 'Check the job ID or use list_jobs to see available jobs'
            }, null, 2)
          }
        ]
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            job
          }, null, 2)
        }
      ]
    };
  }

  if (name === 'list_jobs') {
    const jobs = listJobs(args || {});
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            jobs,
            total: jobs.length
          }, null, 2)
        }
      ]
    };
  }

  // Handle regular tools
  const result = executeTool(name, args || {});

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }
    ]
  };
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Initialize job queue with server instance for progress notifications
  initializeJobQueue(server);

  // Log to stderr so it doesn't interfere with MCP protocol on stdout
  const repoInfo = findRepoRoot();
  console.error('Redpanda Doc Tools MCP Server running');
  console.error(`Server version: ${packageJson.version}`);
  console.error(`Working directory: ${process.cwd()}`);
  console.error(`Repository root: ${repoInfo.root} (${repoInfo.detected ? repoInfo.type : 'not detected'})`);
  console.error('Background job queue: enabled');
  console.error('Command timeout: 10 minutes');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
