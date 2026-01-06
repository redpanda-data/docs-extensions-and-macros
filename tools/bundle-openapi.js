#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const yaml = require('yaml');

/**
 * Normalize a Git tag into a semantic version string.
 *
 * Trims surrounding whitespace, returns 'dev' unchanged, removes a leading 'v' if present,
 * and validates that the result matches MAJOR.MINOR.PATCH with optional pre-release/build metadata.
 * Throws if the input is not a non-empty string or does not conform to the expected version format.
 *
 * @param {string} tag - Git tag (for example, 'v25.1.1', '25.1.1', or 'dev').
 * @returns {string} Normalized version (for example, '25.1.1' or 'dev').
 * @throws {Error} If `tag` is not a non-empty string or does not match the semantic version pattern.
 */
function normalizeTag(tag) {
  if (!tag || typeof tag !== 'string') {
    throw new Error('Tag must be a non-empty string');
  }
  
  // Trim whitespace
  tag = tag.trim();
  
  if (!tag) {
    throw new Error('Invalid version format: tag cannot be empty');
  }
  
  // Remove 'v' prefix if present
  const normalized = tag.startsWith('v') ? tag.slice(1) : tag;
  // Validate semantic version format
  const semverPattern = /^\d+\.\d+\.\d+(-[\w\.-]+)?(\+[\w\.-]+)?$/;
  if (semverPattern.test(normalized)) {
    return normalized;
  }
  // If not a valid semver, treat as branch name and return as-is
  return tag;
}

/**
 * Return the major.minor portion of a semantic version string.
 *
 * Accepts a semantic version like `25.1.1` and yields `25.1`. The special value
 * `'dev'` is returned unchanged.
 * @param {string} version - Semantic version (for example, `'25.1.1'`) or `'dev'`.
 * @returns {string} The `major.minor` string (for example, `'25.1'`) or `'dev'`.
 * @throws {Error} If `version` is not a non-empty string, lacks major/minor parts, or if major/minor are not numeric.
 */
function getMajorMinor(version) {
  if (!version || typeof version !== 'string') {
    throw new Error('Version must be a non-empty string');
  }
  
  // Only process if valid semver, else return as-is (branch name)
  const semverPattern = /^\d+\.\d+\.\d+(-[\w\.-]+)?(\+[\w\.-]+)?$/;
  if (!semverPattern.test(version)) {
    return version;
  }
  const parts = version.split('.');
  if (parts.length < 2) {
    throw new Error(`Invalid version format: ${version}. Expected X.Y.Z format`);
  }
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  if (isNaN(major) || isNaN(minor)) {
    throw new Error(`Major and minor versions must be numbers: ${version}`);
  }
  return `${major}.${minor}`;
}

/**
 * Produce a new value with object keys sorted recursively for deterministic output.
 * Non-objects are returned unchanged; arrays are processed element-wise.
 * @param {*} obj - Value to normalize; may be an object, array, or any primitive.
 * @returns {*} A new value where any objects have their keys sorted lexicographically.
 */
function sortObjectKeys(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }
  
  const sortedObj = {};
  Object.keys(obj)
    .sort()
    .forEach(key => {
      sortedObj[key] = sortObjectKeys(obj[key]);
    });
  
  return sortedObj;
}

/**
 * Detect available OpenAPI bundler
 * @param {boolean} quiet - Suppress output
 * @returns {string} Available bundler command
 */
