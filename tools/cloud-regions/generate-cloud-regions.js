// Standalone module to fetch, parse, filter, and render cloud regions/tier data
// Usage: generateCloudRegions({ sourceUrl, format, token })

/**
 * Expected YAML source data shape:
 *
 * {
 *   regions: [
 *     {
 *       name: string,                // Region name, such as "us-west1"
 *       cloudProvider: string,       // One of CLOUD_PROVIDER_AWS, CLOUD_PROVIDER_GCP, CLOUD_PROVIDER_AZURE
 *       zones: [string] | string,    // List of zones or comma-separated string
 *       redpandaProductAvailability: {
 *         [key: string]: {
 *           redpandaProductName: string, // Product name (must match a public product in products[])
 *           clusterTypes: [string],      // List of cluster type enums
 *         }
 *       }
 *     }, ...
 *   ],
 *   products: [
 *     {
 *       name: string,      // Product name (used for filtering and output)
 *       isPublic: boolean, // Only public products are documented
 *     }, ...
 *   ]
 * }
 *
 * All keys are required unless otherwise noted. Only public products/tiers are included in output.
 */

const path = require('path');
const fs = require('fs');
const jsYaml = require('js-yaml');
const renderCloudRegions = require('./render-cloud-regions');

const providerMap = {
  CLOUD_PROVIDER_AWS: 'AWS',
  CLOUD_PROVIDER_GCP: 'GCP',
  CLOUD_PROVIDER_AZURE: 'Azure',
};
const providerOrder = ['GCP', 'AWS', 'Azure'];
const providerDisplayNames = {
  GCP: 'Google Cloud Platform (GCP)',
  AWS: 'Amazon Web Services (AWS)',
  Azure: 'Azure',
};
const clusterTypeMap = {
  CLUSTER_TYPE_BYOC: 'BYOC',
  CLUSTER_TYPE_DEDICATED: 'Dedicated',
  CLUSTER_TYPE_FMC: 'Dedicated',
};
/**
 * Returns the display name for a given cluster type, or the original value if unmapped.
 * @param {string} ct - The internal cluster type identifier.
 * @return {string} The display name for the cluster type.
 */
function displayClusterType(ct) {
  return clusterTypeMap[ct] || ct;
}

/**
 * Fetches YAML content from GitHub using the GitHub API.
 *
 * Uses the GitHub API to fetch file content, which avoids caching issues that can occur with raw URLs.
 *
 * @param {Object} options - Options for fetching the YAML content.
 * @param {string} options.owner - GitHub repository owner.
 * @param {string} options.repo - GitHub repository name.
 * @param {string} options.path - Path to the file within the repository.
 * @param {string} [options.ref='main'] - Git reference (branch, tag, or commit SHA).
 * @param {string} [options.token] - Optional GitHub token for authorization.
 * @returns {Promise<string>} The fetched YAML content as a string.
 * @throws {Error} If the GitHub API call fails or the file cannot be found.
 */
async function fetchYaml({ owner, repo, path, ref = 'main', token }) {
  try {
    // Use shared Octokit client
    const octokit = require('../../cli-utils/octokit-client');

    console.log(`[cloud-regions] INFO: Fetching ${owner}/${repo}/${path}@${ref} via GitHub API`);

    const response = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    if (Array.isArray(response.data)) {
      throw new Error(`Path ${path} is a directory, not a file`);
    }

    if (response.data.type !== 'file') {
      throw new Error(`Path ${path} is not a file`);
    }

    // Decode base64 content
    const content = Buffer.from(response.data.content, 'base64').toString('utf8');

    if (!content || content.trim() === '') {
      throw new Error('Empty YAML content received from GitHub API');
    }

    return content;
  } catch (err) {
    console.error(`[cloud-regions] ERROR: Failed to fetch from GitHub API: ${err.message}`);
    throw new Error(`GitHub API fetch failed: ${err.message}`);
  }
}

/**
 * Collects every cluster type display name that the source data offers on a
 * public tier, together with the ones this tool maps by default.
 *
 * @param {Array<Object>} regions - The `regions` array from the source YAML.
 * @param {Set<string>} publicProductNames - Names of products marked public.
 * @return {Set<string>} Cluster type display names available for filtering.
 */
