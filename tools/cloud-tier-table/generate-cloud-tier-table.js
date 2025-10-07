const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const fetch = globalThis.fetch;

// Hardcoded list of keys to extract (top-level and cluster_config)
const LIMIT_KEYS = [
  // Top-level
  'cloud_provider',
  'machine_type',
  'nodes_count',
  // Master data advertised limits
  'advertisedMaxIngress',
  'advertisedMaxEgress', 
  'advertisedMaxPartitionCount',
  'advertisedMaxClientCount',
  // cluster_config
  'topic_partitions_per_shard',
  'topic_memory_per_partition',
  'kafka_connections_max',
  'max_concurrent_producer_ids',
  'log_segment_size',
  'log_segment_size_min',
  'log_segment_size_max',
  'compacted_log_segment_size',
  'max_compacted_log_segment_size',
  'retention_local_target_capacity_percent',
  'cloud_storage_cache_size_percent',
  'retention_local_target_ms_default',
  'cloud_storage_segment_max_upload_interval_sec',
  'log_segment_ms_min',
  'kafka_connection_rate_limit',
  'kafka_throughput_limit_node_in_bps',
  'kafka_throughput_limit_node_out_bps',
  'kafka_batch_max_bytes',
  'kafka_topics_max',
];

/**
 * Map a header key to a human-readable label.
 * @param {string} key - The header key to convert.
 * @returns {string} The human-readable label for `key`, or `key` unchanged if no mapping exists.
 */
function humanLabel(key) {
  if (key === 'cloud_provider') return 'Cloud Provider';
  if (key === 'machine_type') return 'Machine Type';
  if (key === 'nodes_count') return 'Number of Nodes';
  if (key === 'advertisedMaxIngress') return 'Max Ingress (bps)';
  if (key === 'advertisedMaxEgress') return 'Max Egress (bps)';
  if (key === 'advertisedMaxPartitionCount') return 'Max Partitions';
  if (key === 'advertisedMaxClientCount') return 'Max Client Connections';
  return key;
}

/**
 * Convert a provider identifier into a human-friendly provider name.
 * @param {*} val - Provider identifier (e.g., 'aws', 'gcp', 'azure'); comparison is case-insensitive. Falsy values produce an empty string.
 * @returns {string} `'AWS'`, `'GCP'`, or `'Azure'` for known providers; empty string for falsy input; otherwise returns the original value.
 */
function humanProvider(val) {
  if (!val) return '';
  const map = { aws: 'AWS', gcp: 'GCP', azure: 'Azure' };
  return map[String(val).toLowerCase()] || val;
}

/**
 * Loads master-data.yaml (from an HTTP URL or local path), validates its products list, and returns a normalized list of public tiers.
 *
 * @param {string} masterDataUrl - HTTP URL (GitHub API file response expected) or local filesystem path to the master-data.yaml file.
 * @returns {Array<Object>} An array of public tier objects with the following fields: `displayName`, `configProfileName`, `cloudProvider`, `advertisedMaxIngress`, `advertisedMaxEgress`, `advertisedMaxPartitionCount`, and `advertisedMaxClientCount`.
 * @throws {Error} If masterDataUrl is missing or not a string, fetching or file reading fails, YAML parsing fails, the products array is missing/invalid, or no valid public tiers are found.
 */
