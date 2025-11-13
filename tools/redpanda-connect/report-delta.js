const { execSync } = require('child_process');

/**
 * Generate a JSON diff report between two connector index objects.
 * @param {object} oldIndex - Previous version connector index
 * @param {object} newIndex - Current version connector index
 * @param {object} opts - { oldVersion, newVersion, timestamp }
 * @returns {object} JSON diff report
 */
function generateConnectorDiffJson(oldIndex, newIndex, opts = {}) {
  const oldMap = buildComponentMap(oldIndex);
  const newMap = buildComponentMap(newIndex);

  // New components
  const newComponentKeys = Object.keys(newMap).filter(k => !(k in oldMap));
  const newComponents = newComponentKeys.map(key => {
    const [type, name] = key.split(':');
    const raw = newMap[key].raw;
    return {
      name,
      type,
      status: raw.status || raw.type || '',
      version: raw.version || raw.introducedInVersion || '',
      description: raw.description || ''
    };
  });

  // Removed components
  const removedComponentKeys = Object.keys(oldMap).filter(k => !(k in newMap));
  const removedComponents = removedComponentKeys.map(key => {
    const [type, name] = key.split(':');
    const raw = oldMap[key].raw;
    return {
      name,
      type,
      status: raw.status || raw.type || '',
      version: raw.version || raw.introducedInVersion || '',
      description: raw.description || ''
    };
  });

  // New fields under existing components
  const newFields = [];
  Object.keys(newMap).forEach(cKey => {
    if (!(cKey in oldMap)) return;
    const oldFields = new Set(oldMap[cKey].fields || []);
    const newFieldsArr = newMap[cKey].fields || [];
    newFieldsArr.forEach(fName => {
      if (!oldFields.has(fName)) {
        const [type, compName] = cKey.split(':');
        let rawFieldObj = null;
        if (type === 'config') {
          rawFieldObj = (newMap[cKey].raw.children || []).find(f => f.name === fName);
        } else {
          rawFieldObj = (newMap[cKey].raw.config?.children || []).find(f => f.name === fName);
        }
        newFields.push({
          component: cKey,
          field: fName,
          introducedIn: rawFieldObj && (rawFieldObj.introducedInVersion || rawFieldObj.version),
          description: rawFieldObj && rawFieldObj.description
        });
      }
    });
  });

  // Removed fields under existing components
  const removedFields = [];
  Object.keys(oldMap).forEach(cKey => {
    if (!(cKey in newMap)) return;
    const newFieldsSet = new Set(newMap[cKey].fields || []);
    const oldFieldsArr = oldMap[cKey].fields || [];
    oldFieldsArr.forEach(fName => {
      if (!newFieldsSet.has(fName)) {
        removedFields.push({
          component: cKey,
          field: fName
        });
      }
    });
  });

  // Newly deprecated components (exist in both versions but became deprecated)
  const deprecatedComponents = [];
  Object.keys(newMap).forEach(cKey => {
    if (!(cKey in oldMap)) return;
    const oldStatus = (oldMap[cKey].raw.status || '').toLowerCase();
    const newStatus = (newMap[cKey].raw.status || '').toLowerCase();
    if (oldStatus !== 'deprecated' && newStatus === 'deprecated') {
      const [type, name] = cKey.split(':');
      const raw = newMap[cKey].raw;
      deprecatedComponents.push({
        name,
        type,
        status: raw.status || raw.type || '',
        version: raw.version || raw.introducedInVersion || '',
        description: raw.description || ''
      });
    }
  });

  // Newly deprecated fields (exist in both versions but became deprecated)
  const deprecatedFields = [];
  Object.keys(newMap).forEach(cKey => {
    if (!(cKey in oldMap)) return;
    const oldFieldsArr = oldMap[cKey].fields || [];
    const newFieldsArr = newMap[cKey].fields || [];

    // Check fields that exist in both versions
    const commonFields = oldFieldsArr.filter(f => newFieldsArr.includes(f));
    commonFields.forEach(fName => {
      const [type, compName] = cKey.split(':');

      // Get old field object
      let oldFieldObj = null;
      if (type === 'config') {
        oldFieldObj = (oldMap[cKey].raw.children || []).find(f => f.name === fName);
      } else {
        oldFieldObj = (oldMap[cKey].raw.config?.children || []).find(f => f.name === fName);
      }

      // Get new field object
      let newFieldObj = null;
      if (type === 'config') {
        newFieldObj = (newMap[cKey].raw.children || []).find(f => f.name === fName);
      } else {
        newFieldObj = (newMap[cKey].raw.config?.children || []).find(f => f.name === fName);
      }

      const oldDeprecated = oldFieldObj && (oldFieldObj.is_deprecated === true || oldFieldObj.deprecated === true || (oldFieldObj.status || '').toLowerCase() === 'deprecated');
      const newDeprecated = newFieldObj && (newFieldObj.is_deprecated === true || newFieldObj.deprecated === true || (newFieldObj.status || '').toLowerCase() === 'deprecated');

      if (!oldDeprecated && newDeprecated) {
        deprecatedFields.push({
          component: cKey,
          field: fName,
          description: newFieldObj && newFieldObj.description
        });
      }
    });
  });

  return {
    comparison: {
      oldVersion: opts.oldVersion || '',
      newVersion: opts.newVersion || '',
      timestamp: opts.timestamp || new Date().toISOString()
    },
    summary: {
      newComponents: newComponents.length,
      removedComponents: removedComponents.length,
      newFields: newFields.length,
      removedFields: removedFields.length,
      deprecatedComponents: deprecatedComponents.length,
      deprecatedFields: deprecatedFields.length
    },
    details: {
      newComponents,
      removedComponents,
      newFields,
      removedFields,
      deprecatedComponents,
      deprecatedFields
    }
  };
}