function detectBundler(quiet = false) {
  const bundlers = ['swagger-cli', 'redocly'];
  
  for (const bundler of bundlers) {
    try {
      execSync(`${bundler} --version`, { 
        stdio: 'ignore',
        timeout: 10000
      });
      
      if (!quiet) {
        console.log(`✅ Using ${bundler} for OpenAPI bundling`);
      }
      return bundler;
    } catch (error) {
      // Continue to next bundler
    }
  }
  
  // Try npx @redocly/cli as fallback
  try {
    execSync('npx @redocly/cli --version', { 
      stdio: 'ignore',
      timeout: 10000
    });
    
    if (!quiet) {
      console.log('✅ Using npx @redocly/cli for OpenAPI bundling');
    }
    return 'npx @redocly/cli';
  } catch (error) {
    // Try legacy npx redocly
    try {
      execSync('npx redocly --version', { 
        stdio: 'ignore',
        timeout: 10000
      });
      
      if (!quiet) {
        console.log('✅ Using npx redocly for OpenAPI bundling');
      }
      return 'npx redocly';
    } catch (error) {
      // Final fallback failed
    }
  }
  
  throw new Error(
    'No OpenAPI bundler found. Please install one of:\n' +
    '  npm install -g swagger-cli\n' +
    '  npm install -g @redocly/cli\n' +
    'For more information, see: https://github.com/APIDevTools/swagger-cli or https://redocly.com/docs/cli/'
  );
}

/**
 * Collects file paths of OpenAPI fragment files for the specified API surface.
 *
 * @param {string} tempDir - Path to a temporary repository workspace that contains generated OpenAPI fragments (must exist).
 * @param {'admin'|'connect'} apiSurface - API surface to scan; either `'admin'` or `'connect'`.
 * @returns {string[]} Array of full paths to discovered fragment files (*.openapi.yaml / *.openapi.yml).
 * @throws {Error} If tempDir is missing or does not exist.
 * @throws {Error} If apiSurface is not 'admin' or 'connect'.
 * @throws {Error} If no OpenAPI fragment files are found.
 */
function createEntrypoint(tempDir, apiSurface) {
  // Validate input parameters
  if (!tempDir || typeof tempDir !== 'string' || tempDir.trim() === '') {
    throw new Error('Invalid temporary directory');
  }
  
  // Check if directory exists
  if (!fs.existsSync(tempDir)) {
    throw new Error('Invalid temporary directory');
  }
  
  if (!apiSurface || typeof apiSurface !== 'string' || !['admin', 'connect'].includes(apiSurface)) {
    throw new Error('Invalid API surface');
  }

  let quiet = false; // Default for logging
  if (!quiet) {
    console.log('🔍 Looking for fragments in:');
    console.log(`   Admin v2: ${path.join(tempDir, 'vbuild/openapi/proto/redpanda/core/admin/v2')}`);
    console.log(`   Common: ${path.join(tempDir, 'vbuild/openapi/proto/redpanda/core/common')}`);
  }

  const fragmentDirs = [];
  let fragmentFiles = [];

  try {
    if (apiSurface === 'admin') {
      const adminDir = path.join(tempDir, 'vbuild/openapi/proto/redpanda/core/admin/v2');
      const commonDir = path.join(tempDir, 'vbuild/openapi/proto/redpanda/core/common');
      
      fragmentDirs.push(adminDir, commonDir);
    } else if (apiSurface === 'connect') {
      const connectDir = path.join(tempDir, 'vbuild/openapi/proto/redpanda/connect');
      fragmentDirs.push(connectDir);
    }

    // Log directory existence for debugging
    if (!quiet && fs.existsSync(path.join(tempDir, 'vbuild'))) {
      console.log('📂 vbuild directory contents:');
      try {
        const contents = fs.readdirSync(path.join(tempDir, 'vbuild'), { recursive: true });
        contents.slice(0, 10).forEach(item => {
          console.log(`   ${item}`);
        });
        if (contents.length > 10) {
          console.log(`   ... and ${contents.length - 10} more items`);
        }
      } catch (dirErr) {
        console.log(`   ❌ Error reading directory: ${dirErr.message}`);
      }
    }

    fragmentDirs.forEach(dir => {
      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir)
            .filter(file => file.endsWith('.openapi.yaml') || file.endsWith('.openapi.yml'))
            .map(file => path.join(dir, file))
            .filter(filePath => fs.statSync(filePath).isFile()); // Make sure it's actually a file
          
          fragmentFiles.push(...files);
        } catch (readErr) {
          throw new Error(`Failed to read fragment directories: ${readErr.message}`);
        }
      } else {
        if (!quiet) {
          console.log(`📁 ${path.basename(dir) === 'v2' ? 'Admin v2' : path.basename(dir)} directory not found: ${dir}`);
        }
      }
    });

  } catch (err) {
    throw new Error(`Failed to scan for OpenAPI fragments: ${err.message}`);
  }

  if (fragmentFiles.length === 0) {
    throw new Error('No OpenAPI fragments found to bundle. Make sure \'buf generate\' has run successfully');
  }

  // Most bundlers can handle multiple input files or merge operations.
  return fragmentFiles;
}