async function fetchPublicTiers(masterDataUrl) {
  try {
    if (!masterDataUrl || typeof masterDataUrl !== 'string') {
      throw new Error('masterDataUrl must be a valid string');
    }

    const headers = {};
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
      headers['User-Agent'] = 'cloud-tier-table-tool';
    }
    
    let masterDataYaml;
    if (masterDataUrl.startsWith('http')) {
      // Fetch from GitHub API
      const response = await fetch(masterDataUrl, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch master data: ${response.status} ${response.statusText}`);
      }
      const data = await response.json();
      if (!data.content) {
        throw new Error('GitHub API response missing content field');
      }
      masterDataYaml = Buffer.from(data.content, 'base64').toString('utf8');
    } else {
      if (!fs.existsSync(masterDataUrl)) {
        throw new Error(`Local master data file not found: ${masterDataUrl}`);
      }
      masterDataYaml = fs.readFileSync(masterDataUrl, 'utf8');
    }
    
    let masterData;
    try {
      masterData = yaml.load(masterDataYaml);
    } catch (error) {
      throw new Error(`Failed to parse master data YAML: ${error.message}`);
    }
    
    if (!masterData || typeof masterData !== 'object') {
      throw new Error('Master data is not a valid object');
    }
    if (!masterData.products || !Array.isArray(masterData.products)) {
      throw new Error('Master data missing or invalid products array');
    }
    
    let processedCount = 0;
    let filteredCount = 0;
    const errors = [];
    
    const publicTiers = masterData.products
      .filter((product, index) => {
        try {
          if (!product || typeof product !== 'object') {
            errors.push(`Product at index ${index} is not a valid object`);
            return false;
          }
          if (!product.displayName) {
            errors.push(`Product at index ${index} missing displayName`);
            return false;
          }
          if (!product.redpandaConfigProfileName) {
            errors.push(`Product "${product.displayName}" missing redpandaConfigProfileName`);
            return false;
          }
          if (product.isPublic !== true) {
            filteredCount++;
            return false;
          }
          processedCount++;
          return true;
        } catch (error) {
          errors.push(`Error processing product at index ${index}: ${error.message}`);
          return false;
        }
      })
      .map(product => ({
        displayName: product.displayName,
        configProfileName: product.redpandaConfigProfileName,
        cloudProvider: product.cloudProvider,
        advertisedMaxIngress: product.advertisedMaxIngress,
        advertisedMaxEgress: product.advertisedMaxEgress,
        advertisedMaxPartitionCount: product.advertisedMaxPartitionCount,
        advertisedMaxClientCount: product.advertisedMaxClientCount
      }));
    
    // Log processing summary
    if (process.env.DEBUG_TIER_PROCESSING || errors.length > 0) {
      console.log(`Master data processing summary: ${processedCount} public tiers, ${filteredCount} filtered out, ${errors.length} errors`);
      if (errors.length > 0) {
        console.warn('Master data processing errors:');
        errors.forEach(error => console.warn(`  - ${error}`));
      }
    }
    
    if (publicTiers.length === 0) {
      throw new Error('No valid public tiers found in master data');
    }
    
    return publicTiers;
  } catch (error) {
    console.error(`Error fetching public tiers: ${error.message}`);
    throw new Error(`Failed to fetch public tiers: ${error.message}`);
  }
}

/**
 * Load and parse YAML from a local file path, HTTP(S) URL, or the special GitHub install-pack API directory.
 *
 * When given the GitHub install-pack API directory URL, selects the latest versioned YAML file (names like `1.2.yml` or `1.2.3.yaml`) and parses it. For HTTP(S) inputs, fetches the URL and parses the response body. For local file paths, reads and parses the file contents. If GITHUB_TOKEN is set, requests include Authorization and User-Agent headers.
 *
 * @param {string} input - Local filesystem path, HTTP(S) URL, or the GitHub API directory URL 'https://api.github.com/repos/redpanda-data/cloudv2/contents/install-pack'.
 * @returns {Object} The parsed YAML content as a JavaScript object.
 * @throws {Error} If `input` is not a valid string, the network or filesystem access fails, no suitable versioned YAML is found in the install-pack directory, or the YAML content cannot be parsed into an object.
 */
async function parseYaml(input) {
  try {
    if (!input || typeof input !== 'string') {
      throw new Error('input parameter must be a valid string');
    }

    // If input is the special API directory, fetch the latest version YAML
    const apiDir = 'https://api.github.com/repos/redpanda-data/cloudv2/contents/install-pack';
    if (input === apiDir) {
      const headers = {};
      if (process.env.GITHUB_TOKEN) {
        headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
        headers['User-Agent'] = 'cloud-tier-table-tool';
      }
      
      let res;
      try {
        res = await fetch(apiDir, { headers });
      } catch (error) {
        throw new Error(`Network error fetching install-pack directory: ${error.message}`);
      }
      
      if (!res.ok) {
        throw new Error(`Failed to fetch install-pack directory: ${res.status} ${res.statusText}`);
      }
      
      let files;
      try {
        files = await res.json();
      } catch (error) {
        throw new Error(`Failed to parse install-pack directory response: ${error.message}`);
      }
      
      if (!Array.isArray(files)) {
        throw new Error('Install-pack directory response is not an array');
      }
      
      // Find YAML files with version numbers
      const versionFiles = files.filter(f => {
        if (!f.name || !f.download_url) return false;
        if (!(f.name.endsWith('.yml') || f.name.endsWith('.yaml'))) return false;
        const versionPart = f.name.replace(/\.(yml|yaml)$/i, '');
        // Require at least major.minor, and all segments must be numeric (no trailing dot, no empty segments)
        // E.g. 1.2, 1.2.3, 10.0.1 are valid; 1, 1., 1..2, 1.2a, 1.2. are not
        if (!/^\d+\.\d+(?:\.\d+)*$/.test(versionPart)) return false;
        const segments = versionPart.split('.');
        return segments.every(seg => /^\d+$/.test(seg));
      });
      
      if (!versionFiles.length) {
        throw new Error('No version YAML files found in cloudv2/install-pack directory.');
      }
      
      // Parse and sort by version
      const sortedFiles = versionFiles
        .map(f => {
          const versionPart = f.name.replace(/\.(yml|yaml)$/i, '');
          const segments = versionPart.split('.').map(s => parseInt(s, 10));
          return { ...f, version: segments };
        })
        .sort((a, b) => {
          // Compare version arrays lexicographically
          for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
            const aVal = a.version[i] || 0;
            const bVal = b.version[i] || 0;
            if (aVal !== bVal) return bVal - aVal; // Descending order
          }
          return 0;
        });
      
      const latestFile = sortedFiles[0];
      console.log(`Using latest version file: ${latestFile.name}`);
      
      let yamlResponse;
      try {
        yamlResponse = await fetch(latestFile.download_url, { headers });
      } catch (error) {
        throw new Error(`Network error fetching ${latestFile.name}: ${error.message}`);
      }
      
      if (!yamlResponse.ok) {
        throw new Error(`Failed to fetch ${latestFile.name}: ${yamlResponse.status} ${yamlResponse.statusText}`);
      }
      
      let yamlText;
      try {
        yamlText = await yamlResponse.text();
      } catch (error) {
        throw new Error(`Failed to read YAML content from ${latestFile.name}: ${error.message}`);
      }
      
      try {
        return yaml.load(yamlText);
      } catch (error) {
        throw new Error(`Failed to parse YAML from ${latestFile.name}: ${error.message}`);
      }
    }
    
    // Handle URL or local file
    let yamlText;
    if (input.startsWith('http')) {
      const headers = {};
      if (process.env.GITHUB_TOKEN) {
        headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
        headers['User-Agent'] = 'cloud-tier-table-tool';
      }
      
      let response;
      try {
        response = await fetch(input, { headers });
      } catch (error) {
        throw new Error(`Network error fetching ${input}: ${error.message}`);
      }
      
      if (!response.ok) {
        throw new Error(`Failed to fetch ${input}: ${response.status} ${response.statusText}`);
      }
      
      try {
        yamlText = await response.text();
      } catch (error) {
        throw new Error(`Failed to read content from ${input}: ${error.message}`);
      }
    } else {
      // Local file
      const fs = require('fs');
      if (!fs.existsSync(input)) {
        throw new Error(`Local file not found: ${input}`);
      }
      
      try {
        yamlText = fs.readFileSync(input, 'utf8');
      } catch (error) {
        throw new Error(`Failed to read local file ${input}: ${error.message}`);
      }
    }
    
    try {
      const parsed = yaml.load(yamlText);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('YAML content is not a valid object');
      }
      return parsed;
    } catch (error) {
      throw new Error(`Failed to parse YAML content: ${error.message}`);
    }
  } catch (error) {
    console.error(`Error parsing YAML from "${input}": ${error.message}`);
    throw error;
  }
}


/**
 * Extract version number from config profile name
 * @param {string} profileName - Config profile name like "tier-2-aws-v3-arm"
 * @returns {number} Version number or 0 if no version found
 */
function extractVersion(profileName) {
  try {
    if (!profileName || typeof profileName !== 'string') {
      return 0;
    }
    const versionMatch = profileName.match(/-v(\d+)(?:-|$)/);
    return versionMatch ? parseInt(versionMatch[1], 10) : 0;
  } catch (error) {
    console.warn(`Warning: Failed to extract version from profile name "${profileName}": ${error.message}`);
    return 0;
  }
}

/**
 * Selects the highest-versioned config profile name matching the given target profile.
 *
 * @param {Object} configProfiles - Map of profile names to profile definitions.
 * @param {string} targetProfile - The target profile name to match (from master data).
 * @returns {string} The matching profile name with the largest numeric `-vN` suffix, or `targetProfile` if no versioned variants are found or on failure.
 */
function findHighestVersionProfile(configProfiles, targetProfile) {
  try {
    if (!configProfiles || typeof configProfiles !== 'object') {
      throw new Error('configProfiles must be a valid object');
    }
    if (!targetProfile || typeof targetProfile !== 'string') {
      throw new Error('targetProfile must be a valid string');
    }

    // If exact match exists, check for versioned variants
    if (configProfiles[targetProfile]) {
      // Look for versioned variants of this profile
      const baseName = targetProfile.replace(/-v\d+/, ''); // Remove existing version if any
      const versionedProfiles = Object.keys(configProfiles)
        .filter(name => {
          try {
            // Match profiles that start with the base name and have version suffix
            const withoutVersion = name.replace(/-v\d+/, '');
            return withoutVersion === baseName;
          } catch (error) {
            console.warn(`Warning: Failed to process profile name "${name}": ${error.message}`);
            return false;
          }
        })
        .map(name => ({
          name,
          version: extractVersion(name)
        }))
        .sort((a, b) => b.version - a.version); // Sort by version descending
      
      if (versionedProfiles.length > 0) {
        const selectedProfile = versionedProfiles[0].name;
        if (process.env.DEBUG_TIER_SELECTION) {
          console.log(`Debug: Selected "${selectedProfile}" (v${versionedProfiles[0].version}) from ${versionedProfiles.length} variants of "${targetProfile}"`);
        }
        return selectedProfile;
      }
    }
    
    return targetProfile;
  } catch (error) {
    console.error(`Error finding highest version profile for "${targetProfile}": ${error.message}`);
    return targetProfile; // Fallback to original profile name
  }
}

/**
 * Builds table row objects by merging public tier metadata with matching config profiles.
 *
 * Each returned row maps the tier display name to the requested limit keys (either `customLimits` or the module's default keys).
 * Missing values are represented as the string "N/A". Duplicate rows with the same tier name and resolved config profile are removed.
 *
 * @param {Object} tiers - Parsed tiers YAML object; must contain a `config_profiles` object mapping profile names to definitions.
 * @param {Array<Object>} publicTiers - Array of public tier descriptors; each entry must include `displayName` and `configProfileName`.
 * @param {Array<string>} [customLimits] - Optional list of limit keys to extract; when omitted the module's default LIMIT_KEYS are used.
 * @returns {Array<Object>} An array of row objects. Each row has a `tier` property (display name) and entries for each requested limit key.
 * @throws {Error} If inputs are invalid or row construction fails (e.g., missing `config_profiles`, non-array `publicTiers`, or other fatal processing errors).
 */
function buildTableRows(tiers, publicTiers, customLimits) {
  try {
    // Use custom limits if provided, otherwise use default LIMIT_KEYS
    const limitKeys = customLimits && Array.isArray(customLimits) && customLimits.length > 0 
      ? customLimits 
      : LIMIT_KEYS;

    // Validate inputs
    if (!tiers || typeof tiers !== 'object') {
      throw new Error('tiers parameter must be a valid object');
    }
    if (!tiers.config_profiles || typeof tiers.config_profiles !== 'object') {
      throw new Error('tiers.config_profiles must be a valid object');
    }
    if (!publicTiers || !Array.isArray(publicTiers)) {
      throw new Error('publicTiers parameter must be a valid array');
    }

    let processedCount = 0;
    let errorCount = 0;
    const errors = [];

    const rows = publicTiers
      .map((publicTier, index) => {
        try {
          if (!publicTier || typeof publicTier !== 'object') {
            throw new Error(`Public tier at index ${index} is not a valid object`);
          }
          if (!publicTier.configProfileName) {
            throw new Error(`Public tier at index ${index} missing configProfileName`);
          }
          if (!publicTier.displayName) {
            throw new Error(`Public tier at index ${index} missing displayName`);
          }

          // Find the highest version profile for this tier
          const actualProfileName = findHighestVersionProfile(tiers.config_profiles, publicTier.configProfileName);
          return { ...publicTier, actualProfileName };
        } catch (error) {
          errorCount++;
          errors.push(`Error processing public tier ${index}: ${error.message}`);
          return null;
        }
      })
      .filter(publicTier => {
        if (!publicTier) return false;
        const exists = tiers.config_profiles[publicTier.actualProfileName];
        if (!exists) {
          errorCount++;
          errors.push(`Config profile "${publicTier.actualProfileName}" not found for tier "${publicTier.displayName}"`);
        }
        return exists;
      })
      .map(publicTier => {
        try {
          const configProfile = tiers.config_profiles[publicTier.actualProfileName];
          const row = { tier: publicTier.displayName };
          
          for (const key of limitKeys) {
            try {
              let value;
              
              // Check if this is a master data field first
              if (['advertisedMaxIngress', 'advertisedMaxEgress', 'advertisedMaxPartitionCount', 'advertisedMaxClientCount'].includes(key)) {
                value = publicTier[key] || 'N/A';
              } else if (configProfile[key] !== undefined) {
                value = configProfile[key];
              } else if (configProfile.cluster_config && configProfile.cluster_config[key] !== undefined) {
                value = configProfile.cluster_config[key];
              } else {
                value = 'N/A';
              }
              
              // Humanize provider value
              if (key === 'cloud_provider') {
                value = humanProvider(value);
              }
              row[key] = value;
            } catch (error) {
              console.warn(`Warning: Failed to process key "${key}" for tier "${publicTier.displayName}": ${error.message}`);
              row[key] = 'N/A';
            }
          }
          
          // Add the actual profile name for deduplication
          row._actualProfileName = publicTier.actualProfileName;
          processedCount++;
          return row;
        } catch (error) {
          errorCount++;
          errors.push(`Error building row for tier "${publicTier.displayName}": ${error.message}`);
          return null;
        }
      })
      .filter(row => row !== null)
      // Deduplicate rows that have the same tier name and actual config profile
      .filter((row, index, array) => {
        try {
          const duplicateIndex = array.findIndex(other => 
            other.tier === row.tier && 
            other._actualProfileName === row._actualProfileName
          );
          return duplicateIndex === index; // Keep only the first occurrence
        } catch (error) {
          console.warn(`Warning: Failed to deduplicate row for tier "${row.tier}": ${error.message}`);
          return true; // Keep the row if deduplication fails
        }
      })
      // Remove the internal _actualProfileName field
      .map(row => {
        try {
          const { _actualProfileName, ...cleanRow } = row;
          return cleanRow;
        } catch (error) {
          console.warn(`Warning: Failed to clean row for tier "${row.tier}": ${error.message}`);
          return row; // Return original row if cleaning fails
        }
      });

    // Log processing summary
    if (process.env.DEBUG_TIER_PROCESSING || errors.length > 0) {
      console.log(`Tier processing summary: ${processedCount} processed, ${errorCount} errors, ${rows.length} final rows`);
      if (errors.length > 0) {
        console.warn('Processing errors:');
        errors.forEach(error => console.warn(`  - ${error}`));
      }
    }

    return rows;
  } catch (error) {
    console.error(`Fatal error in buildTableRows: ${error.message}`);
    throw new Error(`Failed to build table rows: ${error.message}`);
  }
}

/**
 * Render an array of tier rows as a Markdown table.
 *
 * @param {Array<Object>} rows - Array of row objects where each row has a `tier` property and keys matching entries in `limitKeys`.
 * @param {Array<string>} [limitKeys=LIMIT_KEYS] - Ordered list of keys to include as columns after the "Tier" column; each key's value is taken from the corresponding property on a row.
 * @returns {string} A Markdown-formatted table with a header row ("Tier" followed by the provided keys' labels) and one row per entry in `rows`.
 */
function toMarkdown(rows, limitKeys = LIMIT_KEYS) {
  const headers = ['Tier', ...limitKeys.map(humanLabel)];
  const lines = [];
  lines.push('| ' + headers.join(' | ') + ' |');
  lines.push('|' + headers.map(() => '---').join('|') + '|');
  for (const row of rows) {
    lines.push('| ' + [row.tier, ...limitKeys.map(k => row[k])].join(' | ') + ' |');
  }
  return lines.join('\n');
}

/**
 * Render table rows as an AsciiDoc table.
 *
 * @param {Array<Object>} rows - Array of row objects; each object must include a `tier` property and values for the keys listed in `limitKeys`.
 * @param {Array<string>} [limitKeys=LIMIT_KEYS] - Ordered list of keys to include as columns (excluding the leading "Tier" column).
 * @returns {string} An AsciiDoc-formatted table containing a header row ("Tier" plus humanized `limitKeys`) and one data row per entry in `rows`.
 */
function toAsciiDoc(rows, limitKeys = LIMIT_KEYS) {
  const headers = ['Tier', ...limitKeys.map(humanLabel)];
  let out = '[options="header"]\n|===\n';
  out += '| ' + headers.join(' | ') + '\n';
  for (const row of rows) {
    out += '| ' + [row.tier, ...limitKeys.map(k => row[k])].join(' | ') + '\n';
  }
  out += '|===\n';
  return out;
}

/**
 * Render rows as CSV with a "Tier" column followed by the provided limit keys.
 *
 * @param {Array<Object>} rows - Array of row objects where each object contains a `tier` property and keys matching `limitKeys`.
 * @param {Array<string>} [limitKeys=LIMIT_KEYS] - Ordered list of keys to include as CSV columns after the "Tier" column.
 * @returns {string} CSV-formatted text with a header row and one line per input row; values are quoted and internal quotes doubled.
 */
function toCSV(rows, limitKeys = LIMIT_KEYS) {
  const headers = ['Tier', ...limitKeys];
  const esc = v => {
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  };
  const lines = [];
  lines.push(headers.join(','));
  for (const row of rows) {
    lines.push([row.tier, ...limitKeys.map(k => row[k])].map(esc).join(','));
  }
  return lines.join('\n');
}

/**
 * Render the provided rows into HTML using a Handlebars template.
 *
 * The template is compiled from the file at `templatePath` and is invoked with a context
 * containing: `rows`, `headers` (array of {name, index_plus_one}), `limitKeys`, `cloudProviders`,
 * and `uniqueTiers`.
 *
 * @param {Array<Object>} rows - Table row objects to render; each row is passed through to the template.
 * @param {string} templatePath - Filesystem path to a Handlebars template.
 * @param {Array<string>} [limitKeys=LIMIT_KEYS] - Ordered list of limit keys used to build headers and passed to the template.
 * @returns {string} The rendered HTML string.
 */
function toHTML(rows, templatePath, limitKeys = LIMIT_KEYS) {
  const fs = require('fs');
  const handlebars = require('handlebars');
  const templateSource = fs.readFileSync(templatePath, 'utf8');
  const compiled = handlebars.compile(templateSource);
  // Pass headers and limitKeys for template rendering
  const headers = limitKeys.map(humanLabel);
  // Precompute index_plus_one for each header for template
  const headersWithIndex = headers.map((h, i) => ({ name: h, index_plus_one: i + 1 }));
  // Extract unique cloud providers and tiers for dropdowns
  // Exclude empty/blank providers and trim
  const cloudProviders = Array.from(new Set(
    rows.map(r => humanProvider(r.cloud_provider && String(r.cloud_provider).trim())).filter(Boolean)
  ));
  const uniqueTiers = Array.from(new Set(rows.map(r => r.tier).filter(Boolean)));
  return compiled({
    rows,
    headers: headersWithIndex,
    limitKeys: limitKeys,
    cloudProviders,
    uniqueTiers
  });
}

/**
 * Generate a cloud tier table from local or remote YAML input and master-data, rendered in the requested format.
 *
 * @param {Object} options - Function options.
 * @param {string} options.input - Path or URL to the input YAML (or the special GitHub install-pack API directory URL) containing tiers/config profiles.
 * @param {string} [options.output] - Output destination (not used by this function; included for CLI compatibility).
 * @param {string} [options.format='html'] - Output format: 'html', 'md' (Markdown), 'adoc' (AsciiDoc), or 'csv'.
 * @param {string} [options.template] - Path to a Handlebars template to use for rendering; for 'html' format a default template is used when this is not provided.
 * @param {string} [options.masterData] - URL or filesystem path to master-data.yaml used to fetch public tier definitions.
 * @param {string[]} [options.limits] - Custom ordered list of limit keys to include; when omitted the default LIMIT_KEYS set is used.
 * @returns {string} Generated table content in the requested format (HTML, Markdown, AsciiDoc, or CSV).
 */
async function generateCloudTierTable({ 
  input,
  output,
  format = 'html',
  template,
  masterData,
  limits
}) {
  const [tiers, publicTiers] = await Promise.all([
    parseYaml(input),
    fetchPublicTiers(masterData)
  ]);
  const limitKeys = limits && Array.isArray(limits) && limits.length > 0 ? limits : LIMIT_KEYS;
  const rows = buildTableRows(tiers, publicTiers, limitKeys);
  const fmt = (format || 'md').toLowerCase();
  if (fmt === 'html') {
    // Use provided template, or default to cloud-tier-table-html.hbs
    const templatePath = template || require('path').resolve(__dirname, 'cloud-tier-table-html.hbs');
    return toHTML(rows, templatePath, limitKeys);
  }
  if (template) {
    const templateSource = fs.readFileSync(template, 'utf8');
    const handlebars = require('handlebars');
    const compiled = handlebars.compile(templateSource);
    return compiled({ rows, limitKeys: limitKeys });
  }
  switch (fmt) {
    case 'md':
      return toMarkdown(rows, limitKeys);
    case 'adoc':
      return toAsciiDoc(rows, limitKeys);
    case 'csv':
      return toCSV(rows, limitKeys);
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}

module.exports = { 
  generateCloudTierTable, 
  extractVersion, 
  findHighestVersionProfile, 
  parseYaml, 
  fetchPublicTiers 
};