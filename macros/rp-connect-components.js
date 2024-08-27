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
            
            
            ( (!nameInput || nameText.includes(nameInput))   && 
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
      const flatComponentsData = context.config?.attributes?.flatComponentsData || [];
      const driverNameMap = context.config?.attributes?.drivers || [];
      const cacheNameMap = context.config?.attributes?.caches || [];
      const driverSupportData = context.config?.attributes?.driverSupportData || {};
      const cacheSupportData = context.config?.attributes?.cacheSupportData || {};

      // Sort flatComponentsData alphabetically by name
      flatComponentsData.sort((a, b) => a.name.localeCompare(b.name));

      const createOptions = (values) => 
        values.map(value => `<option selected value="${value}">${capitalize(value)}</option>`).join('');

      // Filter components to get unique types and support values. Types accepted: ['input', 'processor', 'output']
      const uniqueTypes = [...new Set(flatComponentsData.flatMap(item => item.types.map(typeObj => typeObj.type)))].filter(type => ['input', 'processor', 'output'].includes(type));
      const uniqueSupportValues = [...new Set(Object.values(driverSupportData).flatMap(support => support.split(', ').map(pair => pair.split('=')[1])))];

      let tableHtml = `
        <div class="table-filters">
          <input class="table-search" type="text" id="componentTableSearch" onkeyup="filterComponentTable()" placeholder="Search for components...">
          <label for="typeFilter">Type:</label>
          <select multiple class="type-dropdown" id="typeFilter" onchange="filterComponentTable()">
            ${createOptions(uniqueTypes)}
          </select>
          <label for="supportFilter">Support:</label>
          <select multiple class="type-dropdown" id="supportFilter" onchange="filterComponentTable()">
            ${createOptions(uniqueSupportValues)}
          </select>
        </div>
      `;

      tableHtml +=`
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
            <th class="tableblock halign-left valign-top">Licensed</th>
          </tr>
        </thead>
        <tbody>`;

        flatComponentsData.forEach(item => {
          let id=0
          const commonName = item.originalName !== item.name ? ` <small>(${item.name})</small>`: '';
          const isEnterprise = item.enterprise ? '<span class="enterprise-label" title="Requires an Enterprise Edition license">Enterprise</span>' : '';
          
          const processItem = (supportPair, type, nameMap) => {
            let name, support;
            if (type) {
              [name, support] = supportPair.split('=');
              name = (nameMap && nameMap[name]) || name;
            } else {
              support = item.support;
            }
        
            const filteredTypes = item.types.filter(typeOption => ['input', 'processor', 'output'].includes(typeOption.type));
            if (filteredTypes.length > 0) {
              const typeLinks = filteredTypes.map(typeOption => 
                `<a href="${typeOption.url}">${capitalize(typeOption.type)}</a>`
              ).join(', ');
        
              const additionalInfo = type ? `<br><span>${name} ${type}</span>` : '';
        
              tableHtml += `
              <tr id="row-${id}">
                <td class="tableblock halign-left valign-top" id="componentName-${id}">
                  <p class="tableblock">
                    <p class="enterprise-label-container">${isEnterprise}</p>
                    <code><a href="${filteredTypes[0].url}">${item.originalName}</a></code>${commonName}${additionalInfo}
                  </p>
                </td>
                <td class="tableblock halign-left valign-top" id="componentType-${id}">
                  <p class="tableblock">${typeLinks}</p>
                </td>
                <td class="tableblock halign-left valign-top" id="componentSupport-${id}">
                  <p class="tableblock">${capitalize(support)}</p>
                </td>
                <td class="tableblock halign-left valign-top" id="componentLicense-${id}">
                  <p class="tableblock">No</p>
                </td>
              </tr>`;
            }
          };
        
          if (driverSupportData[item.originalName]) {
            driverSupportData[item.originalName].split(', ').forEach(pair => processItem(pair, 'driver', driverNameMap));
          } else if (cacheSupportData[item.originalName]) {
            cacheSupportData[item.originalName].split(', ').forEach(pair => processItem(pair, 'cache', cacheNameMap));
          } else {
            processItem(null, '', null);
          }
          id++;
        });

      tableHtml += `
        </tbody>
      </table>
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