/**
 * Bundle one or more OpenAPI fragment files into a single bundled YAML using a selected external bundler.
 *
 * Merges multiple fragment files into a temporary single entrypoint when required, invokes the specified bundler
 * executable (supported values: 'swagger-cli', 'redocly', 'npx redocly', 'npx @redocly/cli'), and writes the bundled
 * output to the given outputPath. Ensures the output directory exists and verifies the produced file is non-empty.
 *
 * @param {string} bundler - The bundler to invoke: 'swagger-cli', 'redocly', 'npx redocly', or 'npx @redocly/cli'.
 * @param {string[]|string} fragmentFiles - Array of fragment file paths to merge or a single entrypoint file path.
 * @param {string} outputPath - Filesystem path where the bundled OpenAPI YAML will be written.
 * @param {string} tempDir - Existing temporary directory used to create a merged entrypoint when multiple fragments are provided.
 * @param {boolean} [quiet=false] - If true, suppresses console output from this function and child process stdio.
 * @throws {Error} If input validation fails, the bundler process times out or exits with an error, or the output file is missing or empty.
 */
function runBundler(bundler, fragmentFiles, outputPath, tempDir, quiet = false) {
  if (!bundler || typeof bundler !== 'string') {
    throw new Error('Invalid bundler specified');
  }
  
  if (!fragmentFiles || (Array.isArray(fragmentFiles) && fragmentFiles.length === 0)) {
    throw new Error('No fragment files provided for bundling');
  }
  
  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error('Invalid output path specified');
  }
  
  if (!tempDir || !fs.existsSync(tempDir)) {
    throw new Error('Invalid temporary directory');
  }

  const stdio = quiet ? 'ignore' : 'inherit';
  const timeout = 120000; // 2 minutes timeout
  
  // If we have multiple fragments, we need to merge them first since bundlers
  // typically expect a single entrypoint file
  let entrypoint;
  
  try {
    if (Array.isArray(fragmentFiles) && fragmentFiles.length > 1) {
      // Create a merged entrypoint file
      entrypoint = path.join(tempDir, 'merged-entrypoint.yaml');
      
      const mergedContent = {
        openapi: '3.1.0',
        info: {
          title: 'Redpanda Admin API',
          version: '2.0.0'
        },
        paths: {},
        components: {
          schemas: {}
        }
      };
      
      // Manually merge all fragment files
      for (const filePath of fragmentFiles) {
        try {
          if (!fs.existsSync(filePath)) {
            console.warn(`⚠️ Fragment file not found: ${filePath}`);
            continue;
          }
          
          const fragmentContent = fs.readFileSync(filePath, 'utf8');
          const fragmentData = yaml.parse(fragmentContent);
          
          if (!fragmentData || typeof fragmentData !== 'object') {
            console.warn(`⚠️ Invalid fragment data in: ${filePath}`);
            continue;
          }
          
          // Merge paths
          if (fragmentData.paths && typeof fragmentData.paths === 'object') {
            Object.assign(mergedContent.paths, fragmentData.paths);
          }
          
          // Merge components
          if (fragmentData.components && typeof fragmentData.components === 'object') {
            if (fragmentData.components.schemas) {
              Object.assign(mergedContent.components.schemas, fragmentData.components.schemas);
            }
            // Merge other component types
            const componentTypes = ['responses', 'parameters', 'examples', 'requestBodies', 'headers', 'securitySchemes', 'links', 'callbacks'];
            for (const componentType of componentTypes) {
              if (fragmentData.components[componentType]) {
                if (!mergedContent.components[componentType]) {
                  mergedContent.components[componentType] = {};
                }
                Object.assign(mergedContent.components[componentType], fragmentData.components[componentType]);
              }
            }
          }
        } catch (error) {
          console.warn(`⚠️ Failed to parse fragment ${filePath}: ${error.message}`);
        }
      }
      
      // Validate merged content
      if (Object.keys(mergedContent.paths).length === 0) {
        throw new Error('No valid paths found in any fragments');
      }
      
      fs.writeFileSync(entrypoint, yaml.stringify(mergedContent), 'utf8');
      
      if (!quiet) {
        console.log(`📄 Created merged entrypoint with ${Object.keys(mergedContent.paths).length} paths`);
      }
    } else {
      // Single file or string entrypoint
      entrypoint = Array.isArray(fragmentFiles) ? fragmentFiles[0] : fragmentFiles;
      
      if (!fs.existsSync(entrypoint)) {
        throw new Error(`Entrypoint file not found: ${entrypoint}`);
      }
    }
    
    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    fs.mkdirSync(outputDir, { recursive: true });
    
    let result;
    if (bundler === 'swagger-cli') {
      result = spawnSync('swagger-cli', ['bundle', entrypoint, '-o', outputPath, '-t', 'yaml'], {
        stdio,
        timeout
      });
    } else if (bundler === 'redocly') {
      result = spawnSync('redocly', ['bundle', entrypoint, '--output', outputPath], {
        stdio,
        timeout
      });
    } else if (bundler === 'npx redocly') {
      result = spawnSync('npx', ['redocly', 'bundle', entrypoint, '--output', outputPath], {
        stdio,
        timeout
      });
    } else if (bundler === 'npx @redocly/cli') {
      result = spawnSync('npx', ['@redocly/cli', 'bundle', entrypoint, '--output', outputPath], {
        stdio,
        timeout
      });
    } else {
      throw new Error(`Unknown bundler: ${bundler}`);
    }
    
    if (result.error) {
      if (result.error.code === 'ETIMEDOUT') {
        throw new Error(`Bundler timed out after ${timeout / 1000} seconds`);
      }
      throw new Error(`Bundler execution failed: ${result.error.message}`);
    }
    
    if (result.status !== 0) {
      const errorMsg = result.stderr ? result.stderr.toString() : 'Unknown error';
      throw new Error(`${bundler} bundle failed with exit code ${result.status}: ${errorMsg}`);
    }
    
    // Verify output file was created
    if (!fs.existsSync(outputPath)) {
      throw new Error(`Bundler completed but output file not found: ${outputPath}`);
    }
    
    const stats = fs.statSync(outputPath);
    if (stats.size === 0) {
      throw new Error(`Bundler created empty output file: ${outputPath}`);
    }
    
    if (!quiet) {
      console.log(`✅ Bundle created: ${outputPath} (${Math.round(stats.size / 1024)}KB)`);
    }
    
  } catch (error) {
    // Clean up temporary entrypoint file on error
    if (entrypoint && entrypoint !== fragmentFiles && fs.existsSync(entrypoint)) {
      try {
        fs.unlinkSync(entrypoint);
      } catch {
        // Ignore cleanup errors
      }
    }
    throw error;
  }
}

