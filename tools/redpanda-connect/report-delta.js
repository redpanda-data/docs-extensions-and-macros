// tools/redpanda-connect/report-delta.js
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { execSync } = require('child_process');

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
}

module.exports = {
  discoverComponentKeys,
  buildComponentMap,
  getRpkConnectVersion,
  printDeltaReport,
};
