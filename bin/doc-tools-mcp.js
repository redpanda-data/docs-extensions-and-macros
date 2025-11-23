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

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yaml = require('js-yaml');

/**
 * Find the repository root from current working directory
 */
function findRepoRoot(start = process.cwd()) {
  let dir = start;
  while (dir !== path.parse(dir).root) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return start; // Fallback to current directory
}

/**
 * Get Antora structure information for the current repository
 */
function getAntoraStructure(repoRoot) {
  const playbooks = [
    'local-antora-playbook.yml',
    'antora-playbook.yml',
    'docs-playbook.yml'
  ].map(name => path.join(repoRoot, name))
   .find(p => fs.existsSync(p));

  let playbookContent = null;
  if (playbooks) {
    try {
      playbookContent = yaml.load(fs.readFileSync(playbooks, 'utf8'));
    } catch (err) {
      // Playbook parsing error, continue without it
    }
  }

  // Find all antora.yml files
  const antoraYmls = [];
  const findAntoraYmls = (dir, depth = 0) => {
    if (depth > 3 || !fs.existsSync(dir)) return; // Limit recursion depth
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'docs') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          findAntoraYmls(fullPath, depth + 1);
        } else if (entry.name === 'antora.yml') {
          antoraYmls.push(fullPath);
        }
      }
    } catch (err) {
      // Permission error or other issue, skip
    }
  };
  findAntoraYmls(repoRoot);

  // Parse each antora.yml
  const components = antoraYmls.map(ymlPath => {
    try {
      const content = yaml.load(fs.readFileSync(ymlPath, 'utf8'));
      const componentDir = path.dirname(ymlPath);
      const modulesDir = path.join(componentDir, 'modules');
      const modules = fs.existsSync(modulesDir)
        ? fs.readdirSync(modulesDir).filter(m => {
            const stat = fs.statSync(path.join(modulesDir, m));
            return stat.isDirectory();
          })
        : [];

      return {
        name: content.name,
        version: content.version,
        title: content.title,
        path: componentDir,
        modules: modules.map(moduleName => {
          const modulePath = path.join(modulesDir, moduleName);
          return {
            name: moduleName,
            path: modulePath,
            pages: fs.existsSync(path.join(modulePath, 'pages')),
            partials: fs.existsSync(path.join(modulePath, 'partials')),
            examples: fs.existsSync(path.join(modulePath, 'examples')),
            attachments: fs.existsSync(path.join(modulePath, 'attachments')),
            images: fs.existsSync(path.join(modulePath, 'images')),
          };
        }),
      };
    } catch (err) {
      return { error: `Failed to parse ${ymlPath}: ${err.message}` };
    }
  });

  return {
    repoRoot,
    playbook: playbookContent,
    components,
    hasDocTools: fs.existsSync(path.join(repoRoot, 'package.json')) &&
                 fs.existsSync(path.join(repoRoot, 'bin', 'doc-tools.js'))
  };
}

/**
 * Execute a tool and return results
 */
function executeTool(toolName, args) {
  const repoRoot = findRepoRoot();

  try {
    switch (toolName) {
      case 'get_antora_structure': {
        return getAntoraStructure(repoRoot);
      }

      case 'run_doc_tools_command': {
        const structure = getAntoraStructure(repoRoot);

        if (!structure.hasDocTools) {
          return {
            error: 'doc-tools not found in this repository. This command only works in repos with doc-tools installed.',
            suggestion: 'Navigate to the docs-extensions-and-macros repository or a repo that has doc-tools as a dependency.'
          };
        }

        const cmd = `npx doc-tools ${args.command}`;

        try {
          const output = execSync(cmd, {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: 'pipe',
            maxBuffer: 50 * 1024 * 1024
          });
          return { success: true, output, command: cmd };
        } catch (err) {
          return {
            error: err.message,
            output: (err.stdout || '') + (err.stderr || ''),
            exitCode: err.status,
            command: cmd
          };
        }
      }

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { error: err.message, stack: err.stack };
  }
}

// Get version from package.json
const packageJson = require('../package.json');

// Create the MCP server
const server = new Server(
  {
    name: 'redpanda-docs-tools',
    version: packageJson.version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions - only domain-specific tools
const tools = [
  {
    name: 'get_antora_structure',
    description: 'Get information about the Antora documentation structure in the current repository, including components, modules, and available directories. Use this to understand the docs organization before making changes.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'run_doc_tools_command',
    description: 'Run a doc-tools automation command using "npx doc-tools <command>". Only works in repositories that have doc-tools. Common commands: "generate property-docs --tag v25.3.1", "generate metrics-docs --tag v25.3.1", "generate rp-connect-docs --branch main".',
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
  }
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

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

  // Log to stderr so it doesn't interfere with MCP protocol on stdout
  console.error('Redpanda Docs MCP Server running');
  console.error(`Working directory: ${process.cwd()}`);
  console.error(`Repository root: ${findRepoRoot()}`);
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