/**
 * Update bundle metadata, enforce a deterministic key order, and rewrite the bundled OpenAPI YAML.
 *
 * Reads the bundled YAML at `filePath`, validates and augments its `info` object (titles, descriptions,
 * version fields and x- metadata) based on `options.surface` and provided version information, sorts
 * object keys deterministically, and writes the updated YAML back to `filePath`.
 *
 * @param {string} filePath - Path to the bundled OpenAPI YAML file to process.
 * @param {Object} options - Processing options.
 * @param {'admin'|'connect'} options.surface - API surface to target; affects title and description.
 * @param {string} [options.tag] - Git tag used for versioning (may be normalized internally).
 * @param {string} [options.normalizedTag] - Pre-normalized version string to use instead of `tag`.
 * @param {string} [options.majorMinor] - Major.minor version to set in `info.version`.
 * @param {string} [options.adminMajor] - Admin API major version to set as `x-admin-api-major`.
 * @param {boolean} [options.useAdminMajorVersion] - When true and surface is 'admin', prefer `adminMajor` for `info.version`.
 * @param {boolean} [quiet=false] - Suppress console output when true.
 * @returns {Object} The processed OpenAPI bundle object with keys sorted deterministically.
 * @throws {Error} If inputs are missing/invalid, the file is absent or empty, YAML parsing fails, or processing cannot complete.
 */
