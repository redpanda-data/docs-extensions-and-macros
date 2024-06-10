'use strict';

module.exports.register = function (registry, context) {
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

      let tableHtml = `
      <div class="table-filters">
        <input class="table-search" type="text" id="componentTableSearch" onkeyup="filterComponentTable()" placeholder="Search for components...">
        <select class="type-dropdown" id="supportFilter" onchange="filterComponentTable()">
          <option value="">All Support</option>`;

      // Extract unique support values for the filter
      const uniqueSupportValues = [...new Set(Object.values(driverSupportData).flatMap(support => support.split(', ').map(pair => pair.split('=')[1])))];
      uniqueSupportValues.forEach(support => {
        tableHtml += `<option value="${support}">${support.charAt(0).toUpperCase() + support.slice(1)}</option>`;
      });

      tableHtml += `
        </select>
        <select class="type-dropdown" id="typeFilter" onchange="filterComponentTable()">
          <option value="">All Types</option>`;

      // Extract unique types for the filter, only include input, processor, and output
      const uniqueTypes = [...new Set(flatComponentsData.flatMap(item => item.types.map(typeObj => typeObj.type)))].filter(type => ['input', 'processor', 'output'].includes(type));
      uniqueTypes.forEach(type => {
        tableHtml += `<option value="${type}">${type.charAt(0).toUpperCase() + type.slice(1)}</option>`;
      });

      tableHtml += `
        </select>
      </div>
      <table class="tableblock frame-all grid-all stripes-even no-clip stretch component-table" id="componentTable">
        <colgroup>
          <col style="width: 33.3%;">
          <col style="width: 33.3%;">
          <col style="width: 33.3%;">
        </colgroup>
        <thead>
          <tr>
            <th class="tableblock halign-left valign-top">Connector</th>
            <th class="tableblock halign-left valign-top">Support</th>
            <th class="tableblock halign-left valign-top">Type</th>
          </tr>
        </thead>
        <tbody>`;

      flatComponentsData.forEach(item => {
        const commonName = item.originalName !== item.name ? ` <small>(${item.name})</small>`: '';
        const isEnterprise = item.enterprise ? '<span class="enterprise-label" title="Requires an Enterprise Edition license">Enterprise</span>' : '';
        if (driverSupportData[item.originalName]) {
          const drivers = driverSupportData[item.originalName].split(', ');
          drivers.forEach(driverSupportPair => {
            const [driver, support] = driverSupportPair.split('=');
            // Find the common name
            const driverNameEntry = driverNameMap.find(driverItem => driverItem.key === driver)
            const driverName = driverNameEntry ? driverNameEntry.name : driver

            // Filter for types of input, processor, and output only
            const filteredTypes = item.types.filter(typeOption => ['input', 'processor', 'output'].includes(typeOption.type));
            if (filteredTypes.length > 0) {
              const typeDropdown = filteredTypes.length > 1
                ? `<select class="type-dropdown" onchange="updateComponentUrl(this, true)">
                    ${filteredTypes.map(typeOption => `<option value="${typeOption.url}">${typeOption.type.charAt(0).toUpperCase() + typeOption.type.slice(1)}</option>`).join('')}
                  </select>`
                : filteredTypes[0].type.charAt(0).toUpperCase() + filteredTypes[0].type.slice(1);

              tableHtml += `
                <tr>
                  <td class="tableblock halign-left valign-top"><p class="tableblock"><p class="enterprise-label-container">${isEnterprise}</p><code><a href="${filteredTypes[0].url}">${item.originalName}</a></code> ${commonName}<br><span style="font-size:0.9rem;">${driverName} driver</span></p></td>
                  <td class="tableblock halign-left valign-top"><p class="tableblock">${support.charAt(0).toUpperCase() + support.slice(1)}</p></td>
                  <td class="tableblock halign-left valign-top"><p class="tableblock">${typeDropdown}</p></td>
                </tr>`;
            }
          });
        } else if (cacheSupportData[item.originalName]) {
          const caches = cacheSupportData[item.originalName].split(', ');
          caches.forEach(cacheSupportPair => {
            const [cache, support] = cacheSupportPair.split('=');
            // Find the common name
            const cacheNameEntry = cacheNameMap.find(cacheItem => cacheItem.key === cache)
            const cacheName = cacheNameEntry ? cacheNameEntry.name : cache

            // Filter for types of input, processor, and output only
            const filteredTypes = item.types.filter(typeOption => ['input', 'processor', 'output'].includes(typeOption.type));
            if (filteredTypes.length > 0) {
              const typeDropdown = filteredTypes.length > 1
                ? `<select class="type-dropdown" onchange="updateComponentUrl(this, true)">
                    ${filteredTypes.map(typeOption => `<option value="${typeOption.url}">${typeOption.type.charAt(0).toUpperCase() + typeOption.type.slice(1)}</option>`).join('')}
                  </select>`
                : filteredTypes[0].type.charAt(0).toUpperCase() + filteredTypes[0].type.slice(1);

              tableHtml += `
                <tr>
                  <td class="tableblock halign-left valign-top"><p class="tableblock"><p class="enterprise-label-container">${isEnterprise}</p><code><a href="${filteredTypes[0].url}">${item.originalName}</a></code> ${commonName}<br><span style="font-size:0.9rem;">${cacheName}</span></p></td>
                  <td class="tableblock halign-left valign-top"><p class="tableblock">${support.charAt(0).toUpperCase() + support.slice(1)}</p></td>
                  <td class="tableblock halign-left valign-top"><p class="tableblock">${typeDropdown}</p></td>
                </tr>`;
            }
          });
        } else {
          // Filter for types of input, processor, and output only
          const filteredTypes = item.types.filter(typeOption => ['input', 'processor', 'output'].includes(typeOption.type));
          if (filteredTypes.length > 0) {
            const typeDropdown = filteredTypes.length > 1
              ? `<select class="type-dropdown" onchange="updateComponentUrl(this, true)">
                  ${filteredTypes.map(typeObj => `<option value="${typeObj.url}">${typeObj.type.charAt(0).toUpperCase() + typeObj.type.slice(1)}</option>`).join('')}
                </select>`
              : filteredTypes[0].type.charAt(0).toUpperCase() + filteredTypes[0].type.slice(1);

            tableHtml += `
              <tr>
                <td class="tableblock halign-left valign-top"><p class="tableblock"><p class="enterprise-label-container">${isEnterprise}</p><code><a href="${filteredTypes[0].url}">${item.originalName}</a></code> ${commonName}</p></td>
                <td class="tableblock halign-left valign-top"><p class="tableblock">${item.support.charAt(0).toUpperCase() + item.support.slice(1)}</p></td>
                <td class="tableblock halign-left valign-top"><p class="tableblock">${typeDropdown}</p></td>
              </tr>`;
          }
        }
      });

      tableHtml += `
        </tbody>
      </table>
      <script>
      function filterComponentTable() {
        const nameInput = document.getElementById('componentTableSearch').value.toLowerCase();
        const supportFilter = document.getElementById('supportFilter').value;
        const typeFilter = document.getElementById('typeFilter').value;
        const table = document.getElementById('componentTable');
        const trs = table.getElementsByTagName('tr');

        for (let i = 1; i < trs.length; i++) {
          const nameTd = trs[i].getElementsByTagName('td')[0];
          const supportTd = trs[i].getElementsByTagName('td')[1];
          const typeTd = trs[i].getElementsByTagName('td')[2];
          const typeDropdown = typeTd.querySelector('.type-dropdown');
          let showRow =
            (!nameInput || nameTd.textContent.toLowerCase().includes(nameInput)) &&
            (!supportFilter || supportTd.textContent.toLowerCase() === supportFilter.toLowerCase()) &&
            (!typeFilter || (typeDropdown ? Array.from(typeDropdown.options).some(option => option.text.toLowerCase() === typeFilter.toLowerCase()) : typeTd.textContent.toLowerCase().includes(typeFilter.toLowerCase())));

          trs[i].style.display = showRow ? '' : 'none';

          if (showRow && typeFilter && typeDropdown) {
            const matchingOption = Array.from(typeDropdown.options).find(option => option.text.toLowerCase() === typeFilter.toLowerCase());
            typeDropdown.value = matchingOption.value;
            updateComponentUrl(typeDropdown, false);
          }
        }
      }

      function getQueryParams() {
        const params = {};
        const searchParams = new URLSearchParams(window.location.search);
        searchParams.forEach((value, key) => {
          params[key] = value;
        });
        return params;
      }

      function capitalizeFirstLetter(string) {
        return string.charAt(0).toUpperCase() + string.slice(1);
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
          new Choices(dropdown, { searchEnabled: false, allowHTML: true });
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
            ${sortedTypes.map(typeObj => `<option value="${typeObj.url}" data-support="${typeObj.support}">${typeObj.type.charAt(0).toUpperCase() + typeObj.type.slice(1)}</option>`).join('')}
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
