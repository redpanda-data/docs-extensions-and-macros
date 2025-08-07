'use strict';
/**
 * Registers macros for use in Redpanda Connect contexts in the Redpanda documentation.
  * @param {Registry} registry - The Antora registry where this block macro is registered.
  * @param {Object} context - The Antora context that provides access to configuration data, such as parsed CSV content.
*/
module.exports.register = function (registry, context) {
  function filterComponentTable() {
    const nameInputElement = document.getElementById('componentTableSearch');
    const nameInput = nameInputElement ? nameInputElement.value.trim().toLowerCase() : '';
    const typeFilter = Array.from(document.querySelectorAll('#typeFilterMenu input[type="checkbox"]:checked')).map(checkbox => checkbox.value);
    // Check for the existence of support and enterprise license filters (optional)
    const supportFilterElement = document.querySelector('#supportFilterMenu');
    const supportFilter = supportFilterElement
      ? Array.from(supportFilterElement.querySelectorAll('input[type="checkbox"]:checked')).map(checkbox => checkbox.value)
      : [];
    // Check for cloud support filter (optional)
    const cloudSupportFilterElement = document.querySelector('#cloudSupportFilterMenu');
    const cloudSupportFilter = cloudSupportFilterElement
      ? Array.from(cloudSupportFilterElement.querySelectorAll('input[type="checkbox"]:checked')).map(checkbox => checkbox.value)
      : [];
    // Check for enterprise license filter (optional)
    const enterpriseFilterElement = document.querySelector('#enterpriseFilterMenu');
    const enterpriseFilter = enterpriseFilterElement
      ? Array.from(enterpriseFilterElement.querySelectorAll('input[type="checkbox"]:checked')).map(checkbox => checkbox.value)
      : [];
    const params = getQueryParams();
    const enterpriseSupportFilter = params.support === 'enterprise';  // Check if 'support=enterprise' is in the URL
    const cloudSupportFilterFromUrl = params.support === 'cloud';  // Check if 'support=cloud' is in the URL
    const table = document.getElementById('componentTable');
    if (!table) return; // Exit early if table doesn't exist
    const trs = table.getElementsByTagName('tr');
    if (!trs || trs.length === 0) return; // Exit early if no rows found
    for (let i = 1; i < trs.length; i++) {
      const row = trs[i];
      const nameTd = row.querySelector('td[id^="componentName-"]');
      const typeTd = row.querySelector('td[id^="componentType-"]');
      const supportTd = row.querySelector('td[id^="componentSupport-"]'); // Support column, if present
      const enterpriseSupportTd = row.querySelector('td[id^="componentLicense-"]'); // Enterprise License column, if present
      const cloudSupportTd = row.querySelector('td[id^="componentCloud-"]'); // Cloud support column, if present
      if (typeTd) {  // Ensure that at least the Type column is present
        const nameText = nameTd ? nameTd.textContent.trim().toLowerCase() : '';
        const typeText = typeTd.textContent.trim().toLowerCase().split(', ').map(item => item.trim());
        const supportText = supportTd ? supportTd.textContent.trim().toLowerCase() : '';
        const enterpriseSupportText = enterpriseSupportTd ? enterpriseSupportTd.textContent.trim().toLowerCase() : '';  // Yes or No
        const cloudSupportText = cloudSupportTd ? cloudSupportTd.textContent.trim().toLowerCase() : '';  // Yes or No
        // Check cloud support filter
        let cloudSupportMatch = true;
        if (cloudSupportFilter.length > 0 && !cloudSupportFilter.includes('')) {
          // If specific options are selected (not "All")
          cloudSupportMatch = cloudSupportFilter.some(value => {
            if (value === 'yes') return cloudSupportText === 'yes' || cloudSupportText.includes('yes');
            if (value === 'no') return cloudSupportText === 'no' || !cloudSupportText.includes('yes');
            return true;
          });
        }
        // Check enterprise license filter
        let enterpriseLicenseMatch = true;
        if (enterpriseFilter.length > 0 && !enterpriseFilter.includes('')) {
          // If specific options are selected (not "All")
          enterpriseLicenseMatch = enterpriseFilter.some(value => {
            if (value === 'yes') return enterpriseSupportText === 'yes' || enterpriseSupportText.includes('yes');
            if (value === 'no') return enterpriseSupportText === 'no' || !enterpriseSupportText.includes('yes');
            return true;
          });
        }
        // Determine if the row should be shown
        const showRow =
          ((!nameInput || nameText.includes(nameInput)) &&  // Filter by name if present
           (typeFilter.length === 0 || typeFilter.some(value => typeText.includes(value))) &&  // Filter by type
           (!supportTd || supportFilter.length === 0 || supportFilter.some(value => supportText.includes(value))) &&  // Filter by support if present
           (!enterpriseSupportFilter || !enterpriseSupportTd || supportText.includes('enterprise') || enterpriseSupportText === 'yes') && // Filter by enterprise support if 'support=enterprise' is in the URL
           (!cloudSupportFilterFromUrl || !cloudSupportTd || supportText.includes('cloud') || cloudSupportText === 'yes') &&  // Filter by cloud support if 'support=cloud' is in the URL
           cloudSupportMatch &&  // Filter by cloud support dropdown
           enterpriseLicenseMatch  // Filter by enterprise license dropdown
          );
        row.style.display = showRow ? '' : 'none';
      } else {
        row.style.display = 'none'; // Hide row if the Type column is missing
      }
    }
    // Update dropdown text based on selections
    updateDropdownText('typeFilter', 'All Types Selected', 'Types Selected');
    const supportMenu = document.getElementById('supportFilterMenu');
    if (supportMenu) {
      updateDropdownText('supportFilter', 'All Support Levels Selected', 'Support Levels Selected');
    }
    const cloudSupportMenu = document.getElementById('cloudSupportFilterMenu');
    if (cloudSupportMenu) {
      updateDropdownText('cloudSupportFilter', 'All Options Selected', 'Options Selected');
    }
    const enterpriseMenu = document.getElementById('enterpriseFilterMenu');
    if (enterpriseMenu) {
      updateDropdownText('enterpriseFilter', 'All Options Selected', 'Options Selected');
    }
    // Update URL parameters based on current filter selections
    updateURLParameters();
  }
  function updateURLParameters() {
    const params = new URLSearchParams();
    // Get current filter values
    const nameInputElement = document.getElementById('componentTableSearch');
    const nameInput = nameInputElement ? nameInputElement.value.trim() : '';
    const typeFilter = Array.from(document.querySelectorAll('#typeFilterMenu input[type="checkbox"]:checked')).map(checkbox => checkbox.value);
    const supportFilterElement = document.querySelector('#supportFilterMenu');
    const supportFilter = supportFilterElement
      ? Array.from(supportFilterElement.querySelectorAll('input[type="checkbox"]:checked')).map(checkbox => checkbox.value)
      : [];
    const cloudSupportFilterElement = document.querySelector('#cloudSupportFilterMenu');
    const cloudSupportFilter = cloudSupportFilterElement
      ? Array.from(cloudSupportFilterElement.querySelectorAll('input[type="checkbox"]:checked')).map(checkbox => checkbox.value)
      : [];
    const enterpriseFilterElement = document.querySelector('#enterpriseFilterMenu');
    const enterpriseFilter = enterpriseFilterElement
      ? Array.from(enterpriseFilterElement.querySelectorAll('input[type="checkbox"]:checked')).map(checkbox => checkbox.value)
      : [];
    // Add parameters to URL if they have values
    if (nameInput) params.set('search', nameInput);
    if (typeFilter.length > 0) params.set('type', typeFilter.join(','));
    if (supportFilter.length > 0) params.set('support', supportFilter.join(','));
    if (cloudSupportFilter.length > 0 && !cloudSupportFilter.includes('')) {
      params.set('cloud', cloudSupportFilter.join(','));
    }
    if (enterpriseFilter.length > 0 && !enterpriseFilter.includes('')) {
      params.set('enterprise', enterpriseFilter.join(','));
    }
    // Update the URL without refreshing the page
    const newURL = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
    window.history.replaceState({}, '', newURL);
  }
  /**
   * Gets the first URL (either Redpanda Connect or Redpanda Cloud) for a given connector from the typesArray.
   * If the cloud option is enabled (`isCloud = true`), it prefers the Redpanda Cloud URL; otherwise, it returns the Redpanda Connect URL.
   * 
   * @param {Array} typesArray - An array of types where each type has a list of commercial names with URLs.
   * @param {boolean} isCloud - A flag to indicate if Cloud URLs should be prioritized.
   * @returns {string} - The first found URL (either Redpanda Connect or Cloud), or an empty string if no URL is available.
   */
  function getFirstUrlFromTypesArray(typesArray, isCloud) {
    for (const [type, commercialNames] of typesArray) {
      for (const commercialName in commercialNames) {
        const { urls = {} } = commercialNames[commercialName];
        const redpandaConnectUrl = urls.redpandaConnectUrl || '';
        const redpandaCloudUrl = urls.redpandaCloudUrl || '';

        // Return Cloud URL if isCloud is true and Cloud URL exists
        if (isCloud && redpandaCloudUrl) {
          return redpandaCloudUrl;
        }
        // Return Connect URL if isCloud is false or no Cloud URL exists
        if (!isCloud && redpandaConnectUrl) {
          return redpandaConnectUrl;
        }
        // If Cloud URL exists but isCloud is false, fallback to Cloud URL if no Connect URL exists
        if (!isCloud && redpandaCloudUrl) {
          return redpandaCloudUrl;
        }
      }
    }
    return ''; // Return an empty string if no URL is found
  }
  const capitalize = s => s && s[0].toUpperCase() + s.slice(1);

  /**
   * Processes the parsed CSV data and returns a data structure organized by connector.
   *
   * This function processes each row in the CSV data to create a nested object where the key is the connector name.
   * Each connector contains:
   * - `types`: A Map of connector types, with associated URLs for Redpanda Connect and Redpanda Cloud.
   *    - Each type maps to commercial names and stores information on URLs, support level, and cloud support.
   * - `supportLevels`: A Map of support levels containing commercial names and whether the type supports cloud.
   * - `isLicensed`: A boolean flag indicating whether the connector requires an enterprise license.
   * - `isCloudConnectorSupported`: A boolean flag indicating whether any type of this connector supports Redpanda Cloud.
   *
   * Expected structure of the returned data:
   *
   * {
   *   "connectorName": {
   *     "types": Map {
   *       "Input": {   // Connector Type
   *         "commercial_name": {
   *           urls: {
   *             redpandaConnectUrl: "/redpanda-connect/components/inputs/connectorName/",
   *             redpandaCloudUrl: "/redpanda-cloud/develop/connect/components/inputs/connectorName/"
   *           },
   *           supportLevel: "certified",  // Support level for this commercial name
   *           isCloudSupported: true      // Whether this type supports cloud
   *         },
   *         ...
   *       },
   *       "Output": {  // Another Connector Type
   *         "commercial_name": {
   *           urls: {
   *             redpandaConnectUrl: "/redpanda-connect/components/outputs/connectorName/",
   *             redpandaCloudUrl: "/redpanda-cloud/develop/connect/components/outputs/connectorName/"
   *           },
   *           supportLevel: "community",  // Support level for this commercial name
   *           isCloudSupported: false     // Whether this type supports cloud
   *         },
   *         ...
   *       },
   *       ...
   *     },
   *     "isLicensed": "Yes" or "No",  // Indicates if the connector requires an Enterprise license.
   *     "isCloudConnectorSupported": true or false // Indicates if any type for this connector supports Redpanda Cloud.
   *   },
   *   ...
   * }
   *
   * Notes:
   * - For each connector, `types` is a `Map` that contains multiple connector types.
   * - For each type, there may be multiple commercial names. Each commercial name contains URLs, support levels, and cloud support flags.
   * - The `isCloudConnectorSupported` flag is set to `true` if any of the types for the connector support cloud.
   *
   * @param {object} parsedData - The CSV data parsed into an object.
   * @returns {object} - The processed connectors data structure.
   */
  function processConnectors(parsedData) {
    return parsedData.data.reduce((connectors, row) => {
      const { connector, commercial_name, type, support_level, is_cloud_supported, is_licensed, redpandaConnectUrl, redpandaCloudUrl } = row;
      const isCloudSupported = is_cloud_supported === 'y';

      // Initialize the connector if it's not already in the map
      if (!connectors[connector]) {
        connectors[connector] = {
          types: new Map(),
          isLicensed: is_licensed,
          isCloudConnectorSupported: false
        };
      }

      // Ensure type exists for the connector
      if (!connectors[connector].types.has(type)) {
        connectors[connector].types.set(type, {});
      }

      // Store the commercial name under the type
      if (!connectors[connector].types.get(type)[commercial_name]) {
        connectors[connector].types.get(type)[commercial_name] = {
          urls: {
            redpandaConnectUrl: redpandaConnectUrl || '',
            redpandaCloudUrl: redpandaCloudUrl || ''
          },
          supportLevel: support_level,
          isCloudSupported: isCloudSupported
        };
      }

      // Check at the connector level if any commercial name supports cloud
      if (isCloudSupported) {
        connectors[connector].isCloudConnectorSupported = true;
      }

      return connectors;
    }, {});
  }

  /**
   * Processes parsed CSV data and groups SQL drivers by their support level.
   *
   * This function extracts the SQL drivers from the parsed CSV data, grouping
   * them into two categories: "certified" and "community". Each driver is also
   * associated with a flag indicating whether it supports cloud.
   *
   * @param {Object} parsedData - The parsed CSV data containing driver information.
   *   The expected structure of each row should contain at least the following:
   *   {
   *     connector: string,        // The name of the connector
   *     commercial_name: string,  // The commercial name of the SQL driver
   *     support_level: string,    // The support level ('certified', 'community')
   *     is_cloud_supported: string // 'y' or 'n', indicating if the driver supports cloud
   *   }
   *
   * @returns {Object} - An object with two properties:
   *   - `certified`: An array of SQL drivers with 'certified' support level. Each driver contains:
   *     - `commercialName`: The trimmed commercial name of the driver (e.g., 'PostgreSQL').
   *     - `isCloudSupported`: A boolean indicating whether the driver supports cloud.
   *   - `community`: An array of SQL drivers with 'community' support level. Each driver contains:
   *     - `commercialName`: The trimmed commercial name of the driver (e.g., 'Trino').
   *     - `isCloudSupported`: A boolean indicating whether the driver supports cloud.
   *
   * Example return structure:
   * {
   *   certified: [
   *     { commercialName: 'PostgreSQL', isCloudSupported: true },
   *     { commercialName: 'MySQL', isCloudSupported: true },
   *   ],
   *   community: [
   *     { commercialName: 'Trino', isCloudSupported: false },
   *     { commercialName: 'ClickHouse', isCloudSupported: false },
   *   ]
   * }
   */
  function processSqlDrivers(parsedData) {
    const sqlDrivers = {
      certified: [],
      community: []
    };

    parsedData.data.forEach(row => {
      const { connector: driverName, commercial_name, support_level, is_cloud_supported } = row;
      const isCloudSupported = is_cloud_supported === 'y';
      const supportLevel = support_level.toLowerCase();

      // Only process SQL drivers
      if (driverName.startsWith('sql_driver')) {
        const driverData = {
          commercialName: commercial_name.trim(),
          isCloudSupported: isCloudSupported
        };

        // Group drivers based on their support level
        if (supportLevel === 'certified') {
          sqlDrivers.certified.push(driverData);
        } else if (supportLevel === 'community') {
          sqlDrivers.community.push(driverData);
        }
      }
    });

    return sqlDrivers;
  }

  /**
   * Generates an HTML table for the list of connectors, including their types, support levels, and cloud support.
   *
   * This function iterates over the provided connectors and generates an HTML table row for each connector.
   * It includes type-specific information, support level (including SQL driver details), licensing, and cloud support.
   * 
   * @param {Object} connectors - An object containing the connector data, where each key is a connector name and
   *   each value contains details about its types, licensing, and cloud support.
   *   {
   *     types: Map - A map of connector types (e.g., Input, Output, Processor), with associated commercial names.
   *     isLicensed: 'Yes' or 'No' - Indicates if the connector requires an enterprise license.
   *     isCloudConnectorSupported: true or false - Indicates if any type for this connector supports Redpanda Cloud.
   *   }
   * @param {Object} sqlDrivers - An object containing the SQL driver support data, separated by support level:
   *   {
   *     certified: Array<{ commercialName: string, isCloudSupported: boolean }>,
   *     community: Array<{ commercialName: string, isCloudSupported: boolean }>
   *   }
   * @param {boolean} isCloud - A flag indicating whether to filter by cloud support. If true, only cloud-supported connectors are shown.
   * @param {boolean} showAllInfo - A flag indicating whether to show all information or limit the data displayed (e.g., for cloud-only views).
   *
   * @returns {string} - A string containing the generated HTML for the connectors table rows.
   *   The output is a string of HTML rows with the following columns:
   *   - Connector name
   *   - Connector types (linked to Redpanda Connect or Cloud documentation URLs)
   *   - Support levels (including SQL drivers if applicable)
   *   - Enterprise licensing information
   *   - Cloud support status (Yes/No with a link if applicable)
   */
  function generateConnectorsHTMLTable(connectors, sqlDrivers, isCloud, showAllInfo) {
    return Object.entries(connectors)
      .filter(([_, details]) => {
        // If isCloud is true, filter out rows that do not support cloud
        return !isCloud || details.isCloudConnectorSupported;
      })
      .map(([connector, details], id) => {
        const { types, isCloudConnectorSupported, isLicensed } = details;

        // Generate the type and commercial name links for each connector
        const typesArray = Array.from(types.entries())
          .map(([type, commercialNames]) => {
            const uniqueCommercialNames = Object.keys(commercialNames);
            const urlsArray = [];
            uniqueCommercialNames.forEach(commercialName => {
              const { urls = {}, isCloudSupported } = commercialNames[commercialName];
              const redpandaConnectUrl = urls.redpandaConnectUrl || '';
              const redpandaCloudUrl = urls.redpandaCloudUrl || '';
              if (isCloud && !showAllInfo) {
                // Only show Cloud URLs in the Cloud table
                if (redpandaCloudUrl) {
                  urlsArray.push(`<a href="${redpandaCloudUrl}">${capitalize(type)}</a>`);
                }
              } else {
                // Show Connect URLs in non-cloud tables
                if (redpandaConnectUrl) {
                  urlsArray.push(`<a href="${redpandaConnectUrl}">${capitalize(type)}</a>`);
                } else if (redpandaCloudUrl) {
                  // Fallback to Cloud URL if available
                  urlsArray.push(`<a href="${redpandaCloudUrl}">${capitalize(type)}</a>`);
                }
              }
            });
            // Filter out duplicates in URLs array for unique types
            const uniqueUrls = [...new Set(urlsArray)];
            return uniqueUrls.join(', '); // Return the types as a string of links
          })
          .filter(item => item !== '') // Remove any empty entries
          .join(', '); // Join them into a single string

        let supportLevelStr = ''; // Initialize the variable
        // Generate the support level string
        const supportLevels = Array.from(types.entries())
          .reduce((supportLevelMap, [type, commercialNames]) => {
            Object.entries(commercialNames).forEach(([commercialName, { supportLevel }]) => {
              if (!supportLevelMap[supportLevel]) {
                supportLevelMap[supportLevel] = {
                  types: new Set(),
                  commercialNames: new Map() // To track commercial names for each type
                };
              }
              supportLevelMap[supportLevel].types.add(type); // Add the type to the Set (automatically removes duplicates)

              // Add the commercial name to the type (only if it's not the connector name)
              if (!supportLevelMap[supportLevel].commercialNames.has(type)) {
                supportLevelMap[supportLevel].commercialNames.set(type, new Set());
              }
              if (commercialName.toLowerCase() !== connector.toLowerCase()) {
                supportLevelMap[supportLevel].commercialNames.get(type).add(commercialName);
              }
            });
            return supportLevelMap;
          }, {});

        // Generate the support level string
        supportLevelStr = Object.entries(supportLevels)
          .map(([supportLevel, { types, commercialNames }]) => {
            const allCommercialNames = new Set(); // Store all commercial names for this support level

            // Collect all commercial names across types
            Array.from(commercialNames.entries()).forEach(([type, namesSet]) => {
              namesSet.forEach(name => {
                allCommercialNames.add(name);
              });
            });

            // Case: Multiple support levels but no commercial names listed
            if (Object.keys(supportLevels).length > 1 && allCommercialNames.size === 0 && types.size !== 0) {
              const typesList = Array.from(types).join(', ');  // Get all types
              return `<p><b>${capitalize(supportLevel)}</b>: ${typesList}</p>`;
            }

            // If there's more than one commercial name, display them
            if (allCommercialNames.size > 1) {
              const allNamesArray = Array.from(allCommercialNames).join(', ');
              return `<p><b>${capitalize(supportLevel)}</b>: ${allNamesArray}</p>`;
            }

            // Otherwise, just show the support level
            return `<p>${capitalize(supportLevel)}</p>`;
          })
          .join('');

        // Add SQL driver support levels if the connector is a SQL connector.
        // We assume only connectors starting with sql_ are relevant.
        if (connector.startsWith('sql_')) {
          const certifiedDrivers = sqlDrivers.certified.length ? `<strong>Certified:</strong> ${sqlDrivers.certified.map(driver => driver.commercialName).join(', ')}` : '';
          const communityDrivers = sqlDrivers.community.length ? `<strong>Community:</strong> ${sqlDrivers.community.map(driver => driver.commercialName).join(', ')}` : '';

          // Add the SQL driver support to the support level string
          if (certifiedDrivers || communityDrivers) {
            // Reset the support levels
            supportLevelStr = ''
            supportLevelStr += `<p>${certifiedDrivers}${certifiedDrivers && communityDrivers ? '</br> ' : ''}${communityDrivers}</p>`;
          }
        }
        // Build the cloud support column and include the connector URL where a connector page is available. Otherwise, just mark as available.
        const firstCloudSupportedType = Array.from(types.entries())
          .map(([_, commercialNames]) => Object.values(commercialNames).find(({ isCloudSupported }) => isCloudSupported))
          .find(entry => entry);
        const cloudLinkDisplay = firstCloudSupportedType
          ? firstCloudSupportedType.urls.redpandaCloudUrl
            ? `<a href="${firstCloudSupportedType.urls.redpandaCloudUrl}">Yes</a>`
          : `Yes`
        : 'No';

        const firstUrl = getFirstUrlFromTypesArray(Array.from(types.entries()), isCloud);

        // Logic for showAllInfo = true and isCloud = false
        if (showAllInfo && !isCloud) {
          return `
            <tr id="row-${id}">
              <td class="tableblock halign-left valign-top" id="componentName-${id}">
                <p class="tableblock"><a href="${firstUrl}"><code>${connector}</code></a></p>
              </td>
              <td class="tableblock halign-left valign-top" id="componentType-${id}">
                <p class="tableblock">${typesArray}</p> <!-- Display types linked to Connect URL only -->
              </td>
              <td class="tableblock halign-left valign-top" id="componentSupport-${id}">
                <p class="tableblock">${supportLevelStr.trim()}</p> <!-- Display support levels by type -->
              </td>
              <td class="tableblock halign-left valign-top" id="componentLicense-${id}">
                <p class="tableblock">${isLicensed}</p>
              </td>
              <td class="tableblock halign-left valign-top" id="componentCloud-${id}">
                <p class="tableblock">${cloudLinkDisplay}</p> <!-- Display 'Yes' or 'No' with link to first cloud-supported type -->
              </td>
            </tr>`;
        }
        // Logic for isCloud = true and showAllInfo = false (Cloud Table)
        if (isCloud && !showAllInfo) {
          return `
            <tr id="row-${id}">
              <td class="tableblock halign-left valign-top" id="componentName-${id}">
                <p class="tableblock"><a href="${firstUrl}"><code>${connector}</code></a></p>
              </td>
              <td class="tableblock halign-left valign-top" id="componentType-${id}">
                ${typesArray} <!-- Display bulleted list for cloud types if commercial name differs -->
              </td>
            </tr>`;
        }
        // Default table display
        return `
          <tr id="row-${id}">
            <td class="tableblock halign-left valign-top" id="componentName-${id}">
              <p class="tableblock"><a href="${firstUrl}"><code>${connector}</code></a></p>
            </td>
            <td class="tableblock halign-left valign-top" id="componentType-${id}">
              <p class="tableblock">${typesArray}</p> <!-- Display types without commercial names -->
            </td>
            <td class="tableblock halign-left valign-top" id="componentSupport-${id}">
              <p class="tableblock">${supportLevelStr.trim()}</p>
            </td>
            <td class="tableblock halign-left valign-top" id="componentLicense-${id}">
              <p class="tableblock">${isLicensed}</p>
            </td>
          </tr>`;
      })
      .filter(row => row !== '')
      .join(''); // Filter out empty rows
  }

  /**
   * Registers a block macro to generate a searchable and sortable table displaying connector data.
   *
   * This macro creates a dynamic HTML table that lists all available connectors, allowing filtering and sorting
   * by type, support level, and cloud support.
   *
   *
   * The table includes:
   * - Name: The name of the connector.
   * - Connector Type: The type of the connector.
   * - Support Level: The support level for each connector, including associated SQL drivers if applicable.
   * - Enterprise Licensed: Indicates whether the connector requires an Enterprise license.
   * - Cloud Support: Shows if the connector is supported in Redpanda Cloud.
   *
   * Filters:
   * - Type: Allows the user to filter by connector type.
   * - Support: Allows the user to filter by support level (if not in cloud view).
   * - Search: A text input field to search for connectors by name.
   *
   * Attributes:
   * - `all`: If specified, displays additional columns such as support level, enterprise licensing, and cloud support.
   *
   * Data Sources:
   * - `csvData`: Parsed CSV data that provides details about each connector.
   * - SQL driver data is processed separately using the `processSqlDrivers` function, which groups the drivers by support level.
   *
   * Example usage in AsciiDoc:
   * ```
   * component_table::[]
   * ```
   *
   * Example output:
   * ```
   * | Name  | Connector Type | Support Level    | Enterprise Licensed | Cloud Support |
   * |-------|----------------|----------------  |---------------------|-----|
   * | SQL   | Input, Output  | Certified        | No                  | No  |
   * ```
   *
   * @param {Object} parent - The parent document where the table will be inserted.
   * @param {string} target - Target element.
   * @param {Object} attributes - Positional attributes passed to the macro.
   *   - `all`: If provided, extra columns are shown.
   */
  registry.blockMacro(function () {
    const self = this;
    self.named('component_table');
    self.positionalAttributes(['all']); // Allows for displaying all data
    self.process((parent, target, attributes) => {
      const isCloud = parent.getDocument().getAttributes()['env-cloud'] !== undefined;
      const showAllInfo = attributes?.all

      const csvData = context.config?.attributes?.csvData || null;
      if (!csvData) return console.error(`CSV data is not available for ${parent.getDocument().getAttributes()['page-relative-src-path']}. Make sure your playbook includes the generate-rp-connect-info extension.`)

      const sqlDriversData = processSqlDrivers(csvData);

      const types = new Set();
      const uniqueSupportLevel = new Set();
      csvData.data.forEach(row => {
        if (row.type && row.type.toLowerCase() !== 'sql_driver') types.add(row.type);
        if (row.support_level) uniqueSupportLevel.add(row.support_level);
      });

      const createDropdownCheckboxOptions = (values, id) =>
        Array.from(values)
          .map(value => `
            <label class="dropdown-checkbox-option">
              <input type="checkbox" value="${value}" checked onchange="filterComponentTable()">
              <span>${capitalize(value).replace("_", " ")}</span>
            </label>`)
          .join('');

      let tableHtml = `
        <div class="table-filters">
          <input class="table-search" type="text" id="componentTableSearch" onkeyup="filterComponentTable()" placeholder="Search for components...">
          <div class="filter-group">
            <label for="typeFilterToggle">Type:</label>
            <div class="dropdown-checkbox-wrapper">
              <button type="button" class="dropdown-checkbox-toggle" id="typeFilterToggle" onclick="toggleDropdownCheckbox('typeFilter')" aria-expanded="false" aria-haspopup="true" aria-controls="typeFilterMenu">
                <span class="dropdown-text">All Types Selected</span>
                <span class="dropdown-arrow">▼</span>
              </button>
              <div class="dropdown-checkbox-menu" id="typeFilterMenu" role="menu" aria-labelledby="typeFilterToggle">
                ${createDropdownCheckboxOptions(types, 'typeFilter')}
              </div>
            </div>
          </div>
      `;

      if (!isCloud) {
        tableHtml += `
          <div class="filter-group">
            <label for="supportFilterToggle" id="labelForSupportFilter">Support:</label>
            <div class="dropdown-checkbox-wrapper">
              <button type="button" class="dropdown-checkbox-toggle" id="supportFilterToggle" onclick="toggleDropdownCheckbox('supportFilter')" aria-expanded="false" aria-haspopup="true" aria-controls="supportFilterMenu">
                <span class="dropdown-text">All Support Levels Selected</span>
                <span class="dropdown-arrow">▼</span>
              </button>
              <div class="dropdown-checkbox-menu" id="supportFilterMenu" role="menu" aria-labelledby="supportFilterToggle">
                ${createDropdownCheckboxOptions(uniqueSupportLevel, 'supportFilter')}
              </div>
            </div>
          </div>
        `;
      }

      if (showAllInfo) {
        tableHtml += `
          <div class="filter-group">
            <label for="cloudSupportFilterToggle">Available in Cloud:</label>
            <div class="dropdown-checkbox-wrapper">
              <button type="button" class="dropdown-checkbox-toggle" id="cloudSupportFilterToggle" onclick="toggleDropdownCheckbox('cloudSupportFilter')" aria-expanded="false" aria-haspopup="true" aria-controls="cloudSupportFilterMenu">
                <span class="dropdown-text">All Options Selected</span>
                <span class="dropdown-arrow">▼</span>
              </button>
              <div class="dropdown-checkbox-menu" id="cloudSupportFilterMenu" role="menu" aria-labelledby="cloudSupportFilterToggle">
                <label class="dropdown-checkbox-option">
                  <input type="checkbox" value="yes" checked onchange="filterComponentTable()">
                  <span>Yes</span>
                </label>
                <label class="dropdown-checkbox-option">
                  <input type="checkbox" value="no" checked onchange="filterComponentTable()">
                  <span>No</span>
                </label>
              </div>
            </div>
          </div>
          <div class="filter-group">
            <label for="enterpriseFilterToggle">Enterprise License:</label>
            <div class="dropdown-checkbox-wrapper">
              <button type="button" class="dropdown-checkbox-toggle" id="enterpriseFilterToggle" onclick="toggleDropdownCheckbox('enterpriseFilter')" aria-expanded="false" aria-haspopup="true" aria-controls="enterpriseFilterMenu">
                <span class="dropdown-text">All Options Selected</span>
                <span class="dropdown-arrow">▼</span>
              </button>
              <div class="dropdown-checkbox-menu" id="enterpriseFilterMenu" role="menu" aria-labelledby="enterpriseFilterToggle">
                <label class="dropdown-checkbox-option">
                  <input type="checkbox" value="yes" checked onchange="filterComponentTable()">
                  <span>Yes</span>
                </label>
                <label class="dropdown-checkbox-option">
                  <input type="checkbox" value="no" checked onchange="filterComponentTable()">
                  <span>No</span>
                </label>
              </div>
            </div>
          </div>
          `;
      }

      tableHtml += `</div>
        <!-- CSS styles are defined in the external redpanda-connect-filters.css stylesheet -->
        <table class="tableblock frame-all grid-all stripes-even no-clip stretch component-table sortable" id="componentTable">
          <colgroup>
            ${showAllInfo
            ? '<col style="width: 20%;"><col style="width: 20%;"><col style="width: 20%;"><col style="width: 20%;"><col style="width: 20%;">'
            : isCloud
              ? '<col style="width: 50%;"><col style="width: 50%;">'
              : '<col style="width: 25%;"><col style="width: 25%;"><col style="width: 25%;"><col style="width: 25%;">'}
          </colgroup>
          <thead>
            <tr>
              <th class="tableblock halign-left valign-top">Name</th>
              <th class="tableblock halign-left valign-top">Connector Type</th>
              ${showAllInfo ? `
                <th class="tableblock halign-left valign-top">Support Level</th>
                <th class="tableblock halign-left valign-top">Enterprise Licensed</th>
                <th class="tableblock halign-left valign-top">Available in Cloud</th>
              ` : isCloud ? '' : `
                <th class="tableblock halign-left valign-top">Support Level</th>
                <th class="tableblock halign-left valign-top">Enterprise Licensed</th>`}
            </tr>
          </thead>
          <tbody>
            ${generateConnectorsHTMLTable(processConnectors(csvData), sqlDriversData, isCloud, showAllInfo)}
          </tbody>
        </table>
        <script>
          ${filterComponentTable.toString()}
          ${updateURLParameters.toString()}
          function getQueryParams() {
            const params = {};
            const searchParams = new URLSearchParams(window.location.search);
            searchParams.forEach((value, key) => {
              params[key] = value.toLowerCase();
            });
            return params;
          }

          // Define global dropdown functions (shared between macros)
          window.initializeDropdownFunctions = window.initializeDropdownFunctions || function() {
            // Component type dropdown toggle function
            window.toggleComponentTypeDropdown = function() {
              const toggle = document.getElementById('componentTypeDropdownToggle');
              const menu = document.getElementById('componentTypeDropdownMenu');
              
              if (!toggle || !menu) return;
              
              const isOpen = menu.classList.contains('show');
              
              // Close all other dropdowns first (including filter dropdowns)
              document.querySelectorAll('.dropdown-checkbox-menu.show, .dropdown-menu.show').forEach(dropdown => {
                if (dropdown !== menu) {
                  dropdown.classList.remove('show');
                  const otherToggle = dropdown.parentNode.querySelector('.dropdown-checkbox-toggle, .dropdown-toggle');
                  if (otherToggle) {
                    otherToggle.classList.remove('open');
                    otherToggle.setAttribute('aria-expanded', 'false');
                  }
                }
              });
              
              // Toggle current dropdown
              if (isOpen) {
                menu.classList.remove('show');
                toggle.classList.remove('open');
                toggle.setAttribute('aria-expanded', 'false');
              } else {
                menu.classList.add('show');
                toggle.classList.add('open');
                toggle.setAttribute('aria-expanded', 'true');
                // Focus first option
                const firstOption = menu.querySelector('.dropdown-option');
                if (firstOption) firstOption.focus();
              }
            };

          };
          
          // Initialize the functions
          window.initializeDropdownFunctions();

          function toggleDropdownCheckbox(filterId) {
            const toggle = document.getElementById(filterId + 'Toggle');
            const menu = document.getElementById(filterId + 'Menu');
            
            if (!toggle || !menu) return;
            
            const isOpen = menu.classList.contains('show');
            
            // Close all other dropdowns first
            document.querySelectorAll('.dropdown-checkbox-menu.show').forEach(dropdown => {
              if (dropdown !== menu) {
                dropdown.classList.remove('show');
                const otherToggle = dropdown.parentNode.querySelector('.dropdown-checkbox-toggle');
                if (otherToggle) {
                  otherToggle.classList.remove('open');
                  otherToggle.setAttribute('aria-expanded', 'false');
                }
              }
            });
            
            // Toggle current dropdown
            if (isOpen) {
              menu.classList.remove('show');
              toggle.classList.remove('open');
              toggle.setAttribute('aria-expanded', 'false');
            } else {
              menu.classList.add('show');
              toggle.classList.add('open');
              toggle.setAttribute('aria-expanded', 'true');
            }
          }

          function updateDropdownText(filterId, allSelectedText, someSelectedText) {
            const menu = document.getElementById(filterId + 'Menu');
            const toggle = document.getElementById(filterId + 'Toggle');
            
            if (!menu || !toggle) return;
            
            const checkboxes = menu.querySelectorAll('input[type="checkbox"]');
            const checkedCount = menu.querySelectorAll('input[type="checkbox"]:checked').length;
            const totalCount = checkboxes.length;
            const textElement = toggle.querySelector('.dropdown-text');
            
            if (!textElement) return;
            
            if (checkedCount === 0) {
              textElement.textContent = 'None Selected';
            } else if (checkedCount === totalCount) {
              textElement.textContent = allSelectedText;
            } else if (checkedCount === 1) {
              const checkedBox = menu.querySelector('input[type="checkbox"]:checked');
              if (checkedBox) {
                const label = checkedBox.nextElementSibling;
                textElement.textContent = label ? label.textContent : getSingularText(someSelectedText);
              }
            } else {
              textElement.textContent = checkedCount + ' ' + someSelectedText;
            }
          }

          function getSingularText(pluralText) {
            // Handle various plural patterns and convert to singular
            if (pluralText.includes('Types Selected')) {
              return 'Type Selected';
            } else if (pluralText.includes('Support Levels Selected')) {
              return 'Support Level Selected';
            } else if (pluralText.includes('Options Selected')) {
              return 'Option Selected';
            } else if (pluralText.includes('Items Selected')) {
              return 'Item Selected';
            } else if (pluralText.includes('Categories Selected')) {
              return 'Category Selected';
            } else if (pluralText.includes('Filters Selected')) {
              return 'Filter Selected';
            } else if (pluralText.endsWith('s Selected')) {
              // Generic fallback for words ending in 's Selected'
              return pluralText.replace(/s Selected$/, ' Selected');
            } else if (pluralText.endsWith('ies Selected')) {
              // Handle words ending in 'ies' (e.g., "Categories Selected" -> "Category Selected")
              return pluralText.replace(/ies Selected$/, 'y Selected');
            } else {
              // If no pattern matches, return as-is
              return pluralText;
            }
          }

          // Close dropdown when clicking outside (local handler for filter dropdowns only)
          document.addEventListener('click', function(event) {
            if (!event.target.closest('.dropdown-checkbox-wrapper')) {
              document.querySelectorAll('.dropdown-checkbox-menu.show').forEach(menu => {
                menu.classList.remove('show');
                const toggle = menu.parentNode.querySelector('.dropdown-checkbox-toggle');
                if (toggle) {
                  toggle.classList.remove('open');
                  toggle.setAttribute('aria-expanded', 'false');
                }
              });
            }
          });

          // Add keyboard navigation support (local handler for filter dropdowns only)
          document.addEventListener('keydown', function(event) {
            if (event.key === 'Escape') {
              // Close all open filter dropdowns on Escape
              document.querySelectorAll('.dropdown-checkbox-menu.show').forEach(menu => {
                menu.classList.remove('show');
                const toggle = menu.parentNode.querySelector('.dropdown-checkbox-toggle');
                if (toggle) {
                  toggle.classList.remove('open');
                  toggle.setAttribute('aria-expanded', 'false');
                  toggle.focus(); // Return focus to toggle button
                }
              });
            }
          });

          // Initialize filters from URL parameters
          document.addEventListener('DOMContentLoaded', function() {
            const params = getQueryParams();
            const search = document.getElementById('componentTableSearch');
            const typeFilterMenu = document.getElementById('typeFilterMenu');
            const supportFilterMenu = document.getElementById('supportFilterMenu');
            const cloudSupportFilterMenu = document.getElementById('cloudSupportFilterMenu');
            const enterpriseFilterMenu = document.getElementById('enterpriseFilterMenu');
            
            if (params.search && search) {
              search.value = params.search;
            }
            
            if (params.type && typeFilterMenu) {
              const types = params.type.split(',');
              // First uncheck all checkboxes
              typeFilterMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
              // Then check only the ones in the URL
              types.forEach(type => {
                const checkbox = typeFilterMenu.querySelector(\`input[value="\${type}"]\`);
                if (checkbox) checkbox.checked = true;
              });
            }
            
            if (params.support && supportFilterMenu) {
              const supports = params.support.split(',');
              // First uncheck all checkboxes
              supportFilterMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
              // Then check only the ones in the URL
              supports.forEach(support => {
                const checkbox = supportFilterMenu.querySelector(\`input[value="\${support}"]\`);
                if (checkbox) checkbox.checked = true;
              });
            }
            
            if (params.cloud && cloudSupportFilterMenu) {
              const cloudOptions = params.cloud.split(',');
              // First uncheck all checkboxes
              cloudSupportFilterMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
              // Then check only the ones in the URL
              cloudOptions.forEach(option => {
                const checkbox = cloudSupportFilterMenu.querySelector(\`input[value="\${option}"]\`);
                if (checkbox) checkbox.checked = true;
              });
            }
            
            if (params.enterprise && enterpriseFilterMenu) {
              const enterpriseOptions = params.enterprise.split(',');
              // First uncheck all checkboxes
              enterpriseFilterMenu.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
              // Then check only the ones in the URL
              enterpriseOptions.forEach(option => {
                const checkbox = enterpriseFilterMenu.querySelector(\`input[value="\${option}"]\`);
                if (checkbox) checkbox.checked = true;
              });
            }
            
            filterComponentTable();
          });
        </script>
      `;
      return self.createBlock(parent, 'pass', tableHtml);
    });
  });

  /**
   * Registers a block macro to display metadata about the selected component.
   *
   * This macro creates a dropdown to select different types of a connector component, such as Input, Output, or Processor.
   * It also provides links to the corresponding Cloud or Self-Managed documentation for the selected component type, and  displays information on whether the connector requires an enterprise license.
   *
   *
   * The dropdown lists all types of the connector component:
   * - Type: A dropdown with options such as Input, Output, Processor, etc.
   *
   * Information displayed includes:
   * - Availability: Displays links to Cloud and Self-Managed (Connect) documentation.
   * - License: If the component requires an enterprise license, a message is displayed with a link to upgrade.
   *
   * Data Sources:
   * - `csvData`: Parsed CSV data providing details about each connector.
   *   It filters the data to find the relevant rows for the current connector by matching the `doctitle`.
   * - `redpandaConnectUrl`: URL for the Self-Managed version of the component documentation.
   * - `redpandaCloudUrl`: URL for the Cloud version of the component documentation.
   *
   * Example usage in AsciiDoc:
   * ```
   * component_type_dropdown::[]
   * ```
   *
   * Example output:
   * ```
   * <div class="metadata-block">
   *   <div style="padding:10px;display: flex;flex-direction: column;gap: 6px;">
   *     <p style="display: flex;align-items: center;gap: 6px;"><strong>Type:</strong>
   *       <select class="type-dropdown" onchange="window.location.href=this.value">
   *         <option value="..." data-support="certified">Input</option>
   *         <option value="..." data-support="community">Output</option>
   *       </select>
   *     </p>
   *     <p><strong>Available in:</strong> <a href="...">Cloud</a>, <a href="...">Self-Managed</a></p>
   *     <p><strong>License</strong>: This component requires an <a href="https://redpanda.com/compare-platform-editions" target="_blank">Enterprise license</a>. To upgrade, contact <a href="https://redpanda.com/try-redpanda?section=enterprise-trial" target="_blank" rel="noopener">Redpanda sales</a>.</p>
   *   </div>
   * </div>
   * ```
   *
   * @param {Object} parent - The parent document where the dropdown will be inserted.
   * @param {string} target - The target element.
   * @param {Object} attrs - Attributes passed to the macro.
  */
  registry.blockMacro(function () {
    const self = this;
    self.named('component_type_dropdown');
    self.process((parent, target, attrs) => {
      const attributes = parent.getDocument().getAttributes();
      const component = attributes['page-component-title'];  // Current component (e.g., 'Redpanda Cloud' or 'Redpanda Connect')
      const name = attributes['doctitle'];
      const type = attributes['type'];
      if (!name || !type) {
        return self.createBlock(parent, 'pass', '');
      }
      const csvData = context.config?.attributes?.csvData || null;
      if (!csvData) return console.error(`CSV data is not available for ${attributes['page-relative-src-path']}. Make sure your playbook includes the generate-rp-connect-info extension.`);
      // Filter for the specific connector by name
      const componentRows = csvData.data.filter(row => row.connector.trim().toLowerCase() === name.trim().toLowerCase());
      if (componentRows.length === 0) {
        console.error(`No data found for connector: ${name}`);
      }
      // Process types and metadata from CSV
      const types = componentRows.map(row => ({
        type: row.type.trim(),
        support: row.support_level.trim(),
        isCloudSupported: row.is_cloud_supported === 'y',
        redpandaConnectUrl: row.redpandaConnectUrl,
        redpandaCloudUrl: row.redpandaCloudUrl
      }));
      // Move the current page's type to the first position in the dropdown
      const sortedTypes = [...types];
      const currentTypeIndex = sortedTypes.findIndex(typeObj => typeObj.type === type);
      if (currentTypeIndex !== -1) {
        const [currentType] = sortedTypes.splice(currentTypeIndex, 1);
        sortedTypes.unshift(currentType);
      }
      // Check if the component requires an Enterprise license (based on support level)
      let enterpriseLicenseInfo = '';
      if (component !== 'Cloud') {
        const requiresEnterprise = componentRows.some(row => row.is_licensed.toLowerCase() === 'yes');
        if (requiresEnterprise) {
          enterpriseLicenseInfo = `
            <p><strong>License</strong>: This component requires an <a href="https://docs.redpanda.com/redpanda-connect/get-started/licensing/" target="_blank">enterprise license</a>. You can either <a href="https://www.redpanda.com/upgrade" target="_blank">upgrade to an Enterprise Edition license</a>, or <a href="http://redpanda.com/try-enterprise" target="_blank" rel="noopener">generate a trial license key</a> that's valid for 30 days.</p>`;
        }
      }
      const isCloudSupported = componentRows.some(row => row.is_cloud_supported === 'y');
      let availableInInfo = '';

      if (isCloudSupported) {
        const availableInLinks = [];

        // Check if the component is Cloud and apply the `current-version` class
        if (sortedTypes[0].redpandaCloudUrl) {
          if (component === 'Cloud') {
            availableInLinks.push('<span title="You are viewing the Cloud version of this component" class="current-version">Cloud</span>'); // Highlight the current version
          } else {
            availableInLinks.push(`<a title="View the Cloud version of this component" href="${sortedTypes[0].redpandaCloudUrl}">Cloud</a>`);
          }
        }

        // Check if the component is Connect and apply the `current-version` class
        if (sortedTypes[0].redpandaConnectUrl) {
          if (component === 'Connect') {
            availableInLinks.push('<span title="You are viewing the Self-Managed version of this component" class="current-version">Self-Managed</span>'); // Highlight the current version
          } else {
            availableInLinks.push(`<a title="View the Self-Managed version of this component" href="${sortedTypes[0].redpandaConnectUrl}">Self-Managed</a>`);
          }
        }
        availableInInfo = `<p><strong>Available in:</strong> ${availableInLinks.join(', ')}</p>`;
      } else {
        availableInInfo = `<p><strong>Available in:</strong> <span title="You are viewing the Self-Managed version of this component" class="current-version">Self-Managed</span></p>`;
      }
      // Build the dropdown for types with links depending on the current component
      let typeDropdown = '';
      if (sortedTypes.length > 1) {
        const dropdownOptions = sortedTypes.map(typeObj => {
          const link = (component === 'Cloud' && typeObj.redpandaCloudUrl) || typeObj.redpandaConnectUrl;
          return `<a href="${link}" class="dropdown-option" role="menuitem" tabindex="-1">${capitalize(typeObj.type)}</a>`;
        }).join('');
        typeDropdown = `
          <div class="dropdown-wrapper">
            <p class="type-dropdown-container"><strong>Type:</strong>
              <button type="button" class="dropdown-toggle" id="componentTypeDropdownToggle" onclick="toggleComponentTypeDropdown()" aria-expanded="false" aria-haspopup="true" aria-controls="componentTypeDropdownMenu">
                <span class="dropdown-text">${capitalize(sortedTypes[0].type)}</span>
                <span class="dropdown-arrow">▼</span>
              </button>
              <div class="dropdown-menu" id="componentTypeDropdownMenu" role="menu" aria-labelledby="componentTypeDropdownToggle">
                ${dropdownOptions}
              </div>
            </p>
          </div>`;
      }
      // Return the metadata block with consistent layout
      return self.createBlock(parent, 'pass', `
        <div class="metadata-block">
          <div class="metadata-content">
          ${typeDropdown}
          ${availableInInfo}
          ${enterpriseLicenseInfo}
          </div>
        </div>
        <script>
          // Define global dropdown functions directly (shared between macros)
          if (!window.toggleComponentTypeDropdown) {
            window.toggleComponentTypeDropdown = function() {
              const toggle = document.getElementById('componentTypeDropdownToggle');
              const menu = document.getElementById('componentTypeDropdownMenu');
              
              if (!toggle || !menu) return;
              
              const isOpen = menu.classList.contains('show');
              
              // Close all other dropdowns first (including filter dropdowns)
              document.querySelectorAll('.dropdown-checkbox-menu.show, .dropdown-menu.show').forEach(dropdown => {
                if (dropdown !== menu) {
                  dropdown.classList.remove('show');
                  const otherToggle = dropdown.parentNode.querySelector('.dropdown-checkbox-toggle, .dropdown-toggle');
                  if (otherToggle) {
                    otherToggle.classList.remove('open');
                    otherToggle.setAttribute('aria-expanded', 'false');
                  }
                }
              });
              
              // Toggle current dropdown
              if (isOpen) {
                menu.classList.remove('show');
                toggle.classList.remove('open');
                toggle.setAttribute('aria-expanded', 'false');
              } else {
                menu.classList.add('show');
                toggle.classList.add('open');
                toggle.setAttribute('aria-expanded', 'true');
                // Focus first option
                const firstOption = menu.querySelector('.dropdown-option');
                if (firstOption) firstOption.focus();
              }
            };
          }
        </script>`);
    });
  });

  let tabsCounter = 1; // Counter for generating unique IDs

  // Add the category tabs for components
  registry.blockMacro(function () {
    const self = this;
    self.named('components_by_category');
    self.positionalAttributes(['type']);
    self.process((parent, target, attrs) => {
      const type = attrs.type;
      const categoriesData = context.config?.attributes?.connectCategoriesData || null
      if (!categoriesData) return console.error (`Category data is not available for ${parent.getDocument().getAttributes()['page-relative-src-path']}. Make sure your playbook includes the generate-rp-connect-categories extension.`)
      const categories = categoriesData[type] || null;
      const currentTabsId = `tabs-${tabsCounter++}`; // Unique ID for this set of tabs
      if (!categories) return

      let tabsHtml = `
      <div id="${currentTabsId}" class="openblock tabs is-sync is-loaded" data-sync-group-id="${type}">
        <div class="content">
          <div class="ulist tablist">
            <ul role="tablist">`;

      categories.forEach((category, index) => {
        tabsHtml += `
        <li id="${currentTabsId}-${category.name}" class="tab" tabindex="${index === 0 ? '0' : '-1'}" role="tab" data-sync-id="${category.name}" aria-controls="${currentTabsId}-${category.name}--panel" aria-selected="${index === 0}">
          <p>${category.name}</p>
        </li>`;
      });

      tabsHtml += `
      </ul>
    </div>`;

      categories.forEach((category, index) => {
        tabsHtml += `
    <div id="${currentTabsId}-${category.name}--panel" class="tabpanel${index === 0 ? '' : ' is-hidden'}" aria-labelledby="${currentTabsId}-${category.name}"${index === 0 ? '' : ' hidden'} role="tabpanel">
      <div class="listingblock">
        <div class="content">
          <p>${category.description}</p>
          <div class="two-column-grid">`;
        category.items.forEach(item => {
          tabsHtml += `
          <a href="${item.url}" class="component-card"><strong>${item.name}</strong></a>`;
        });
        tabsHtml += `
          </div>
        </div>
      </div>
    </div>`;
      });

      tabsHtml += `
  </div>
</div>`;

      return self.createBlock(parent, 'pass', tabsHtml);
    });
  });
};