function postProcessBundle(filePath, options, quiet = false) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('Bundle file not found');
  }
  
  if (!fs.existsSync(filePath)) {
    throw new Error('Bundle file not found');
  }
  
  if (!options || typeof options !== 'object') {
    throw new Error('Missing required options');
  }
  
  const { surface, tag, majorMinor, adminMajor, normalizedTag, useAdminMajorVersion } = options;
  
  if (!surface || !['admin', 'connect'].includes(surface)) {
    throw new Error('Invalid API surface');
  }
  
  // Require at least one version identifier  
  if (!tag && !normalizedTag && !majorMinor) {
    throw new Error('Missing required options');
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim()) {
      throw new Error('Bundle file is empty');
    }
    
    let bundle;
    try {
      bundle = yaml.parse(content);
    } catch (parseError) {
      throw new Error(`Invalid YAML in bundle file: ${parseError.message}`);
    }
    
    if (!bundle || typeof bundle !== 'object') {
      throw new Error('Bundle file does not contain valid OpenAPI structure');
    }

    // Normalize the tag and extract version info
    const normalizedVersion = normalizedTag || (tag ? normalizeTag(tag) : '1.0.0');
    let versionMajorMinor;
    
    if (useAdminMajorVersion && surface === 'admin' && adminMajor) {
      // Use admin major version for info.version when flag is set
      versionMajorMinor = adminMajor;
    } else {
      // Use normalized tag version (default behavior)
      versionMajorMinor = majorMinor || (normalizedVersion !== '1.0.0' ? getMajorMinor(normalizedVersion) : '1.0');
    }
    
    // Update info section with proper metadata
    if (!bundle.info) {
      bundle.info = {};
    }
    
    bundle.info.version = versionMajorMinor;
    
    if (surface === 'admin') {
      bundle.info.title = 'Redpanda Admin API';
      bundle.info.description = 'Redpanda Admin API specification';
      if (adminMajor) {
        bundle.info['x-admin-api-major'] = adminMajor;
      }
    } else if (surface === 'connect') {
      bundle.info.title = 'Redpanda Connect RPCs';
      bundle.info.description = 'Redpanda Connect API specification';
    }
    
    // Additional metadata expected by tests
    if (tag || normalizedTag) {
      bundle.info['x-redpanda-core-version'] = tag || normalizedTag || normalizedVersion;
    }
    bundle.info['x-generated-at'] = new Date().toISOString();
    bundle.info['x-generator'] = 'redpanda-docs-openapi-bundler';

    // Sort keys for deterministic output
    const sortedBundle = sortObjectKeys(bundle);
    
    // Write back to file
    fs.writeFileSync(filePath, yaml.stringify(sortedBundle, {
      lineWidth: 0,
      minContentWidth: 0,
      indent: 2
    }), 'utf8');
    
    if (!quiet) {
      console.log(`📝 Updated bundle metadata: version=${normalizedVersion}`);
    }

    return sortedBundle;
    
  } catch (error) {
    throw new Error(`Post-processing failed: ${error.message}`);
  }
}

/**
 * Bundle OpenAPI fragments for the specified API surfaces from a repository tag and write the resulting bundled YAML files to disk.
 *
 * @param {Object} options - Configuration options.
 * @param {string} options.tag - Git tag to checkout (for example, 'v25.1.1').
 * @param {'admin'|'connect'|'both'} options.surface - API surface to process.
 * @param {string} [options.output] - Standalone output file path; when provided, used for the single output file.
 * @param {string} [options.outAdmin] - Output path for the admin API when integrating with doc-tools mode.
 * @param {string} [options.outConnect] - Output path for the connect API when integrating with doc-tools mode.
 * @param {string} [options.repo] - Repository URL to clone (defaults to https://github.com/redpanda-data/redpanda.git).
 * @param {string} [options.adminMajor] - Admin API major version string used for metadata (for example, 'v2.0.0').
 * @param {boolean} [options.useAdminMajorVersion] - When true and processing the admin surface, use `adminMajor` for the bundle info.version.
 * @param {boolean} [options.quiet=false] - Suppress logging to stdout/stderr when true.
 * @returns {Object|Object[]} An object (for a single surface) or an array of objects (for both surfaces) with fields:
 *   - surface: processed surface name ('admin' or 'connect'),
 *   - outputPath: final written file path,
 *   - fragmentCount: number of OpenAPI fragment files processed,
 *   - bundler: name or command of the bundler used.
 */
