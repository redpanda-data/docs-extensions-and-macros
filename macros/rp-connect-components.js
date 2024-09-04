'use strict';

module.exports.register = function (registry, context) {

  function filterComponentTable() {
    // Retrieve and standardize filter inputs
    const nameInput = document.getElementById('componentTableSearch').value.trim().toLowerCase();
    const typeFilter = Array.from(document.querySelector('#typeFilter').selectedOptions).map(option => option.value);

    // Check if the supportFilter element exists
    const supportFilterElement = document.querySelector('#supportFilter');
    const supportFilter = supportFilterElement
      ? Array.from(supportFilterElement.selectedOptions).map(option => option.value)
      : [];

    const table = document.getElementById('componentTable');
    const trs = table.getElementsByTagName('tr');

    for (let i = 1; i < trs.length; i++) {
      const row = trs[i];
      const nameTd = row.querySelector('td[id^="componentName-"]');
      const typeTd = row.querySelector('td[id^="componentType-"]');
      const supportTd = row.querySelector('td[id^="componentSupport-"]');
      const typeDropdown = typeTd ? typeTd.querySelector('.type-dropdown') : null;

      if (nameTd && typeTd) {
        const nameText = nameTd.textContent.trim().toLowerCase();
        const typeText = typeTd.textContent.trim().toLowerCase().split(', ').map(item => item.trim());
        const supportText = supportTd ? supportTd.textContent.trim().toLowerCase() : '';

        // Determine if the row should be shown
        const showRow =
          ((!nameInput || nameText.includes(nameInput)) &&
            (typeFilter.length === 0 || typeFilter.some(value => typeText.includes(value))) &&
            (!supportTd || supportFilter.length === 0 || supportFilter.some(value => supportText.includes(value)))
          );

        row.style.display = showRow ? '' : 'none';

        if (showRow && typeFilter.length > 0 && typeDropdown) {
          const matchingOption = Array.from(typeDropdown.options).find(option =>
            typeFilter.includes(option.text.toLowerCase())
          );
          if (matchingOption) {
            typeDropdown.value = matchingOption.value;
            updateComponentUrl(typeDropdown, false);
          }
        }
      } else {
        row.style.display = 'none'; // Hide row if essential cells are missing
      }
    }
  }

  const capitalize = s => s && s[0].toUpperCase() + s.slice(1);

  function processConnectors(parsedData) {
    return parsedData.data.reduce((connectors, row) => {
      const { connector, commercial_name, type, support_level, is_cloud_supported, is_licensed, url } = row;
      let isCloudSupported = is_cloud_supported === 'y'
      if (!connectors[connector]) {
        connectors[connector] = {
          types: new Map(),
          supportLevels: new Map(),
          isLicensed: is_licensed === 'y' ? 'Yes' : 'No',
          isCloudConnectorSupported : isCloudSupported,
          urls: new Set()
        };
      }
      connectors[connector].types.set(capitalize(type), { url, isCloudSupported });
      if (url) connectors[connector].urls.add(url);
      if (!connectors[connector].supportLevels.has(support_level)) {
        connectors[connector].supportLevels.set(support_level, new Set());
      }
      connectors[connector].supportLevels.get(support_level).add(commercial_name);
      return connectors;
    }, {});
  }


  function generateConnectorsHTMLTable(connectors, isCloud) {
    return Object.entries(connectors).map(([connector, details], id) => {
      const { types, supportLevels, isCloudConnectorSupported, isLicensed, urls } = details;
      const firstUrl = urls.size > 0 ? urls.values().next().value : null;

      const typesArray = Array.from(types.entries())
      .map(([type, { url, isCloudSupported }]) => {
          if (isCloudSupported) {
              return url ? `<a href="../${url}">${type}</a>` : `<span>${type}</span>`;
          } else {
              return '';
          }
      })
      .filter(item => item !== '');

      const typesStr = typesArray.join(', ');

      const supportLevelStr = Array.from(supportLevels.entries())
        .map(([level, names]) => `<p><b>${capitalize(level)}</b>: ${Array.from(names).join(', ')}</p>`)
        .join('');

      const connectorNameHtml = firstUrl
        ? `<code><a href="../${firstUrl}">${connector}</a></code>`
        : `<code><span>${connector}</span></code>`;

      if (isCloud) {
        if (isCloudConnectorSupported) {
          return `
            <tr id="row-${id}">
              <td class="tableblock halign-left valign-top" id="componentName-${id}">
                <p class="tableblock">${connectorNameHtml}</p>
              </td>
              <td class="tableblock halign-left valign-top" id="componentType-${id}">
                <p class="tableblock">${typesStr}</p>
              </td>
            </tr>`;
        } else {
          return '';
        }
      } else {
        return `
          <tr id="row-${id}">
            <td class="tableblock halign-left valign-top" id="componentName-${id}">
              <p class="tableblock">${connectorNameHtml}</p>
            </td>
            <td class="tableblock halign-left valign-top" id="componentType-${id}">
              <p class="tableblock">${typesStr}</p>
            </td>
            <td class="tableblock halign-left valign-top" id="componentSupport-${id}">
              <p class="tableblock">${supportLevelStr.trim()}</p>
            </td>
            <td class="tableblock halign-left valign-top" id="componentLicense-${id}">
              <p class="tableblock">${isLicensed}</p>
            </td>
          </tr>`;
      }
    }).filter(row => row !== '').join(''); // Filter out empty rows
  }



  let tabsCounter = 1; // Counter for generating unique IDs

  // Add the category tabs for components
  registry.blockMacro(function () {
    const self = this;
    self.named('components_by_category');
    self.positionalAttributes(['type']);
    self.process((parent, target, attrs) => {
      const type = attrs.type;
      const categoriesData = context.config?.attributes?.connectCategoriesData || {}
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

  // Add the searchable table of all components (component catalog)
  registry.blockMacro(function () {
    const self = this;
    self.named('component_table');
    self.process((parent, target, attrs) => {
      const isCloud = attrs["is_cloud"];
      const csvData = context.config?.attributes?.csvData || [];
      const types = new Set();
      const uniqueSupportLevel = new Set();

      csvData.data.forEach(row => {
        if (row.type) types.add(row.type);
        if (row.support_level) uniqueSupportLevel.add(row.support_level);
      });

      const createOptions = (values) =>
        Array.from(values)
          .map(value => `<option selected value="${value}">${capitalize(value)}</option>`)
          .join('');

      let tableHtml = `
        <div class="table-filters">
          <input class="table-search" type="text" id="componentTableSearch" onkeyup="filterComponentTable()" placeholder="Search for components...">
          <label for="typeFilter">Type:</label>
          <select multiple class="type-dropdown" id="typeFilter" onchange="filterComponentTable()">
            ${createOptions(types)}
          </select>
          `
      if (!isCloud) {
        tableHtml += `
            <br><label for="supportFilter" id="labelForSupportFilter">Support:</label>
               <select multiple class="type-dropdown" id="supportFilter" onchange="filterComponentTable()">
                 ${createOptions(uniqueSupportLevel)}
               </select>`
      }

      tableHtml += `</div>
        <table class="tableblock frame-all grid-all stripes-even no-clip stretch component-table" id="componentTable">
          <colgroup>
            ${isCloud
          ? '<col style="width: 50%;"><col style="width: 50%;">'
          : '<col style="width: 25%;"><col style="width: 25%;"><col style="width: 25%;"><col style="width: 25%;">'
        }
          </colgroup>
          <thead>
            <tr>
              <th class="tableblock halign-left valign-top">Name</th>
              <th class="tableblock halign-left valign-top">Connector Type</th>
              ${isCloud ? '' : `
              <th class="tableblock halign-left valign-top">Support Level</th>
              <th class="tableblock halign-left valign-top">Enterprise Licensed</th>`}
            </tr>
          </thead>
          <tbody>
            ${generateConnectorsHTMLTable(processConnectors(csvData), isCloud)}
          </tbody>
        </table>
        <script>
        ${filterComponentTable.toString()}

        function getQueryParams() {
          const params = {};
          const searchParams = new URLSearchParams(window.location.search);
          searchParams.forEach((value, key) => {
            params[key] = value;
          });
          return params;
        }

        function updateComponentUrl(select, redirect) {
          const anchor = select.closest('tr').querySelector('a');
          anchor.href = select.value;
          if (redirect) {
            window.location.href = select.value; // Redirect to the new URL
          }
        }

        // Initialize Choices.js for type dropdowns
        document.addEventListener('DOMContentLoaded', function() {
        const params = getQueryParams();
        if (params.search) {
          document.getElementById('componentTableSearch').value = params.search;
        }
        if (params.type) {
          document.getElementById('typeFilter').value = params.type;
        }
          if (params.support) {
            document.getElementById('supportFilter').value = params.support;
          }
        
        filterComponentTable();
        const typeDropdowns = document.querySelectorAll('.type-dropdown');
        typeDropdowns.forEach(dropdown => {
          new Choices(dropdown, { 
            searchEnabled: false, 
            allowHTML: true,
            removeItemButton: true });
          });
        });
        </script>`;

      return self.createBlock(parent, 'pass', tableHtml);
    });
  });

  registry.blockMacro(function () {
    const self = this;
    self.named('component_type_dropdown');
    self.process((parent, target, attrs) => {
      const attributes = parent.getDocument().getAttributes();
      const name = attributes['doctitle'];
      const type = attributes['type'];

      if (!name || !type) {
        return self.createBlock(parent, 'pass', '');
      }

      const csvData = context.config?.attributes?.csvData || [];
      const componentRows = csvData.data.filter(row => row.connector.trim().toLowerCase() === name.trim().toLowerCase());

      if (componentRows.length === 0) {
        return self.createBlock(parent, 'pass', '');
      }

      // Process types from CSV
      const types = componentRows.map(row => ({
        type: row.type.trim(),
        support: row.support_level.trim(),
        url: row.url ? row.url.trim() : '#'
      }));

      // Move the current page's type to the first position in the dropdown
      const sortedTypes = [...types];
      const currentTypeIndex = sortedTypes.findIndex(typeObj => typeObj.type === type);
      if (currentTypeIndex !== -1) {
        const [currentType] = sortedTypes.splice(currentTypeIndex, 1);
        sortedTypes.unshift(currentType);
      }

      // Check if the component requires an Enterprise license (based on support level)
      let enterpriseAdmonition = '';
      if (componentRows.some(row => row.support_level.toLowerCase() === 'enterprise')) {
        enterpriseAdmonition = `
        <div class="admonitionblock note">
          <table>
            <tbody>
              <tr>
                <td class="icon">
                  <i class="fa icon-note" title="Note"></i>
                </td>
                <td class="content">
                  <div class="paragraph">
                  <p>This feature requires an <a href="https://redpanda.com/compare-platform-editions" target="_blank">Enterprise license</a>. To upgrade, contact <a href="https://redpanda.com/try-redpanda?section=enterprise-trial" target="_blank" rel="noopener">Redpanda sales</a>.</p>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>`;
      }

      // Create the dropdown for types
      let typeDropdown = '';
      if (sortedTypes.length > 1) {
        typeDropdown = `
        <div class="page-type-dropdown">
          <p>Type: </p>
          <select class="type-dropdown" onchange="window.location.href=this.value">
            ${sortedTypes.map(typeObj => `<option value="../${typeObj.url}" data-support="${typeObj.support}">${capitalize(typeObj.type)}</option>`).join('')}
          </select>
        </div>
        <script>
        // Initialize Choices.js for type dropdowns
        document.addEventListener('DOMContentLoaded', function() {
          const typeDropdowns = document.querySelectorAll('.type-dropdown');
          typeDropdowns.forEach(dropdown => {
            new Choices(dropdown, { searchEnabled: false, allowHTML: true, shouldSort: false });
          });
        });
        </script>`;
      }
      return self.createBlock(parent, 'pass', typeDropdown + enterpriseAdmonition);
    });
  });
};