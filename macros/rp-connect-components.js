'use strict';

/**
 * Registers macros for use in Redpanda Connect contexts in the Redpanda documentation.
  * @param {Registry} registry - The Antora registry where this block macro is registered.
  * @param {Object} context - The Antora context that provides access to configuration data, such as parsed CSV content.
*/
module.exports.register = function (registry, context) {
  function filterComponentTable() {
    const nameInput = document.getElementById('componentTableSearch').value.trim().toLowerCase();
    const typeFilter = Array.from(document.querySelector('#typeFilter').selectedOptions).map(option => option.value);

    // Check for the existence of support and enterprise license filters (optional)
    const supportFilterElement = document.querySelector('#supportFilter');
    const supportFilter = supportFilterElement
      ? Array.from(supportFilterElement.selectedOptions).map(option => option.value)
      : [];

    const params = getQueryParams();
    const enterpriseSupportFilter = params.support === 'enterprise';  // Check if 'support=enterprise' is in the URL
    const cloudSupportFilter = params.support === 'cloud';  // Check if 'support=cloud' is in the URL

    const table = document.getElementById('componentTable');
    const trs = table.getElementsByTagName('tr');

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

        // Determine if the row should be shown
        const showRow =
          ((!nameInput || nameText.includes(nameInput)) &&  // Filter by name if present
           (typeFilter.length === 0 || typeFilter.some(value => typeText.includes(value))) &&  // Filter by type
           (!supportTd || supportFilter.length === 0 || supportFilter.some(value => supportText.includes(value))) &&  // Filter by support if present
           (!enterpriseSupportFilter || !enterpriseSupportTd || supportText.includes('enterprise') || enterpriseSupportText === 'yes') // Filter by enterprise support if 'support=enterprise' is in the URL
           &&
           (!cloudSupportFilter || !cloudSupportTd || supportText.includes('cloud') || cloudSupportText === 'yes') // Filter by cloud support if 'support=cloud' is in the URL
          );

        row.style.display = showRow ? '' : 'none';
      } else {
        row.style.display = 'none'; // Hide row if the Type column is missing
      }
    }
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
        // Build the cloud support column
        const firstCloudSupportedType = Array.from(types.entries())
          .map(([_, commercialNames]) => Object.values(commercialNames).find(({ isCloudSupported }) => isCloudSupported))
          .find(entry => entry && entry.urls.redpandaCloudUrl);
        const cloudLinkDisplay = firstCloudSupportedType
          ? `<a href="${firstCloudSupportedType.urls.redpandaCloudUrl}">Yes</a>`
          : 'No';

        // Logic for showAllInfo = true and isCloud = false
        if (showAllInfo && !isCloud) {
          return `
            <tr id="row-${id}">
              <td class="tableblock halign-left valign-top" id="componentName-${id}">
                <p class="tableblock">${connector}</p>
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
                <p class="tableblock">${connector}</p>
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
              <p class="tableblock">${connector}</p>
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

      const createOptions = (values) =>
        Array.from(values)
          .map(value => `<option selected value="${value}">${capitalize(value).replace("_", " ")}</option>`)
          .join('');

      let tableHtml = `
        <div class="table-filters">
          <input class="table-search" type="text" id="componentTableSearch" onkeyup="filterComponentTable()" placeholder="Search for components...">
          <label for="typeFilter">Type:</label>
          <select multiple class="type-dropdown" id="typeFilter" onchange="filterComponentTable()">
            ${createOptions(types)}
          </select>
      `;

      if (!isCloud) {
        tableHtml += `
          <br><label for="supportFilter" id="labelForSupportFilter">Support:</label>
          <select multiple class="type-dropdown" id="supportFilter" onchange="filterComponentTable()">
            ${createOptions(uniqueSupportLevel)}
          </select>
        `;
      }

      tableHtml += `</div>
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
                <th class="tableblock halign-left valign-top">Cloud Support</th>
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
          function getQueryParams() {
            const params = {};
            const searchParams = new URLSearchParams(window.location.search);
            searchParams.forEach((value, key) => {
              params[key] = value.toLowerCase();
            });
            return params;
          }

          // Initialize Choices.js for type dropdowns
          document.addEventListener('DOMContentLoaded', function() {
            const params = getQueryParams();
            const search = document.getElementById('componentTableSearch');
            const typeFilter = document.getElementById('typeFilter');
            const supportFilter = document.getElementById('supportFilter');
            if (params.search && search) {
              search.value = params.search;
            }
            if (params.type && typeFilter) {
              typeFilter.value = params.type;
            }
            if (params.support && supportFilter) {
              supportFilter.value = params.support;
            }
            filterComponentTable();
            const typeDropdowns = document.querySelectorAll('.type-dropdown');
            typeDropdowns.forEach(dropdown => {
              new Choices(dropdown, {
                searchEnabled: false,
                allowHTML: true,
                removeItemButton: true
              });
            });
          });
        </script>
      `;
      return self.createBlock(parent, 'pass', tableHtml);
    });
  });

  /**
   * Registers a block macro to generate a dropdown for component types and display metadata about the selected component.
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
      const requiresEnterprise = componentRows.some(row => row.is_licensed.toLowerCase() === 'yes');
      let enterpriseLicenseInfo = '';
      if (requiresEnterprise) {
        enterpriseLicenseInfo = `
          <p><strong>License</strong>: This component requires an <a href="https://redpanda.com/compare-platform-editions" target="_blank">Enterprise license</a>. To upgrade, contact <a href="https://redpanda.com/try-redpanda?section=enterprise-trial" target="_blank" rel="noopener">Redpanda sales</a>.</p>`;
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
        const dropdownLinks = sortedTypes.map(typeObj => {
          const link = (component === 'Cloud' && typeObj.redpandaCloudUrl) || typeObj.redpandaConnectUrl;
          return `<option value="${link}" data-support="${typeObj.support}">${capitalize(typeObj.type)}</option>`;
        }).join('');
        typeDropdown = `
          <p style="display: flex;align-items: center;gap: 6px;"><strong>Type:</strong>
            <select class="type-dropdown" onchange="window.location.href=this.value">
              ${dropdownLinks}
            </select>
          </p>
          <script>
          // Initialize Choices.js for type dropdowns
          document.addEventListener('DOMContentLoaded', function() {
            const typeDropdowns = document.querySelectorAll('.type-dropdown');
            typeDropdowns.forEach(dropdown => {
              new Choices(dropdown, { searchEnabled: false, allowHTML: true, shouldSort: false, itemSelectText: '' });
            });
          });
          </script>`;
      }
      // Return the metadata block with consistent layout
      return self.createBlock(parent, 'pass', `
        <div class="metadata-block">
          <div style="padding:10px;display: flex;flex-direction: column;gap: 6px;">
          ${typeDropdown}
          ${availableInInfo}
          ${enterpriseLicenseInfo}
          </div>
        </div>`);
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
