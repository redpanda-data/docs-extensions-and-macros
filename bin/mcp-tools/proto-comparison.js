/**
 * MCP Tools - Proto Description Comparison
 *
 * Compares OpenAPI specs in api-docs with proto-generated versions
 * from source repositories to identify description discrepancies.
 *
 * Supports:
 * - Admin API (redpanda repo)
 * - Control Plane API (cloudv2 repo)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const {
  findRepository,
  findRepoRoot,
  executeCommand,
  getDocToolsCommand,
  getCurrentBranch,
  validateRepoState
} = require('./utils');
const {
  PROTO_FILE_MAPS,
  findRpcLineNumber,
  extractCurrentDescription,
  findPreviewServices,
  filterPreviewChanges,
  checkRpcCommentFormat,
  findProtoFileForService
} = require('./proto-analysis');

/**
 * Find manual (non-bot) commits in api-docs repository
 * @param {string} apiDocsPath - Path to api-docs repo
 * @param {string} specFile - Relative path to spec file
 * @param {Object} options - Filtering options
 * @param {string} [options.since] - Only commits since this date (default: '2 weeks ago')
 * @param {number} [options.maxCommits] - Maximum commits to return (default: 20)
 * @returns {Array<Object>} Array of manual commits with metadata
 */
function findManualCommits(apiDocsPath, specFile, options = {}) {
  const since = options.since || '2 weeks ago';
  const maxCommits = options.maxCommits || 20;

  try {
    // Git command to get commit history
    const gitArgs = [
      'log',
      '--format=%H|%an|%ae|%aI|%s',  // Hash|Author|Email|Date|Subject
      `--since=${since}`,
      `--max-count=${maxCommits}`,
      '--',
      specFile
    ];

    const output = executeCommand('git', gitArgs, { cwd: apiDocsPath });
    const commits = output.trim().split('\n').filter(Boolean);

    // Filter criteria
    const excludedAuthors = [
      'vbotbuildovich',
      'github-actions[bot]',
      'dependabot[bot]',
      'renovate[bot]'
    ];

    const excludedMessagePatterns = [
      /^auto-docs:/i,
      /^automated:/i,
      /^bot:/i,
      /\[skip ci\]/i,
      /^chore\(deps\):/i,
      /^Update.*via GitHub Action/i
    ];

    const manualCommits = [];

    for (const commitLine of commits) {
      const [hash, author, email, date, subject] = commitLine.split('|');

      // Filter by author
      if (excludedAuthors.includes(author) || excludedAuthors.includes(email)) {
        continue;
      }

      // Filter by message patterns
      const isExcluded = excludedMessagePatterns.some(pattern => pattern.test(subject));
      if (isExcluded) {
        continue;
      }

      // Get diff for this commit
      const diff = executeCommand('git', [
        'show',
        '--format=',  // No commit metadata, just diff
        '--unified=3',
        hash,
        '--',
        specFile
      ], { cwd: apiDocsPath });

      manualCommits.push({
        hash: hash.substring(0, 7),  // Short hash
        author,
        email,
        date,
        subject,
        diff: diff.trim()
      });
    }

    return manualCommits;
  } catch (err) {
    console.error(`Warning: Could not find manual commits: ${err.message}`);
    return [];
  }
}

/**
 * Extract human-readable change summary from git diff
 * @param {string} diff - Git diff output
 * @returns {Array<string>} Array of change descriptions
 */