async function bundleOpenAPI(options) {
  const { tag, surface, output, outAdmin, outConnect, repo, adminMajor, useAdminMajorVersion, quiet = false } = options;
  
  // Validate required parameters
  if (!tag) {
    throw new Error('Git tag is required');
  }
  
  if (!surface || !['admin', 'connect', 'both'].includes(surface)) {
    throw new Error('API surface must be "admin", "connect", or "both"');
  }
  
  // Handle different surface options
  const surfaces = surface === 'both' ? ['admin', 'connect'] : [surface];
  const results = [];

  const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'openapi-bundle-'));
  
  // Set up cleanup handlers
  const cleanup = () => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.error(`Warning: Failed to cleanup temporary directory: ${error.message}`);
    }
  };
  
  // Create dedicated handlers that clean up and then terminate
  const cleanupAndExit = (signal) => {
    return () => {
      cleanup();
      process.exit(signal === 'SIGTERM' ? 0 : 1);
    };
  };
  
  const cleanupAndCrash = (error) => {
    cleanup();
    console.error('Fatal error:', error);
    process.exit(1);
  };
  
  // Handle graceful shutdown and crashes
  const sigintHandler = cleanupAndExit('SIGINT');
  const sigtermHandler = cleanupAndExit('SIGTERM');
  
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);
  process.on('uncaughtException', cleanupAndCrash);
  
  try {
    // Clone repository (only once for all surfaces)
    if (!quiet) {
      console.log('📥 Cloning redpanda repository...');
    }

    const { getAuthenticatedGitHubUrl, hasGitHubToken } = require('../cli-utils/github-token');

    let repositoryUrl = repo || 'https://github.com/redpanda-data/redpanda.git';

    // Use token if available for better rate limits and reliability
    if (hasGitHubToken() && repositoryUrl.includes('github.com')) {
      repositoryUrl = getAuthenticatedGitHubUrl(repositoryUrl);
      if (!quiet) {
        console.log('🔑 Using authenticated clone (token provided)');
      }
    }

    try {
      execSync(`git clone --depth 1 --branch ${tag} ${repositoryUrl} redpanda`, {
        cwd: tempDir,
        stdio: quiet ? 'ignore' : 'inherit',
        timeout: 60000 // 1 minute timeout
      });
    } catch (cloneError) {
      throw new Error(`Failed to clone repository: ${cloneError.message}`);
    }

    const repoDir = path.join(tempDir, 'redpanda');
    
    // Verify repository was cloned
    if (!fs.existsSync(repoDir)) {
      throw new Error('Repository clone failed - directory not found');
    }

    // Run buf generate
    if (!quiet) {
      console.log('🔧 Running buf generate...');
    }
    
    try {
      execSync('buf generate --template buf.gen.openapi.yaml', {
        cwd: repoDir,
        stdio: quiet ? 'ignore' : 'inherit',
        timeout: 120000 // 2 minutes timeout
      });
    } catch (bufError) {
      throw new Error(`buf generate failed: ${bufError.message}`);
    }

    // Process each surface
    for (const currentSurface of surfaces) {
      // Determine output path based on mode (standalone vs doc-tools integration)
      let finalOutput;
      if (output) {
        // Standalone mode with explicit output
        finalOutput = output;
      } else if (currentSurface === 'admin' && outAdmin) {
        // Doc-tools mode with admin output
        finalOutput = outAdmin;
      } else if (currentSurface === 'connect' && outConnect) {
        // Doc-tools mode with connect output
        finalOutput = outConnect;
      } else {
        // Default paths
        finalOutput = currentSurface === 'admin' 
          ? 'admin/redpanda-admin-api.yaml'
          : 'connect/redpanda-connect-api.yaml';
      }

      if (!quiet) {
        console.log(`🚀 Bundling OpenAPI for ${currentSurface} API (tag: ${tag})`);
        console.log(`📁 Output: ${finalOutput}`);
      }

      // Find OpenAPI fragments
      const fragmentFiles = createEntrypoint(repoDir, currentSurface);
      
      if (!quiet) {
        console.log(`📋 Found ${fragmentFiles.length} OpenAPI fragments`);
        fragmentFiles.forEach(file => {
          const relativePath = path.relative(repoDir, file);
          console.log(`   ${relativePath}`);
        });
      }

      // Detect and use bundler
      const bundler = detectBundler(quiet);
      
      // Bundle the OpenAPI fragments
      if (!quiet) {
        console.log('🔄 Bundling OpenAPI fragments...');
      }
      
      const tempOutput = path.join(tempDir, `bundled-${currentSurface}.yaml`);
      await runBundler(bundler, fragmentFiles, tempOutput, tempDir, quiet);

      // Post-process the bundle
      if (!quiet) {
        console.log('📝 Post-processing bundle...');
      }
      
      const postProcessOptions = {
        surface: currentSurface,
        tag: tag,
        majorMinor: getMajorMinor(normalizeTag(tag)),
        adminMajor: adminMajor,
        useAdminMajorVersion: useAdminMajorVersion
      };
      
      postProcessBundle(tempOutput, postProcessOptions, quiet);

      // Move to final output location
      const outputDir = path.dirname(finalOutput);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      fs.copyFileSync(tempOutput, finalOutput);
      
      if (!quiet) {
        const stats = fs.statSync(finalOutput);
        console.log(`✅ Bundle complete: ${finalOutput} (${Math.round(stats.size / 1024)}KB)`);
      }

      results.push({
        surface: currentSurface,
        outputPath: finalOutput,
        fragmentCount: fragmentFiles.length,
        bundler: bundler
      });
    }

    return results.length === 1 ? results[0] : results;

  } catch (error) {
    if (!quiet) {
      console.error(`❌ Bundling failed: ${error.message}`);
    }
    throw error;
  } finally {
    // Remove event handlers to restore default behavior
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
    process.removeListener('uncaughtException', cleanupAndCrash);
    
    cleanup();
  }
}