function discoverComponentKeys(obj) {
  return Object.keys(obj).filter(key => Array.isArray(obj[key]));
}

function buildComponentMap(indexObj) {
  const map = {};
  const types = discoverComponentKeys(indexObj);

  types.forEach(type => {
    (indexObj[type] || []).forEach(component => {
      const name = component.name;
      if (!name) return;

      const lookupKey = `${type}:${name}`;
      let childArray = [];

      if (type === 'config') {
        if (Array.isArray(component.children)) {
          childArray = component.children;
        }
      } else {
        if (component.config && Array.isArray(component.config.children)) {
          childArray = component.config.children;
        }
      }

      const fieldNames = childArray.map(f => f.name);
      map[lookupKey] = { raw: component, fields: fieldNames };
    });
  });

  return map;
}

function getRpkConnectVersion() {
  try {
    // Make sure the connect plugin is upgraded first (silent)
    execSync('rpk connect upgrade', { stdio: 'ignore' });

    // Now capture the --version output
    const raw = execSync('rpk connect --version', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();

    // raw looks like:
    //   Version: 4.53.0
    //   Date:    2025-04-18T17:49:53Z
    // We want to extract “4.53.0”
    const match = raw.match(/^Version:\s*(.+)$/m);
    if (!match) {
      throw new Error(`Unexpected format from "rpk connect --version":\n${raw}`);
    }
    return match[1];
  } catch (err) {
    throw new Error(`Unable to run "rpk connect --version": ${err.message}`);
  }
}

/**
 * Given two “index objects” (parsed from connect.json), produce a console summary of:
 *  • which connectors/components are brand-new
 *  • which new fields appeared under existing connectors (including “config” entries)
 *  • for each new component/field, if the raw object contains “version” or “introducedInVersion” or “requiresVersion” metadata, print it
 */
function printDeltaReport(oldIndex, newIndex) {
  const oldMap = buildComponentMap(oldIndex);
  const newMap = buildComponentMap(newIndex);

  // 1) brand-new components
  const newComponentKeys = Object.keys(newMap).filter(k => !(k in oldMap));

  // 2) brand-new fields under shared components
  const newFields = [];
  Object.keys(newMap).forEach(cKey => {
    if (!(cKey in oldMap)) return; // skip brand-new components here
    const oldFields = new Set(oldMap[cKey].fields || []);
    const newFieldsArr = newMap[cKey].fields || [];
    newFieldsArr.forEach(fName => {
      if (!oldFields.has(fName)) {
        // fetch raw field metadata if available
        const [type, compName] = cKey.split(':');
        let rawFieldObj = null;
        if (type === 'config') {
          rawFieldObj = (newMap[cKey].raw.children || []).find(f => f.name === fName);
        } else {
          rawFieldObj = (newMap[cKey].raw.config?.children || []).find(f => f.name === fName);
        }

        let introducedIn = rawFieldObj && (rawFieldObj.introducedInVersion || rawFieldObj.version);
        let requiresVer = rawFieldObj && rawFieldObj.requiresVersion;

        newFields.push({
          component: cKey,
          field: fName,
          introducedIn,
          requiresVersion: requiresVer,
        });
      }
    });
  });

  // Newly deprecated components
  const deprecatedComponentKeys = [];
  Object.keys(newMap).forEach(cKey => {
    if (!(cKey in oldMap)) return;
    const oldStatus = (oldMap[cKey].raw.status || '').toLowerCase();
    const newStatus = (newMap[cKey].raw.status || '').toLowerCase();
    if (oldStatus !== 'deprecated' && newStatus === 'deprecated') {
      deprecatedComponentKeys.push(cKey);
    }
  });

  // Newly deprecated fields
  const deprecatedFieldsList = [];
  Object.keys(newMap).forEach(cKey => {
    if (!(cKey in oldMap)) return;
    const oldFieldsArr = oldMap[cKey].fields || [];
    const newFieldsArr = newMap[cKey].fields || [];
    const commonFields = oldFieldsArr.filter(f => newFieldsArr.includes(f));

    commonFields.forEach(fName => {
      const [type, compName] = cKey.split(':');
      let oldFieldObj = null;
      if (type === 'config') {
        oldFieldObj = (oldMap[cKey].raw.children || []).find(f => f.name === fName);
      } else {
        oldFieldObj = (oldMap[cKey].raw.config?.children || []).find(f => f.name === fName);
      }
      let newFieldObj = null;
      if (type === 'config') {
        newFieldObj = (newMap[cKey].raw.children || []).find(f => f.name === fName);
      } else {
        newFieldObj = (newMap[cKey].raw.config?.children || []).find(f => f.name === fName);
      }
      const oldDeprecated = oldFieldObj && (oldFieldObj.is_deprecated === true || oldFieldObj.deprecated === true || (oldFieldObj.status || '').toLowerCase() === 'deprecated');
      const newDeprecated = newFieldObj && (newFieldObj.is_deprecated === true || newFieldObj.deprecated === true || (newFieldObj.status || '').toLowerCase() === 'deprecated');
      if (!oldDeprecated && newDeprecated) {
        deprecatedFieldsList.push({ component: cKey, field: fName });
      }
    });
  });

  console.log('\n📋 RPCN Connector Delta Report\n');

  if (newComponentKeys.length) {
    console.log('➤ Newly added components:');
    newComponentKeys.forEach(key => {
      const [type, name] = key.split(':');
      const raw = newMap[key].raw;
      const status = raw.status || raw.type || '';
      const version = raw.version || raw.introducedInVersion || '';
      console.log(
        `   • ${type}/${name}${
          status ? ` (${status})` : ''
        }${version ? ` — introduced in ${version}` : ''}`
      );
    });
    console.log('');
  } else {
    console.log('➤ No newly added components.\n');
  }

  if (newFields.length) {
    console.log('➤ Newly added fields:');
    newFields.forEach(entry => {
      const { component, field, introducedIn, requiresVersion } = entry;
      process.stdout.write(`   • ${component} → ${field}`);
      if (introducedIn) process.stdout.write(` (introducedIn: ${introducedIn})`);
      if (requiresVersion) process.stdout.write(` (requiresVersion: ${requiresVersion})`);
      console.log('');
    });
    console.log('');
  } else {
    console.log('➤ No newly added fields.\n');
  }

  if (deprecatedComponentKeys.length) {
    console.log('➤ Newly deprecated components:');
    deprecatedComponentKeys.forEach(key => {
      const [type, name] = key.split(':');
      const raw = newMap[key].raw;
      console.log(`   • ${type}/${name}`);
    });
    console.log('');
  } else {
    console.log('➤ No newly deprecated components.\n');
  }

  if (deprecatedFieldsList.length) {
    console.log('➤ Newly deprecated fields:');
    deprecatedFieldsList.forEach(entry => {
      const { component, field } = entry;
      console.log(`   • ${component} → ${field}`);
    });
    console.log('');
  } else {
    console.log('➤ No newly deprecated fields.\n');
  }
}

module.exports = {
  discoverComponentKeys,
  buildComponentMap,
  getRpkConnectVersion,
  printDeltaReport,
  generateConnectorDiffJson,
};
