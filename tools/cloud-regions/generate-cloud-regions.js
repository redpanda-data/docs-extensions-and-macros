
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
const clusterTypeMap = {
  CLUSTER_TYPE_BYOC: 'BYOC',
  CLUSTER_TYPE_DEDICATED: 'Dedicated',
  CLUSTER_TYPE_FMC: 'Dedicated',
};
function displayClusterType(ct) {
  return clusterTypeMap[ct] || ct;
}

async function fetchYaml(url, token) {
  let fetchImpl = global.fetch;
  if (!fetchImpl) {
    try {
      fetchImpl = (await import('node-fetch')).default;
    } catch (e) {
      console.error('[cloud-regions] ERROR: Could not load fetch implementation.');
      throw new Error('No fetch implementation found. Use Node.js v18+ or install node-fetch.');
    }
  }
  const fetchOpts = {};
  if (token) fetchOpts.headers = { Authorization: `Bearer ${token}` };
  let res;
  try {
    res = await fetchImpl(url, fetchOpts);
  } catch (err) {
    console.error(`[cloud-regions] ERROR: Network error while fetching YAML from ${url}`);
    throw new Error(`Network error while fetching YAML: ${err.message}`);
  }
  if (!res.ok) {
    console.error(`[cloud-regions] ERROR: Failed to fetch YAML from ${url} - Status: ${res.status} ${res.statusText}`);
    throw new Error(`Failed to fetch YAML: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

function processCloudRegions(yamlText) {
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
  // Prepare providers array for template, only including public products and using name
  const providers = providerOrder
    .filter((prov) => grouped[prov] && grouped[prov].length > 0)
    .map((prov) => {
      // Only include regions that have at least one public product/tier
      const filteredRegions = grouped[prov].map((region) => {
        const zones = Array.isArray(region.zones) ? region.zones.join(',') : (region.zones || '');
        let tiers = [];
        if (region.redpandaProductAvailability && typeof region.redpandaProductAvailability === 'object') {
          // Group by tier name, collect all cluster types for that tier
          const tierMap = {};
          for (const t of Object.values(region.redpandaProductAvailability)) {
            if (!t.redpandaProductName || !publicProductNames.has(t.redpandaProductName)) {
              console.debug(`[cloud-regions] DEBUG: Skipping non-public product/tier '${t.redpandaProductName}' in region '${region.name}'.`);
              continue;
            }
            const productName = t.redpandaProductName;
            if (!tierMap[productName]) tierMap[productName] = new Set();
            if (Array.isArray(t.clusterTypes)) {
              for (const ct of t.clusterTypes) tierMap[productName].add(displayClusterType(ct));
            }
          }
          tiers = Object.entries(tierMap)
            .map(([productName, cts]) => `${productName}: ${Array.from(cts).sort().join(', ')}`)
            .sort((a, b) => a.localeCompare(b));
        } else {
          console.debug(`[cloud-regions] DEBUG: No redpandaProductAvailability for region '${region.name}'.`);
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
        regions: filteredRegions,
      };
    })
    .filter(provider => provider.regions && provider.regions.length > 0);
  if (providers.length === 0) {
    console.warn('[cloud-regions] WARN: No providers/regions found after filtering.');
  }
  return providers;
}

async function generateCloudRegions({ sourceUrl, format = 'md', token }) {
  let yamlText;
  try {
    yamlText = await fetchYaml(sourceUrl, token);
  } catch (err) {
    console.error(`[cloud-regions] ERROR: Failed to fetch YAML: ${err.message}`);
    throw err;
  }
  let providers;
  try {
    providers = processCloudRegions(yamlText);
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
    return renderCloudRegions({ providers, format, lastUpdated });
  } catch (err) {
    console.error(`[cloud-regions] ERROR: Failed to render cloud regions: ${err.message}`);
    throw err;
  }
}

module.exports = {
  generateCloudRegions,
  processCloudRegions,
};
