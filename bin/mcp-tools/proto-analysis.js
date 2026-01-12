/**
 * MCP Tools - Proto File Analysis
 *
 * Utilities for analyzing proto files:
 * - Finding RPC definitions and line numbers
 * - Extracting descriptions from proto comments/annotations
 * - PREVIEW service detection
 * - Proto comment format validation
 * - Proto file discovery and mapping
 */

const fs = require('fs');
const path = require('path');

/**
 * Proto file mappings for different API surfaces
 * Maps service names to their proto file paths
 */
const PROTO_FILE_MAPS = {
  // Admin API (redpanda repo)
  admin: {
    repo: 'redpanda',
    services: {
      'BrokerService': 'proto/redpanda/core/admin/v2/broker.proto',
      'ClusterService': 'proto/redpanda/core/admin/v2/cluster.proto',
      'ShadowLinkService': 'proto/redpanda/core/admin/v2/shadow_link.proto',
      'SecurityService': 'proto/redpanda/core/admin/v2/security.proto',
      'KafkaConnectionsService': 'proto/redpanda/core/admin/v2/kafka_connections.proto'
    }
  },

  // Control Plane API (cloudv2 repo)
  controlplane: {
    repo: 'cloudv2',
    services: {
      'ClusterService': 'proto/public/cloud/redpanda/api/controlplane/v1/cluster.proto',
      'NetworkService': 'proto/public/cloud/redpanda/api/controlplane/v1/network.proto',
      'NetworkPeeringService': 'proto/public/cloud/redpanda/api/controlplane/v1/network_peering.proto',
      'ResourceGroupService': 'proto/public/cloud/redpanda/api/controlplane/v1/resource_group.proto',
      'OperationService': 'proto/public/cloud/redpanda/api/controlplane/v1/operation.proto',
      'RegionService': 'proto/public/cloud/redpanda/api/controlplane/v1/region.proto',
      'ServerlessService': 'proto/public/cloud/redpanda/api/controlplane/v1/serverless.proto',
      'ServerlessRegionService': 'proto/public/cloud/redpanda/api/controlplane/v1/serverless_region.proto',
      'ServerlessPrivateLinkService': 'proto/public/cloud/redpanda/api/controlplane/v1/serverless_private_link.proto',
      'ShadowLinkService': 'proto/public/cloud/redpanda/api/controlplane/v1/shadow_link.proto'
    }
  }
};

/**
 * Find line number and definition of RPC in proto file
 * @param {string} protoFile - Path to proto file
 * @param {string} rpcName - RPC method name
 * @returns {Object} Location info with line numbers and definition
 */
function findRpcLineNumber(protoFile, rpcName) {
  try {
    const content = fs.readFileSync(protoFile, 'utf8');
    const lines = content.split('\n');

    let rpcLineNumber = null;
    let descriptionLineNumber = null;
    let rpcDefinition = [];
    let inRpcBlock = false;
    let braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      // Check for RPC declaration
      const rpcMatch = line.match(new RegExp(`rpc\\s+${rpcName}\\s*\\(`));
      if (rpcMatch) {
        rpcLineNumber = lineNumber;
        inRpcBlock = true;

        // Look backwards for openapiv2_operation annotation
        for (let j = i - 1; j >= Math.max(0, i - 20); j--) {
          if (lines[j].includes('openapiv2_operation')) {
            descriptionLineNumber = j + 1;
            break;
          }
        }
      }

      // Collect RPC block
      if (inRpcBlock) {
        rpcDefinition.push(lines[i]);

        // Track braces to know when RPC block ends
        braceDepth += (line.match(/\{/g) || []).length;
        braceDepth -= (line.match(/\}/g) || []).length;

        if (braceDepth <= 0 && line.includes('}')) {
          break;
        }
      }
    }

    if (!rpcLineNumber) {
      return {
        found: false,
        error: `RPC ${rpcName} not found in ${protoFile}`
      };
    }

    return {
      found: true,
      rpcLineNumber,
      descriptionLineNumber: descriptionLineNumber || rpcLineNumber,
      rpcDefinition: rpcDefinition.join('\n'),
      protoFile
    };
  } catch (err) {
    return {
      found: false,
      error: err.message
    };
  }
}

/**
 * Extract current description from proto RPC definition
 * @param {string} rpcDefinition - RPC definition block
 * @returns {string|null} Description text or null
 */
function extractCurrentDescription(rpcDefinition) {
  // Look for openapiv2_operation.description (Control Plane API)
  const match = rpcDefinition.match(/description:\s*"([^"]+)"/);
  if (match) {
    return match[1];
  }

  // Fallback: look for comment-based description (Admin API)
  const commentLines = rpcDefinition.split('\n')
    .filter(l => l.trim().startsWith('//'))
    .map(l => l.trim().substring(2).trim());

  // Skip first line (method name) and second line (blank)
  if (commentLines.length > 2) {
    return commentLines.slice(2).join(' ');
  }

  return null;
}

