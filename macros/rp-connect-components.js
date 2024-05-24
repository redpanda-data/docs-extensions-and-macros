'use strict';

module.exports.register = function (registry, context) {
  let tabsCounter = 1; // Counter for generating unique IDs

  // Add the category tabs for components
  registry.blockMacro(function () {
    const self = this;
    self.named('componentsbycategory');
    self.positionalAttributes(['type']);
    self.process((parent, target, attrs) => {
      const type = attrs.type;
      const categoriesData = context.config?.attributes?.connectCategoriesData || {}
      const categories = categoriesData[type] || {};
      const currentTabsId = `tabs-${tabsCounter++}`; // Unique ID for this set of tabs

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
    self.named('componenttable');
    self.process((parent, target, attrs) => {
      const flatComponentsData = context.config?.attributes?.flatComponentsData || []

      // Sort flatComponentsData alphabetically by name
      flatComponentsData.sort((a, b) => a.name.localeCompare(b.name));

      let tableHtml = `
  <div class="table-filters">
  <input class="table-search" type="text" id="componentTableSearch" onkeyup="filterComponentTable()" placeholder="Search for components...">
  <select class="type-dropdown" id="supportFilter" onchange="filterComponentTable()">
    <option value="">All Support</option>`;

      // Extract unique support values for the filter
      const uniqueSupportValues = [...new Set(flatComponentsData.map(item => item.support))];
      uniqueSupportValues.forEach(support => {
        tableHtml += `<option value="${support}">${support}</option>`;
      });

      tableHtml += `
  </select>
  <select class="type-dropdown" id="typeFilter" onchange="filterComponentTable()">
    <option value="">All Types</option>`;

      // Extract unique types for the filter
      const uniqueTypes = [...new Set(flatComponentsData.flatMap(item => item.types.map(typeObj => typeObj.type)))];
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
        const typeDropdown = item.types.length > 1
          ? `<select class="type-dropdown" onchange="updateComponentUrl(this, true)">
              ${item.types.map(typeObj => `<option value="${typeObj.url}">${typeObj.type.charAt(0).toUpperCase() + typeObj.type.slice(1)}</option>`).join('')}
            </select>`
          : item.types[0].type;

        tableHtml += `
    <tr>
      <td class="tableblock halign-left valign-top"><p class="tableblock"><a href="${item.types[0].url}">${item.name}</a></p></td>
      <td class="tableblock halign-left valign-top"><p class="tableblock">${item.support}</p></td>
      <td class="tableblock halign-left valign-top"><p class="tableblock">${typeDropdown}</p></td>
    </tr>`;
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
      (!supportFilter || supportTd.textContent === supportFilter) &&
      (!typeFilter || (typeDropdown ? Array.from(typeDropdown.options).some(option => option.text.toLowerCase() === typeFilter.toLowerCase()) : typeTd.textContent.toLowerCase().includes(typeFilter.toLowerCase())));

    trs[i].style.display = showRow ? '' : 'none';

    if (showRow && typeFilter && typeDropdown) {
      const matchingOption = Array.from(typeDropdown.options).find(option => option.text.toLowerCase() === typeFilter.toLowerCase());
      typeDropdown.value = matchingOption.value;
      updateComponentUrl(typeDropdown, false);
    }
  }
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
  const typeDropdowns = document.querySelectorAll('.type-dropdown');
  typeDropdowns.forEach(dropdown => {
    new Choices(dropdown, { searchEnabled: false,  allowHTML: true});
  });
  });
  </script>`;

      return self.createBlock(parent, 'pass', tableHtml);
    });
  });
  // Add the block macro for displaying a dropdown of other supported types
  registry.blockMacro(function () {
    const self = this;
    self.named('componenttypedropdown');
    self.process((parent, target, attrs) => {
      const attributes = parent.getDocument().getAttributes();
      const name = attributes['doctitle'];
      const type = attributes['type'];

      if (!name || !type) {
        console.log('Name or type attribute is missing');
        return self.createBlock(parent, 'pass', '');
      }

      const flatComponentsData = context.config?.attributes?.flatComponentsData || []
      const component = flatComponentsData.find(item => item.originalName === name);

      if (!component || component.types.length <= 1) {
        return self.createBlock(parent, 'pass', '');
      }

      // Move the page's current type to the first position in the dropdown
      const sortedTypes = [...component.types];
      const currentTypeIndex = sortedTypes.findIndex(typeObj => typeObj.type === type);
      if (currentTypeIndex !== -1) {
        const [currentType] = sortedTypes.splice(currentTypeIndex, 1);
        sortedTypes.unshift(currentType);
      }

      const typeDropdown = `
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

      return self.createBlock(parent, 'pass', typeDropdown);
    });
  });
};