function collectClusterTypes(regions, publicProductNames) {
  const available = new Set(Object.values(clusterTypeMap));
  for (const region of regions) {
    const availability = region.redpandaProductAvailability;
    if (!availability || typeof availability !== 'object') continue;
    for (const tier of Object.values(availability)) {
      if (!tier.redpandaProductName || !publicProductNames.has(tier.redpandaProductName)) continue;
      if (!Array.isArray(tier.clusterTypes)) continue;
      for (const ct of tier.clusterTypes) available.add(displayClusterType(ct));
    }
  }
  return available;
}

/**
 * Parses YAML text describing cloud regions and products and returns both the
 * providers and the cluster type the result was filtered to.
 *
 * Templates need the resolved cluster type, not the string the caller typed, so
 * that a filtered table can name it in a heading or an intro. Keeping the
 * resolution here means the YAML is parsed once.
 *
 * @param {string} yamlText - The YAML content to parse and process.
 * @param {Object} [options] - Processing options.
 * @param {string} [options.clusterType] - Optional cluster type display name (case-insensitive).
 * @return {{providers: Array<Object>, clusterType: string|undefined}} The providers and the resolved cluster type filter.
 * @throws {Error} If the YAML is malformed, missing the required `regions` array, or the cluster type is unsupported.
 */
function buildCloudRegions(yamlText, { clusterType } = {}) {
  let data;
  try {
    data = jsYaml.load(yamlText);
  } catch (e) {
    console.error('[cloud-regions] ERROR: Malformed YAML.');
    throw new Error('Malformed YAML: ' + e.message);
  }
  if (!data || !Array.isArray(data.regions)) {
    console.error('[cloud-regions] ERROR: YAML missing top-level regions array.');
    throw new Error('YAML does not contain a top-level regions array.');
  }
  // Ensure grouped keys match providerOrder and providerMap values
  const grouped = { AWS: [], GCP: [], Azure: [] };
  for (const region of data.regions) {
    const key = providerMap[region.cloudProvider];
    if (!key) {
      console.warn(`[cloud-regions] WARN: Unknown cloudProvider '${region.cloudProvider}' in region '${region.name}'. Skipping.`);
      continue;
    }
    grouped[key].push(region);
  }
  // Build a set of public product names
  const publicProductNames = new Set();
  if (Array.isArray(data.products)) {
    for (const product of data.products) {
      if (product.isPublic && product.name) {
        publicProductNames.add(product.name);
      }
    }
  } else {
    console.warn('[cloud-regions] WARN: No products array found in YAML.');
  }
  // Accept any cluster type the source data actually offers, not only the ones
  // clusterTypeMap knows about: an unmapped type such as CLUSTER_TYPE_SERVERLESS
  // already shows up verbatim in the unfiltered table, so refusing to filter on
  // it would be inconsistent with the output.
  let clusterTypeFilter;
  if (clusterType) {
    const validClusterTypes = [...collectClusterTypes(data.regions, publicProductNames)].sort();
    const wanted = String(clusterType).trim().toLowerCase();
    clusterTypeFilter = validClusterTypes.find((ct) => ct.toLowerCase() === wanted);
    if (!clusterTypeFilter) {
      throw new Error(`Unsupported cluster type: ${clusterType}. Use one of: ${validClusterTypes.join(', ')}.`);
    }
  }
  // Prepare providers array for template, only including public products and using name
  const providers = providerOrder
    .filter((prov) => grouped[prov] && grouped[prov].length > 0)
    .map((prov) => {
      // Only include regions that have at least one public product/tier
      const filteredRegions = grouped[prov].map((region) => {
        // Join with ', ' so long zone lists can wrap inside table cells
        const zones = Array.isArray(region.zones) ? region.zones.join(', ') : (region.zones || '');
        let tiers = [];
        if (region.redpandaProductAvailability && typeof region.redpandaProductAvailability === 'object') {
          // Group by tier name, collect all cluster types for that tier
          const tierMap = {};
          for (const t of Object.values(region.redpandaProductAvailability)) {
            if (!t.redpandaProductName || !publicProductNames.has(t.redpandaProductName)) {
              continue;
            }
            let displayTypes = Array.isArray(t.clusterTypes) ? t.clusterTypes.map(displayClusterType) : [];
            if (clusterTypeFilter) {
              displayTypes = displayTypes.filter((ct) => ct === clusterTypeFilter);
              if (displayTypes.length === 0) continue;
            }
            const productName = t.redpandaProductName;
            if (!tierMap[productName]) tierMap[productName] = new Set();
            for (const ct of displayTypes) tierMap[productName].add(ct);
          }
          tiers = Object.entries(tierMap)
            // With a filter every tier carries exactly the filtered type, so
            // repeating it on all 50-odd rows is noise: the template says it
            // once from clusterType instead.
            .map(([productName, cts]) => (clusterTypeFilter
              ? productName
              : `${productName}: ${Array.from(cts).sort().join(', ')}`))
            .sort((a, b) => a.localeCompare(b));
        }
        return {
          name: region.name,
          zones,
          tiers,
        };
      }).filter(region => region.tiers && region.tiers.length > 0);
      if (filteredRegions.length === 0) {
        console.info(`[cloud-regions] INFO: No public tiers found for provider '${prov}'.`);
      }
      return {
        name: prov,
        displayName: providerDisplayNames[prov] || prov,
        regions: filteredRegions,
      };
    })
    .filter(provider => provider.regions && provider.regions.length > 0);
  if (providers.length === 0) {
    console.warn('[cloud-regions] WARN: No providers/regions found after filtering.');
  }
  return { providers, clusterType: clusterTypeFilter };
}