function extractChangeSummary(diff) {
  const changes = [];
  const lines = diff.split('\n');

  let currentOperation = null;

  for (const line of lines) {
    // Look for description/summary changes
    if (line.startsWith('-') && !line.startsWith('---')) {
      const descMatch = line.match(/description:\s*["'](.+?)["']/);
      const summMatch = line.match(/summary:\s*["'](.+?)["']/);
      if (descMatch) {
        currentOperation = { old: descMatch[1], new: null, type: 'description' };
      } else if (summMatch) {
        currentOperation = { old: summMatch[1], new: null, type: 'summary' };
      }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      const descMatch = line.match(/description:\s*["'](.+?)["']/);
      const summMatch = line.match(/summary:\s*["'](.+?)["']/);

      if (descMatch && currentOperation && currentOperation.old && currentOperation.type === 'description') {
        currentOperation.new = descMatch[1];
        changes.push(`Changed description: "${currentOperation.old}" → "${currentOperation.new}"`);
        currentOperation = null;
      } else if (summMatch && currentOperation && currentOperation.old && currentOperation.type === 'summary') {
        currentOperation.new = summMatch[1];
        changes.push(`Changed summary: "${currentOperation.old}" → "${currentOperation.new}"`);
        currentOperation = null;
      }
    }
  }

  return changes;
}

/**
 * Generate manual fallback instructions when automated comparison fails
 * @param {Error} error - Error that occurred
 * @param {Object} metadata - Context metadata
 * @returns {string} Formatted fallback instructions
 */
function generateFallbackInstructions(error, metadata) {
  const { apiDocsPath, sourceRepoPath, apiSurface, apiDocsSpec } = metadata;
  const generatedSpecPath = apiSurface === 'admin' ? 'admin/admin.yaml' :
    apiSurface === 'controlplane' ? 'proto/gen/openapi/openapi.controlplane.prod.yaml' :
    '<generated-spec-file>';

  const regenerateCmd = apiSurface === 'controlplane' ?
    `cd ${sourceRepoPath}\n./taskw generate` :
    `npx doc-tools generate bundle-openapi --branch <your-branch>`;

  return `# Automated Comparison Failed - Manual Steps Required

**Error:** ${error.message}

---

## Manual Comparison Steps

### 1. Compare Specs
\`\`\`bash
diff ${sourceRepoPath}/${generatedSpecPath} ${apiDocsPath}/${apiDocsSpec}
\`\`\`

### 2. Find Manual Commits
\`\`\`bash
cd ${apiDocsPath}
git log --oneline --since="2 weeks ago" --author="$(git config user.name)" -- ${apiDocsSpec}
\`\`\`

### 3. Search Proto Files
\`\`\`bash
cd ${sourceRepoPath}
grep -r "old-text-from-api-docs" proto/
\`\`\`

### 4. Regenerate and Verify
\`\`\`bash
${regenerateCmd}
grep "your-fixed-text" ${generatedSpecPath}
\`\`\`

---

## Common Issues
- **Missing buf**: \`brew install bufbuild/buf/buf\`
- **Missing protoc plugins**: Run repo-specific setup scripts
- **Permission errors**: Check file permissions in proto/gen/
- **Branch issues**: Ensure you're on the correct branch

Provide the error above to your team or docs maintainers for help.
`;
}

/**
 * Compare proto descriptions between api-docs and source repo
 *
 * @param {Object} args - Arguments
 * @param {string} args.api_docs_spec - Path to OpenAPI spec in api-docs
 * @param {string} [args.api_docs_repo_path] - Path to api-docs repo (auto-detected)
 * @param {string} [args.api_surface] - API surface (admin, controlplane)
 * @param {string} [args.redpanda_repo_path] - Path to redpanda repo (auto-detected)
 * @param {string} [args.cloudv2_repo_path] - Path to cloudv2 repo (auto-detected)
 * @param {string} [args.source_branch] - Branch/tag to compare (default: "dev")
 * @param {string} [args.output_format] - Output format (default: "report")
 * @param {boolean} [args.validate_format] - Validate proto comment format (default: true)
 * @returns {Object} Comparison results
 */
function compareProtoDescriptions(args) {
  // Strategy 1: Use findRepository for multi-strategy api-docs detection
  let apiDocsRepoPath;
  try {
    apiDocsRepoPath = findRepository('api-docs', args.api_docs_repo_path);
  } catch (err) {
    return {
      success: false,
      error: `Could not locate api-docs repository: ${err.message}`,
      suggestion:
        `Options to fix:\n` +
        `1. Clone api-docs as sibling: cd .. && git clone https://github.com/redpanda-data/api-docs\n` +
        `2. Set environment variable: export API_DOCS_REPO_PATH=/path/to/api-docs\n` +
        `3. Pass explicit path: { api_docs_repo_path: "/path/to/api-docs" }`
    };
  }

  // Strategy 2: Resolve spec path
  let apiDocsSpecPath;
  if (path.isAbsolute(args.api_docs_spec)) {
    // Support absolute paths as escape hatch
    apiDocsSpecPath = args.api_docs_spec;
  } else {
    // Resolve relative path within api-docs repo
    apiDocsSpecPath = path.join(apiDocsRepoPath, args.api_docs_spec);
  }

  if (!fs.existsSync(apiDocsSpecPath)) {
    return {
      success: false,
      error: `OpenAPI spec not found: ${args.api_docs_spec}`,
      suggestion: `Spec path resolved to: ${apiDocsSpecPath}`,
      api_docs_repo: apiDocsRepoPath
    };
  }

  console.error(`Using api-docs repo: ${apiDocsRepoPath}`);
  console.error(`Loading spec: ${apiDocsSpecPath}`);

  let generatedSpecPath = null;
  let sourceRepoPath;
  let apiSurface;

  try {
    // Detect or validate API surface (inlined)
    apiSurface = args.api_surface;
    if (!apiSurface) {
      const normalized = args.api_docs_spec.toLowerCase();
      if (normalized.includes('admin') || normalized.startsWith('admin/')) {
        apiSurface = 'admin';
      } else if (normalized.includes('controlplane') || normalized.includes('control-plane') || normalized.startsWith('controlplane/')) {
        apiSurface = 'controlplane';
      } else {
        throw new Error(
          `Could not detect API surface from spec path: ${args.api_docs_spec}\n` +
          `Please specify api_surface parameter explicitly (admin or controlplane)`
        );
      }
    }
    console.error(`API surface: ${apiSurface}`);

    // Get proto file map for this API surface
    const protoMap = PROTO_FILE_MAPS[apiSurface];
    if (!protoMap) {
      return {
        success: false,
        error: `Unsupported API surface: ${apiSurface}`,
        suggestion: `Supported surfaces: ${Object.keys(PROTO_FILE_MAPS).join(', ')}`
      };
    }

    // Find the source repository
    const repoKey = protoMap.repo;
    const repoPathArg = args[`${repoKey}_repo_path`];
    sourceRepoPath = findRepository(repoKey, repoPathArg);
    console.error(`Source repository (${repoKey}): ${sourceRepoPath}`);

    // Validate repository state
    validateRepoState(sourceRepoPath);

    // Read current api-docs spec
    const currentSpec = yaml.load(fs.readFileSync(apiDocsSpecPath, 'utf8'));
    console.error(`Loaded api-docs spec: ${args.api_docs_spec}`);

    // Determine branch with better error handling
    let branch;
    if (args.source_branch) {
      branch = args.source_branch;
      console.error(`Using explicit branch: ${branch}`);
    } else {
      try {
        branch = getCurrentBranch(sourceRepoPath);
        console.error(`Detected branch: ${branch}`);
      } catch (err) {
        // Provide helpful suggestion based on API surface
        const defaultBranch = (apiSurface === 'admin') ? 'dev' : 'main';
        return {
          success: false,
          error: err.message,
          suggestion: `Try specifying: { source_branch: "${defaultBranch}" }`,
          api_surface: apiSurface,
          source_repo: repoKey
        };
      }
    }
    generatedSpecPath = generateSpecFromProtos(sourceRepoPath, branch, apiSurface);
    const generatedSpec = yaml.load(fs.readFileSync(generatedSpecPath, 'utf8'));
    console.error(`Generated spec from protos`);

    // Compare the two specs with location information
    const differences = findDescriptionDifferences(currentSpec, generatedSpec, sourceRepoPath, apiSurface);
    console.error(`Found ${differences.length} description discrepancies`);

    // Filter PREVIEW services
    const previewItems = findPreviewServices(sourceRepoPath, apiSurface);
    const { filtered, skipped } = filterPreviewChanges(differences, previewItems);

    // Log skipped PREVIEW items
    if (skipped.length > 0) {
      console.error(`\n⏭️  Skipped ${skipped.length} PREVIEW service changes:`);
      for (const diff of skipped.slice(0, 5)) {
        console.error(`  - ${diff.operationId} (PREVIEW)`);
      }
      if (skipped.length > 5) {
        console.error(`  ... and ${skipped.length - 5} more`);
      }
      console.error(`\nNote: PREVIEW services are not yet public. Changes to them`);
      console.error(`should not be backported until the PREVIEW restriction is removed.\n`);
    }

    // Use filtered differences for the rest of the function
    const differencesToProcess = filtered;
    console.error(`Processing ${differencesToProcess.length} non-PREVIEW changes`);

    // Find manual commits in api-docs if there are differences
    let manualCommits = [];
    if (differencesToProcess.length > 0) {
      console.error('Finding manual commits in api-docs...');
      manualCommits = findManualCommits(apiDocsRepoPath, args.api_docs_spec, {
        since: '2 weeks ago',
        maxCommits: 10
      });
      console.error(`Found ${manualCommits.length} manual commits`);
    }

    // Validate proto format if requested
    const validateFormat = args.validate_format !== false;
    let formatIssues = [];
    if (validateFormat && differencesToProcess.length > 0) {
      console.error('Validating proto comment format...');
      formatIssues = validateProtoCommentFormat(
        sourceRepoPath,
        apiSurface,
        differencesToProcess
      );
      console.error(`Found ${formatIssues.length} format issues`);
    }

    // Format output based on requested format
    const outputFormat = args.output_format || 'report';
    const output = formatOutput(differencesToProcess, formatIssues, outputFormat, {
      apiSurface,
      sourceRepo: repoKey,
      sourceBranch: branch,
      apiDocsSpec: args.api_docs_spec
    }, skipped, manualCommits);

    return {
      success: true,
      api_surface: apiSurface,
      source_repo: repoKey,
      source_branch: branch,
      differences_found: filtered.length,
      preview_skipped: skipped.length,
      format_issues_found: formatIssues.length,
      output,
      summary: `Found ${filtered.length} description discrepancies${skipped.length > 0 ? ` (${skipped.length} PREVIEW changes skipped)` : ''}${formatIssues.length > 0 ? `, ${formatIssues.length} format issues` : ''}`
    };
  } catch (err) {
    // Classify error to determine appropriate fallback (inlined)
    const message = err.message.toLowerCase();
    const isBufOrSpecError = message.includes('buf generate') || message.includes('protoc') || message.includes('failed to generate spec');

    if (isBufOrSpecError) {
      // Provide fallback instructions
      const fallbackInstructions = generateFallbackInstructions(err, {
        apiDocsPath: apiDocsRepoPath,
        sourceRepoPath: sourceRepoPath || '<source-repo-path>',
        apiSurface: apiSurface || 'unknown',
        apiDocsSpec: args.api_docs_spec
      });

      return {
        success: false,
        method: 'manual_fallback',
        error: err.message,
        fallback_instructions: fallbackInstructions,
        suggestion: 'Use the manual comparison steps provided in fallback_instructions'
      };
    }

    // For other errors, return structured error
    return {
      success: false,
      error: err.message,
      suggestion: 'Ensure both api-docs and source repositories are accessible and up to date'
    };
  } finally {
    // Clean up temporary file
    if (generatedSpecPath && fs.existsSync(generatedSpecPath)) {
      try {
        fs.unlinkSync(generatedSpecPath);
        console.error(`Cleaned up temporary file: ${generatedSpecPath}`);
      } catch (cleanupErr) {
        console.error(`Warning: Failed to clean up temporary file: ${cleanupErr.message}`);
      }
    }
  }
}

/**
 * Generate OpenAPI spec from proto files
 * @param {string} repoPath - Path to source repository
 * @param {string} branch - Branch or tag to use
 * @param {string} apiSurface - API surface (admin, controlplane, etc.)
 * @returns {string} Path to generated spec file
 */
function generateSpecFromProtos(repoPath, branch, apiSurface) {
  const tmpFile = path.join(os.tmpdir(), `proto-generated-${apiSurface}-${Date.now()}.yaml`);

  // Map API surface to bundle-openapi surface parameter
  const surfaceMap = {
    'admin': 'admin',
    'controlplane': 'admin' // Control plane uses admin surface with different repo
  };

  const surface = surfaceMap[apiSurface] || 'admin';

  const repoRoot = findRepoRoot();
  const { program, getArgs } = getDocToolsCommand(repoRoot);

  const args = getArgs([
    'generate', 'bundle-openapi',
    '--branch', branch,
    '--repo', repoPath,
    '--surface', surface,
    '--out-admin', tmpFile,
    '--quiet'
  ]);

  try {
    executeCommand(program, args);

    if (!fs.existsSync(tmpFile)) {
      throw new Error('Failed to generate spec from protos - output file not created');
    }

    return tmpFile;
  } catch (err) {
    throw new Error(`Failed to generate spec from protos: ${err.message}`);
  }
}

/**
 * Find description differences between two OpenAPI specs
 * @param {Object} currentSpec - Current spec from api-docs
 * @param {Object} generatedSpec - Generated spec from protos
 * @param {string} sourceRepoPath - Path to source repository
 * @param {string} apiSurface - API surface (admin, controlplane)
 * @returns {Array} Array of differences with location info
 */
function findDescriptionDifferences(currentSpec, generatedSpec, sourceRepoPath, apiSurface) {
  const differences = [];

  // Compare paths and their operations
  for (const [pathKey, pathItem] of Object.entries(currentSpec.paths || {})) {
    const generatedPathItem = generatedSpec.paths?.[pathKey];
    if (!generatedPathItem) continue;

    for (const [method, operation] of Object.entries(pathItem)) {
      if (typeof operation !== 'object' || !operation.operationId) continue;

      const generatedOp = generatedPathItem[method];
      if (!generatedOp) continue;

      // Normalize whitespace for comparison (multi-line and single-line are semantically equivalent)
      const normalizeWhitespace = (str) => str ? str.replace(/\s+/g, ' ').trim() : '';

      // Compare summary and description
      const summaryDiff = normalizeWhitespace(operation.summary || '') !== normalizeWhitespace(generatedOp.summary || '');
      const descriptionDiff = normalizeWhitespace(operation.description || '') !== normalizeWhitespace(generatedOp.description || '');

      if (summaryDiff || descriptionDiff) {
        // Find proto file location for this operation
        const parts = operation.operationId.split('.');
        const rpcName = parts[parts.length - 1];
        const serviceName = parts[parts.length - 2];
        const protoFile = findProtoFileForService(sourceRepoPath, apiSurface, serviceName);

        let locationInfo = {};
        if (protoFile) {
          const location = findRpcLineNumber(protoFile, rpcName);
          if (location.found) {
            locationInfo = {
              protoFile: path.relative(sourceRepoPath, protoFile),
              lineNumber: location.descriptionLineNumber,
              rpcDefinition: location.rpcDefinition,
              currentProtoDescription: extractCurrentDescription(location.rpcDefinition)
            };
          }
        }

        differences.push({
          path: pathKey,
          method: method.toUpperCase(),
          operationId: operation.operationId,
          current: {
            summary: operation.summary || null,
            description: operation.description || null
          },
          generated: {
            summary: generatedOp.summary || null,
            description: generatedOp.description || null
          },
          changes: {
            summary: summaryDiff,
            description: descriptionDiff
          },
          location: locationInfo  // New field with proto location details
        });
      }
    }
  }

  return differences;
}

/**
 * Validate proto comment format for affected RPCs
 * Note: Strict three-line format validation only applies to Admin API (ConnectRPC)
 * Control Plane API (gRPC) has flexible format - options can override comments
 *
 * @param {string} repoPath - Path to source repository
 * @param {string} apiSurface - API surface (admin, controlplane)
 * @param {Array} differences - Array of differences from comparison
 * @returns {Array} Array of format issues
 */
function validateProtoCommentFormat(repoPath, apiSurface, differences) {
  const formatIssues = [];
  const protoMap = PROTO_FILE_MAPS[apiSurface];

  if (!protoMap) return formatIssues;

  // Only validate strict format for Admin API (ConnectRPC)
  // Control Plane API (gRPC) uses flexible format with options
  const useStrictValidation = (apiSurface === 'admin');

  if (!useStrictValidation) {
    console.error(`Skipping strict format validation for ${apiSurface} API (gRPC uses flexible format)`);
    return formatIssues;
  }

  for (const diff of differences) {
    // Extract service and RPC name from operationId
    // Example: redpanda.core.admin.v2.BrokerService.GetBroker
    const parts = diff.operationId.split('.');
    const rpcName = parts[parts.length - 1];
    const serviceName = parts[parts.length - 2];

    // Find proto file for this service
    const protoFile = findProtoFileForService(repoPath, apiSurface, serviceName);
    if (!protoFile) {
      continue; // Service not mapped yet or file doesn't exist
    }

    // Read proto file and check comment format (strict three-line format for Admin API)
    try {
      const protoContent = fs.readFileSync(protoFile, 'utf8');
      const formatCheck = checkRpcCommentFormat(protoContent, rpcName);

      if (!formatCheck.valid) {
        formatIssues.push({
          file: protoFile,
          rpc: rpcName,
          issue: formatCheck.issue,
          currentFormat: formatCheck.currentFormat,
          expectedFormat: formatCheck.expectedFormat
        });
      }
    } catch (err) {
      console.error(`Warning: Could not read proto file ${protoFile}: ${err.message}`);
    }
  }

  return formatIssues;
}

/**
 * Format output based on requested format
 * @param {Array} differences - Array of differences
 * @param {Array} formatIssues - Array of format issues
 * @param {string} format - Output format
 * @param {Object} metadata - Additional metadata
 * @param {Array} skipped - Array of skipped PREVIEW differences
 * @param {Array} manualCommits - Array of manual commits from api-docs
 * @returns {string} Formatted output
 */
function formatOutput(differences, formatIssues, format, metadata, skipped = [], manualCommits = []) {
  if (format === 'json') {
    return JSON.stringify({
      metadata,
      differences,
      skipped,
      formatIssues,
      manualCommits
    }, null, 2);
  }

  if (format === 'detailed') {
    return formatDetailedReport(differences, formatIssues, metadata, skipped, manualCommits);
  }

  // Default: report format
  return formatSummaryReport(differences, formatIssues, metadata, skipped, manualCommits);
}

/**
 * Format summary report
 */
function formatSummaryReport(differences, formatIssues, metadata, skipped = [], manualCommits = []) {
  let report = `# Proto Description Comparison Report\n\n`;
  report += `**API Surface:** ${metadata.apiSurface}\n`;
  report += `**Source Repository:** ${metadata.sourceRepo} (${metadata.sourceBranch})\n`;
  report += `**API Docs Spec:** ${metadata.apiDocsSpec}\n\n`;

  if (differences.length === 0 && skipped.length === 0) {
    report += `✅ No description discrepancies found.\n`;
    return report;
  }

  // Show manual commits if any were found
  if (manualCommits && manualCommits.length > 0) {
    report += `## 📝 Manual Changes in api-docs (Last 2 Weeks)\n\n`;
    report += `Found ${manualCommits.length} manual commits affecting ${metadata.apiDocsSpec}:\n\n`;

    for (const commit of manualCommits) {
      report += `### ${commit.hash} - "${commit.subject}"\n`;
      report += `**Author:** ${commit.author} (${commit.date.split('T')[0]})\n\n`;

      // Extract meaningful changes from diff
      const changes = extractChangeSummary(commit.diff);
      if (changes.length > 0) {
        report += `**Changes:**\n`;
        for (const change of changes) {
          report += `- ${change}\n`;
        }
        report += `\n`;
      }

      report += `---\n\n`;
    }
  }

  if (differences.length > 0) {
    report += `## Found ${differences.length} Description Discrepancies\n\n`;

    for (const diff of differences) {
      report += `### ${diff.operationId}\n`;
      report += `**Path:** \`${diff.method} ${diff.path}\`\n\n`;

      // Add proto location information
      if (diff.location && diff.location.protoFile) {
        report += `**Proto Location:**\n`;
        report += `- File: \`${diff.location.protoFile}\`\n`;
        report += `- Line: ${diff.location.lineNumber}\n\n`;
      }

      if (diff.changes.description) {
        report += `**Description Change Needed:**\n`;
        report += `\`\`\`diff\n`;
        report += `- ${diff.location?.currentProtoDescription || diff.generated.description || '(none)'}\n`;
        report += `+ ${diff.current.description || '(none)'}\n`;
        report += `\`\`\`\n\n`;
      }

      if (diff.changes.summary) {
        report += `**Summary:**\n`;
        report += `- Current (api-docs): ${diff.current.summary || '(none)'}\n`;
        report += `- Generated (from protos): ${diff.generated.summary || '(none)'}\n\n`;
      }

      // Show code snippet if available
      if (diff.location && diff.location.rpcDefinition) {
        report += `**Current Proto Code:**\n`;
        report += `\`\`\`protobuf\n`;
        report += diff.location.rpcDefinition;
        report += `\n\`\`\`\n\n`;
      }

      report += `---\n\n`;
    }
  }

  if (skipped.length > 0) {
    report += `\n## ⏭️ Skipped Changes (PREVIEW Services)\n\n`;
    report += `The following ${skipped.length} changes were skipped because they affect PREVIEW services:\n\n`;

    for (const diff of skipped) {
      report += `### ${diff.operationId} (PREVIEW)\n`;
      report += `**Path:** \`${diff.method} ${diff.path}\`\n\n`;

      if (diff.changes.description) {
        report += `**Description change:** ${diff.current.description} → ${diff.generated.description}\n\n`;
      }
      if (diff.changes.summary) {
        report += `**Summary change:** ${diff.current.summary} → ${diff.generated.summary}\n\n`;
      }

      report += `---\n\n`;
    }

    report += `**Note:** PREVIEW services are not yet public. Changes to them should not be backported until the PREVIEW restriction is removed from the proto files.\n\n`;
  }

  if (formatIssues.length > 0) {
    report += `\n## ⚠️ Proto Format Issues (${formatIssues.length})\n\n`;
    report += `Found proto files with incorrect comment format:\n\n`;

    for (const issue of formatIssues) {
      report += `**${path.basename(issue.file)}** - RPC: \`${issue.rpc}\`\n`;
      report += `Issue: ${issue.issue}\n\n`;
      if (issue.expectedFormat) {
        report += `Expected format:\n\`\`\`\n${issue.expectedFormat}\n\`\`\`\n\n`;
      }
    }
  }

  return report;
}

/**
 * Format detailed report with backporting instructions
 */
function formatDetailedReport(differences, formatIssues, metadata, skipped = [], manualCommits = []) {
  let report = formatSummaryReport(differences, formatIssues, metadata, skipped, manualCommits);

  if (differences.length > 0) {
    report += `\n## 📋 Backporting Instructions\n\n`;
    report += `⚠️ **IMPORTANT: USER ACTION REQUIRED**\n\n`;
    report += `The following steps must be performed manually by YOU (the user).\n`;
    report += `AI agents will NOT execute these commands automatically.\n\n`;
    report += `To backport these improvements to proto files:\n\n`;
    report += `1. **YOU** create a branch in the ${metadata.sourceRepo} repository:\n`;
    report += `   \`git checkout -b docs/proto/update-descriptions\`\n\n`;
    report += `2. **YOU** edit each proto file listed above at the specified line numbers\n\n`;
    report += `3. **YOU** run formatting and regeneration:\n`;
    if (metadata.sourceRepo === 'redpanda') {
      report += `   - Format: \`bazel run //tools:clang_format\`\n`;
      report += `   - Regenerate: \`tools/regenerate_ducktape_protos.sh\`\n`;
      report += `   - Buf generate: \`buf generate --path proto\`\n\n`;
    } else if (metadata.sourceRepo === 'cloudv2') {
      report += `   - Generate: \`./taskw proto:generate\`\n\n`;
    }
    report += `4. **YOU** verify changes:\n`;
    report += `   \`git diff\`\n\n`;
    report += `5. **YOU** stage and commit:\n`;
    report += `   \`git add proto/\`\n`;
    report += `   \`git commit -m "docs: update API descriptions from api-docs backport"\`\n\n`;
    report += `6. **YOU** push and create PR when ready\n\n`;
    report += `See the backport-api-descriptions prompt for detailed guidance.\n`;
  }

  return report;
}

module.exports = {
  compareProtoDescriptions,
  PROTO_FILE_MAPS
};