// Export functions for testing
module.exports = {
  bundleOpenAPI,
  normalizeTag,
  getMajorMinor,
  sortObjectKeys,
  detectBundler,
  createEntrypoint,
  postProcessBundle
};

// CLI interface if run directly
if (require.main === module) {
  const { program } = require('commander');
  
  program
    .name('bundle-openapi')
    .description('Bundle OpenAPI fragments from Redpanda repository')
    .requiredOption('-t, --tag <tag>', 'Git tag to checkout (for example, v25.1.1)')
    .requiredOption('-s, --surface <surface>', 'API surface', (value) => {
      if (!['admin', 'connect', 'both'].includes(value)) {
        throw new Error('Invalid API surface. Must be "admin", "connect", or "both"');
      }
      return value;
    })
    .option('-o, --output <path>', 'Output file path (defaults: admin/redpanda-admin-api.yaml or connect/redpanda-connect-api.yaml)')
    .option('--out-admin <path>', 'Output path for admin API', 'admin/redpanda-admin-api.yaml')
    .option('--out-connect <path>', 'Output path for connect API', 'connect/redpanda-connect-api.yaml')
    .option('--repo <url>', 'Repository URL', 'https://github.com/redpanda-data/redpanda.git')
    .option('--admin-major <string>', 'Admin API major version', 'v2.0.0')
    .option('--use-admin-major-version', 'Use admin major version for info.version instead of git tag', false)
    .option('-q, --quiet', 'Suppress output', false)
    .action(async (options) => {
      try {
        await bundleOpenAPI(options);
        process.exit(0);
      } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    });

  program.parse();
}