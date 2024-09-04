'use strict';

module.exports.register = function (registry, context) {

  function filterComponentTable() {
    // Retrieve and standardize filter inputs
    const nameInput = document.getElementById('componentTableSearch').value.trim().toLowerCase();
    const supportFilter = Array.from(document.querySelector('#supportFilter').selectedOptions).map(option => option.value);
    const typeFilter = Array.from(document.querySelector('#typeFilter').selectedOptions).map(option => option.value);

    const table = document.getElementById('componentTable');
    const trs = table.getElementsByTagName('tr');

    for (let i = 1; i < trs.length; i++) {
      const row = trs[i];
      const nameTd = row.querySelector('td[id^="componentName-"]');
      const supportTd = row.querySelector('td[id^="componentSupport-"]');
      const typeTd = row.querySelector('td[id^="componentType-"]');
      const typeDropdown = typeTd ? typeTd.querySelector('.type-dropdown') : null;

      if (nameTd && supportTd && typeTd) {
        const nameText = nameTd.textContent.trim().toLowerCase();
        const supportText = supportTd.textContent.trim().toLowerCase();
        const typeText = typeTd.textContent.trim().toLowerCase().split(', ').map(item => item.trim());

        // Determine if the row should be shown
        const showRow =


          ((!nameInput || nameText.includes(nameInput)) &&
            (typeFilter.some(value => typeText.includes(value))) &&
            (supportFilter.some(value => supportText.includes(value)))
          )

        row.style.display = showRow ? '' : 'none';

        if (showRow && typeFilter && typeDropdown) {
          const matchingOption = Array.from(typeDropdown.options).find(option => option.text.toLowerCase() === typeFilter);
          if (matchingOption) {
            typeDropdown.value = matchingOption.value;
            updateComponentUrl(typeDropdown, false);
          }
        }
      } else {
        row.style.display = 'none'; // Hide row if cells are missing
      }
    }
  }

  const capitalize = s => s && s[0].toUpperCase() + s.slice(1) // capitalize the first letter

  function processConnectors(parsedData) {
    const connectors = {};

    parsedData.data.forEach(row => {
      const { connector, commercial_name, type, support_level, is_licensed, url } = row;

      if (!connectors[connector]) {
        connectors[connector] = {
          types: new Map(),
          supportLevels: new Map(),
          isLicensed: is_licensed === 'y' ? 'Yes' : 'No',
          urls: new Set()
        };
      }

      // Add types with their corresponding URLs
      connectors[connector].types.set(capitalize(type), url);

      // Add URL to the set of URLs
      if (url) {
        connectors[connector].urls.add(url);
      }

      // Group support levels by commercial name
      if (!connectors[connector].supportLevels.has(support_level)) {
        connectors[connector].supportLevels.set(support_level, new Set());
      }
      connectors[connector].supportLevels.get(support_level).add(commercial_name);
    });

    return connectors;
  }

  function generateConnectorsHTMLTable(connectors,isCloud) {
    let html = '';
    let id = 0;

    for (const [connector, details] of Object.entries(connectors)) {
      const { types, supportLevels, isLicensed, urls } = details;

      const firstUrl = urls.values().next().value || '#';

      let typesStr = Array.from(types.entries()).map(([type, url]) =>
        `<a href="${url || '#'}">${type}</a>`
      ).join(', ');

      let supportLevelStr = '';
      supportLevels.forEach((commercialNames, level) => {
        supportLevelStr += `<p><b>${capitalize(level)}</b>: ${Array.from(commercialNames).join(', ')} </p>`;
      });
      
      if(isCloud){
        html += `<tr id="row-${id}">
        <td class="tableblock halign-left valign-top" id="componentName-${id}">
            <p class="tableblock">
                <code><a href="${firstUrl}">${connector}</a></code>
            </p>
        </td>
        <td class="tableblock halign-left valign-top" id="componentType-${id}">
            <p class="tableblock">${typesStr}</p>
        </td>
        </tr>`;
      }
      else{
        html += `<tr id="row-${id}">
            <td class="tableblock halign-left valign-top" id="componentName-${id}">
                <p class="tableblock">
                    <code><a href="${firstUrl}">${connector}</a></code>
                </p>
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

      
      id++;
    }
    return html;
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
       // Retrieve the value passed as `abc`
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
        if(!isCloud){
          tableHtml+=`
          <label for="supportFilter">Support:</label>
          <select multiple class="type-dropdown" id="supportFilter" onchange="filterComponentTable()">
            ${createOptions(uniqueSupportLevel)}
          </select>
      `;
      }

      tableHtml += `
      </div>`

      if(isCloud){
        tableHtml += `
        <table class="tableblock frame-all grid-all stripes-even no-clip stretch component-table" id="componentTable">
        <colgroup>
          <col style="width: 50%;">
          <col style="width: 50%;">
        </colgroup>
        <thead>
          <tr>
            <th class="tableblock halign-left valign-top">Name</th>
            <th class="tableblock halign-left valign-top">Connector Type</th>
          </tr>
        </thead>
        <tbody>`;
        
      }

      else{
      tableHtml += `
      <table class="tableblock frame-all grid-all stripes-even no-clip stretch component-table" id="componentTable">
        <colgroup>
          <col style="width: 25%;">
          <col style="width: 25%;">
          <col style="width: 25%;">
          <col style="width: 25%;">
        </colgroup>
        <thead>
          <tr>
            <th class="tableblock halign-left valign-top">Name</th>
            <th class="tableblock halign-left valign-top">Connector Type</th>
            <th class="tableblock halign-left valign-top">Support Level</th>
            <th class="tableblock halign-left valign-top">Enterprise Licensed</th>
          </tr>
        </thead>
        <tbody>`;

      }

      const processedConnectors = processConnectors(csvData);
      const connectorsHTMLTable = generateConnectorsHTMLTable(processedConnectors,isCloud);
      tableHtml += connectorsHTMLTable;
      tableHtml += '</tbody></table>';
      tableHtml += `
      <script>
      ${filterComponentTable}


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
        if (params.support) {
          document.getElementById('supportFilter').value = params.support;
        }
        if (params.type) {
          document.getElementById('typeFilter').value = params.type;
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
  // Add the block macro for displaying a dropdown of other supported types
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

      const flatComponentsData = context.config?.attributes?.flatComponentsData || []
      const component = flatComponentsData.find(item => item.originalName === name);

      if (!component) {
        return self.createBlock(parent, 'pass', '');
      }

      // Check if the component requires an Enterprise license
      let enterpriseAdmonition = '';
      if (component.enterprise) {
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

      // Move the page's current type to the first position in the dropdown
      const sortedTypes = [...component.types];
      const currentTypeIndex = sortedTypes.findIndex(typeObj => typeObj.type === type);
      if (currentTypeIndex !== -1) {
        const [currentType] = sortedTypes.splice(currentTypeIndex, 1);
        sortedTypes.unshift(currentType);
      }
      let typeDropdown = '';
      if (component.types.length > 1) {
        typeDropdown = `
        <div class="page-type-dropdown">
          <p>Type: </p>
          <select class="type-dropdown" onchange="window.location.href=this.value">
            ${sortedTypes.map(typeObj => `<option value="${typeObj.url}" data-support="${typeObj.support}">${capitalize(typeObj.type)}</option>`).join('')}
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