/**
 * Extract service and RPC names for PREVIEW operations
 * @param {string} protoContent - Proto file content
 * @returns {Array<string>} Array of operation IDs (ServiceName_RpcName format)
 */
function extractPreviewRpcs(protoContent) {
  const previewRpcs = [];

  // Find current service name
  const serviceMatch = protoContent.match(/service\s+(\w+)\s*\{/);
  if (!serviceMatch) return previewRpcs;

  const serviceName = serviceMatch[1];

  // Find all RPC definitions with PREVIEW restriction
  const rpcPattern = /rpc\s+(\w+)\s*\([^)]*\)\s*returns\s*\([^)]*\)\s*\{[^}]*method_visibility\)\.restriction\s*=\s*"PREVIEW"/g;

  let match;
  while ((match = rpcPattern.exec(protoContent)) !== null) {
    const rpcName = match[1];
    previewRpcs.push(`${serviceName}_${rpcName}`);
  }

  return previewRpcs;
}

/**
 * Find all PREVIEW services/RPCs by scanning proto files
 * @param {string} repoPath - Path to source repository
 * @param {string} apiSurface - API surface (admin, controlplane)
 * @returns {Set<string>} Set of PREVIEW operation IDs
 */
function findPreviewServices(repoPath, apiSurface) {
  const previewItems = new Set();
  const protoMap = PROTO_FILE_MAPS[apiSurface];

  if (!protoMap) return previewItems;

  // Determine proto directory to scan
  let protoBaseDir;
  if (apiSurface === 'admin') {
    protoBaseDir = path.join(repoPath, 'proto', 'redpanda', 'core', 'admin');
  } else if (apiSurface === 'controlplane') {
    protoBaseDir = path.join(repoPath, 'proto', 'public', 'cloud', 'redpanda', 'api', 'controlplane');
  } else {
    return previewItems;
  }

  if (!fs.existsSync(protoBaseDir)) {
    console.error(`Proto directory not found: ${protoBaseDir}`);
    return previewItems;
  }

  // Scan all proto files
  const protoFiles = findProtoFilesRecursive(protoBaseDir);

  for (const protoFile of protoFiles) {
    try {
      const content = fs.readFileSync(protoFile, 'utf8');

      if (content.includes('method_visibility).restriction = "PREVIEW"')) {
        const previewRpcs = extractPreviewRpcs(content);
        previewRpcs.forEach(rpc => previewItems.add(rpc));
      }
    } catch (err) {
      console.error(`Warning: Could not read ${protoFile}: ${err.message}`);
    }
  }

  console.error(`Found ${previewItems.size} PREVIEW operations`);
  return previewItems;
}

/**
 * Filter out PREVIEW service changes from differences
 * @param {Array} differences - Array of differences
 * @param {Set<string>} previewItems - Set of PREVIEW operation IDs
 * @returns {{ filtered: Array, skipped: Array }} Filtered and skipped differences
 */
function filterPreviewChanges(differences, previewItems) {
  const filtered = [];
  const skipped = [];

  for (const diff of differences) {
    // Extract service_rpc format from operationId
    let serviceRpc;
    if (diff.operationId.includes('_')) {
      serviceRpc = diff.operationId;
    } else {
      const parts = diff.operationId.split('.');
      const rpcName = parts[parts.length - 1];
      const serviceName = parts[parts.length - 2];
      serviceRpc = `${serviceName}_${rpcName}`;
    }

    if (previewItems.has(serviceRpc)) {
      skipped.push(diff);
    } else {
      filtered.push(diff);
    }
  }

  return { filtered, skipped };
}

/**
 * Check if RPC comment follows Admin API format (three-line format)
 * @param {string} protoContent - Proto file content
 * @param {string} rpcName - RPC method name
 * @returns {Object} Validation result
 */