/**
 * Parses YAML text describing cloud regions and products, filters for public products, and organizes regions by provider.
 *
 * The function expects YAML content with a top-level `regions` array and an optional `products` array. It groups regions by cloud provider, includes only those with at least one public product tier, and formats tier and cluster type information for each region. Providers and regions without public tiers are excluded from the result.
 *
 * @param {string} yamlText - The YAML content to parse and process.
 * @param {Object} [options] - Processing options.
 * @param {string} [options.clusterType] - Optional cluster type display name ('BYOC' or 'Dedicated', case-insensitive). When set, only tiers available for that cluster type are included, and regions with no matching tiers are dropped.
 * @return {Array<Object>} An array of provider objects, each containing a name and a list of regions with their available public product tiers.
 * @throws {Error} If the YAML is malformed or missing the required `regions` array.
 */
function processCloudRegions(yamlText, options = {}) {
  return buildCloudRegions(yamlText, options).providers;
}

/**
 * Fetches, processes, and renders cloud region and tier data from a GitHub YAML file.
 *
 * Retrieves YAML data from GitHub using the GitHub API (to avoid caching issues),
 * parses and filters it to include only public cloud regions and tiers, and renders the result in the requested format.
 *
 * @param {Object} options - Options for generating cloud regions.
 * @param {string} options.owner - GitHub repository owner.
 * @param {string} options.repo - GitHub repository name.
 * @param {string} options.path - Path to the YAML file within the repository.
 * @param {string} [options.ref='main'] - Git reference (branch, tag, or commit SHA).
 * @param {string} [options.format='md'] - The output format (for example, 'md' for Markdown).
 * @param {string} [options.token] - Optional GitHub token for authentication.
 * @param {string} [options.template] - Optional path to custom Handlebars template.
 * @param {string} [options.clusterType] - Optional cluster type filter ('BYOC' or 'Dedicated', case-insensitive).
 * @returns {string} The rendered cloud regions output.
 * @throws {Error} If fetching, processing, or rendering fails, or if no valid providers or regions are found.
 */
async function generateCloudRegions({ owner, repo, path, ref = 'main', format = 'md', token, template, clusterType }) {
  let yamlText;
  try {
    yamlText = await fetchYaml({ owner, repo, path, ref, token });
  } catch (err) {
    console.error(`[cloud-regions] ERROR: Failed to fetch YAML: ${err.message}`);
    throw err;
  }
  let providers;
  let resolvedClusterType;
  try {
    ({ providers, clusterType: resolvedClusterType } = buildCloudRegions(yamlText, { clusterType }));
  } catch (err) {
    console.error(`[cloud-regions] ERROR: Failed to process cloud regions: ${err.message}`);
    throw err;
  }
  if (providers.length === 0) {
    console.error('[cloud-regions] ERROR: No providers/regions found in YAML after filtering.');
    throw new Error('No providers/regions found in YAML after filtering.');
  }
  const lastUpdated = new Date().toISOString();
  try {
    return renderCloudRegions({ providers, format, lastUpdated, template, clusterType: resolvedClusterType });
  } catch (err) {
    console.error(`[cloud-regions] ERROR: Failed to render cloud regions: ${err.message}`);
    throw err;
  }
}

module.exports = {
  generateCloudRegions,
  processCloudRegions,
};