function checkRpcCommentFormat(protoContent, rpcName) {
  const rpcPattern = new RegExp(`//.*?\\n\\s*rpc\\s+${rpcName}\\s*\\(`, 'ms');
  const match = protoContent.match(rpcPattern);

  if (!match) {
    return {
      valid: false,
      issue: 'RPC not found in proto file',
      currentFormat: '',
      expectedFormat: `// ${rpcName}\n//\n// [Description here]`
    };
  }

  // Extract comment lines before the rpc declaration
  const beforeRpc = match[0].substring(0, match[0].lastIndexOf('rpc'));
  const commentLines = beforeRpc.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('//'))
    .map(l => l.substring(2).trim());

  if (commentLines.length < 3) {
    return {
      valid: false,
      issue: 'Comment too short - needs RPC name, blank line, and description',
      currentFormat: commentLines.map(l => `// ${l}`).join('\n'),
      expectedFormat: `// ${rpcName}\n//\n// [Description here]`
    };
  }

  if (commentLines[0] !== rpcName) {
    return {
      valid: false,
      issue: `First line should be "// ${rpcName}" only`,
      currentFormat: commentLines.slice(0, 3).map(l => `// ${l}`).join('\n'),
      expectedFormat: `// ${rpcName}\n//\n// ${commentLines[0]}`
    };
  }

  if (commentLines[1] !== '') {
    return {
      valid: false,
      issue: 'Second line should be blank comment "//"',
      currentFormat: commentLines.slice(0, 3).map(l => `// ${l}`).join('\n'),
      expectedFormat: `// ${rpcName}\n//\n// ${commentLines[2]}`
    };
  }

  return { valid: true };
}

/**
 * Find proto file for a given service name using hybrid approach
 * @param {string} repoPath - Path to source repository
 * @param {string} apiSurface - API surface
 * @param {string} serviceName - Service name
 * @returns {string|null} Path to proto file or null if not found
 */
function findProtoFileForService(repoPath, apiSurface, serviceName) {
  const protoMap = PROTO_FILE_MAPS[apiSurface];
  if (!protoMap) return null;

  // Strategy 1: Check hard-coded mapping (fast path)
  const relPath = protoMap.services[serviceName];
  if (relPath) {
    const fullPath = path.join(repoPath, relPath);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
    console.error(`Warning: Hard-coded mapping for ${serviceName} points to non-existent file: ${relPath}`);
  }

  // Strategy 2: Auto-discover (fallback for new services)
  console.error(`Auto-discovering proto file for unmapped service: ${serviceName}`);
  const discovered = autoDiscoverProtoFile(repoPath, apiSurface, serviceName);

  if (discovered) {
    console.error(`✓ Auto-discovered: ${serviceName} -> ${path.relative(repoPath, discovered)}`);
    console.error(`  Consider adding to PROTO_FILE_MAPS for better performance`);
  }

  return discovered;
}

/**
 * Auto-discover proto file by scanning directory and parsing files
 * @param {string} repoPath - Path to source repository
 * @param {string} apiSurface - API surface
 * @param {string} serviceName - Service name to find
 * @returns {string|null} Path to proto file or null if not found
 */
function autoDiscoverProtoFile(repoPath, apiSurface, serviceName) {
  const protoMap = PROTO_FILE_MAPS[apiSurface];
  if (!protoMap) return null;

  // Determine base proto directory to scan
  let protoBaseDir;
  if (apiSurface === 'admin') {
    protoBaseDir = path.join(repoPath, 'proto', 'redpanda', 'core', 'admin');
  } else if (apiSurface === 'controlplane') {
    protoBaseDir = path.join(repoPath, 'proto', 'public', 'cloud', 'redpanda', 'api', 'controlplane');
  } else {
    return null;
  }

  if (!fs.existsSync(protoBaseDir)) {
    console.error(`Proto base directory not found: ${protoBaseDir}`);
    return null;
  }

  // Recursively scan for proto files
  const protoFiles = findProtoFilesRecursive(protoBaseDir);

  // Search for service definition in each file
  for (const protoFile of protoFiles) {
    try {
      const content = fs.readFileSync(protoFile, 'utf8');

      // Look for service definition: "service ServiceName {"
      const servicePattern = new RegExp(`service\\s+${serviceName}\\s*\\{`, 'm');
      if (servicePattern.test(content)) {
        return protoFile;
      }
    } catch (err) {
      // Skip files we can't read
      continue;
    }
  }

  return null;
}

/**
 * Recursively find all .proto files in a directory
 * @param {string} dir - Directory to search
 * @param {Array} results - Accumulator for results
 * @returns {Array<string>} Array of proto file paths
 */
function findProtoFilesRecursive(dir, results = []) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip common non-proto directories
        if (!['node_modules', '.git', 'vendor', 'bazel-out'].includes(entry.name)) {
          findProtoFilesRecursive(fullPath, results);
        }
      } else if (entry.isFile() && entry.name.endsWith('.proto')) {
        // Skip common non-service proto files
        if (!['common.proto', 'dummy.proto'].includes(entry.name)) {
          results.push(fullPath);
        }
      }
    }
  } catch (err) {
    // Skip directories we can't read
  }

  return results;
}

module.exports = {
  PROTO_FILE_MAPS,
  findRpcLineNumber,
  extractCurrentDescription,
  extractPreviewRpcs,
  findPreviewServices,
  filterPreviewChanges,
  checkRpcCommentFormat,
  findProtoFileForService,
  autoDiscoverProtoFile,
  findProtoFilesRecursive
};
