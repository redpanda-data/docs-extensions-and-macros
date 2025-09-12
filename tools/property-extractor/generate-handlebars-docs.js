'use strict';

const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const helpers = require('./helpers');

// Register all helpers
Object.entries(helpers).forEach(([name, fn]) => {
  if (typeof fn !== 'function') {
    console.error(`❌ Helper "${name}" is not a function`);
    process.exit(1);
  }
  handlebars.registerHelper(name, fn);
});

/**
 * Configuration mapping for different property types
 */
const PROPERTY_CONFIG = {
  broker: {
    pageTitle: 'Broker Configuration Properties',
    pageAliases: ['reference:node-properties.adoc', 'reference:node-configuration-sample.adoc'],
    description: 'Reference of broker configuration properties.',
    intro: `Broker configuration properties are applied individually to each broker in a cluster. You can find and modify these properties in the \`redpanda.yaml\` configuration file.

For information on how to edit broker properties, see xref:manage:cluster-maintenance/node-property-configuration.adoc[].

NOTE: All broker properties require that you restart Redpanda for any update to take effect.`,
    sectionTitle: 'Broker configuration',
    groups: [
      {
        filter: (prop) => prop.config_scope === 'broker' && !prop.is_deprecated
      }
    ],
    filename: 'broker-properties.adoc'
  },
  cluster: {
    pageTitle: 'Cluster Configuration Properties',
    pageAliases: ['reference:tunable-properties.adoc', 'reference:cluster-properties.adoc'],
    description: 'Cluster configuration properties list.',
    intro: `Cluster configuration properties are the same for all brokers in a cluster, and are set at the cluster level.

For information on how to edit cluster properties, see xref:manage:cluster-maintenance/cluster-property-configuration.adoc[] or xref:manage:kubernetes/k-cluster-property-configuration.adoc[].

NOTE: Some cluster properties require that you restart the cluster for any updates to take effect. See the specific property details to identify whether or not a restart is required.`,
    sectionTitle: 'Cluster configuration',
    groups: [
      {
        filter: (prop) => prop.config_scope === 'cluster' && !prop.is_deprecated
      }
    ],
    filename: 'cluster-properties.adoc'
  },
  'object-storage': {
    pageTitle: 'Object Storage Properties',
    description: 'Reference of object storage properties.',
    intro: `Object storage properties are a type of cluster property. For information on how to edit cluster properties, see xref:manage:cluster-maintenance/cluster-property-configuration.adoc[].

NOTE: Some object storage properties require that you restart the cluster for any updates to take effect. See the specific property details to identify whether or not a restart is required.`,
    sectionTitle: 'Object storage configuration',
    sectionIntro: 'Object storage properties should only be set if you enable xref:manage:tiered-storage.adoc[Tiered Storage].',
    groups: [
      {
        filter: (prop) => prop.name && (
          prop.name.includes('cloud_storage') ||
          prop.name.includes('s3_') ||
          prop.name.includes('azure_') ||
          prop.name.includes('gcs_') ||
          prop.name.includes('archival_') ||
          prop.name.includes('remote_') ||
          prop.name.includes('tiered_')
        ) && !prop.is_deprecated
      }
    ],
    filename: 'object-storage-properties.adoc'
  },
  topic: {
    pageTitle: 'Topic Configuration Properties',
    pageAliases: ['reference:topic-properties.adoc'],
    description: 'Reference of topic configuration properties.',
    intro: `A topic-level property sets a Redpanda or Kafka configuration for a particular topic.\n\nMany topic-level properties have corresponding xref:manage:cluster-maintenance/cluster-property-configuration.adoc[cluster properties] that set a default value for all topics of a cluster. To customize the value for a topic, you can set a topic-level property that overrides the value of the corresponding cluster property.\n\n"
    "NOTE: All topic properties take effect immediately after being set.\n\n`,
    sectionTitle: 'Topic configuration'
  }
};

// "src/v/kafka/server/handlers/topics/types.cc": "topic"

/**
 * Gets template path, checking environment variables for custom paths first
 */
function getTemplatePath(defaultPath, envVar) {
  const customPath = process.env[envVar];
  if (customPath && fs.existsSync(customPath)) {
    console.log(`📄 Using custom template: ${customPath}`);
    return customPath;
  }
  return defaultPath;
}

/**
 * Registers Handlebars partials from template files
 */
function registerPartials() {
  const templatesDir = path.join(__dirname, 'templates');
  
  // Register property partial
  const propertyTemplatePath = getTemplatePath(
    path.join(templatesDir, 'property.hbs'),
    'TEMPLATE_PROPERTY'
  );
  const propertyTemplate = fs.readFileSync(propertyTemplatePath, 'utf8');
  handlebars.registerPartial('property', propertyTemplate);
  
  // Register deprecated property partial
  const deprecatedPropertyTemplatePath = getTemplatePath(
    path.join(templatesDir, 'deprecated-property.hbs'),
    'TEMPLATE_DEPRECATED_PROPERTY'
  );
  const deprecatedPropertyTemplate = fs.readFileSync(deprecatedPropertyTemplatePath, 'utf8');
  handlebars.registerPartial('deprecated-property', deprecatedPropertyTemplate);
}

/**
 * Generates documentation for a specific property type
 */
function generatePropertyDocs(properties, config, outputDir) {
  const templatePath = getTemplatePath(
    path.join(__dirname, 'templates', 'property-page.hbs'),
    'TEMPLATE_PROPERTY_PAGE'
  );
  const template = handlebars.compile(fs.readFileSync(templatePath, 'utf8'));

  // Filter and group properties according to configuration
  const groups = config.groups.map(group => {
    const filteredProperties = Object.values(properties)
      .filter(prop => group.filter(prop))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    return {
      title: group.title,
      intro: group.intro,
      properties: filteredProperties
    };
  }).filter(group => group.properties.length > 0);

  const data = {
    ...config,
    groups
  };

  const output = template(data);
  const outputPath = path.join(outputDir, config.filename);
  
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');
  
  console.log(`✅ Generated ${outputPath}`);
  return groups.reduce((total, group) => total + group.properties.length, 0);
}

/**
 * Generates deprecated properties documentation
 */
function generateDeprecatedDocs(properties, outputDir) {
  const templatePath = getTemplatePath(
    path.join(__dirname, 'templates', 'deprecated-properties.hbs'),
    'TEMPLATE_DEPRECATED'
  );
  const template = handlebars.compile(fs.readFileSync(templatePath, 'utf8'));

  const deprecatedProperties = Object.values(properties).filter(prop => prop.is_deprecated);
  
  const brokerProperties = deprecatedProperties
    .filter(prop => prop.config_scope === 'broker')
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    
  const clusterProperties = deprecatedProperties
    .filter(prop => prop.config_scope === 'cluster')
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  const data = {
    deprecated: deprecatedProperties.length > 0,
    brokerProperties: brokerProperties.length > 0 ? brokerProperties : null,
    clusterProperties: clusterProperties.length > 0 ? clusterProperties : null
  };

  const output = template(data);
  const outputPath = path.join(outputDir, 'deprecated', 'partials', 'deprecated-properties.adoc');
  
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');
  
  console.log(`✅ Generated ${outputPath}`);
  return deprecatedProperties.length;
}

/**
 * Main function to generate all property documentation
 */
function generateAllDocs(inputFile, outputDir) {
  // Register partials
  registerPartials();

  // Read input JSON
  const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const properties = data.properties || {};

  let totalProperties = 0;
  let totalBrokerProperties = 0;
  let totalClusterProperties = 0;
  let totalObjectStorageProperties = 0;

  // Generate each type of documentation
  for (const [type, config] of Object.entries(PROPERTY_CONFIG)) {
    const count = generatePropertyDocs(properties, config, path.join(outputDir, 'pages'));
    totalProperties += count;
    
    if (type === 'broker') totalBrokerProperties = count;
    else if (type === 'cluster') totalClusterProperties = count;
    else if (type === 'object-storage') totalObjectStorageProperties = count;
  }

  // Generate deprecated properties documentation
  const deprecatedCount = generateDeprecatedDocs(properties, path.join(outputDir, 'pages'));

  // Generate summary file
  const allPropertiesContent = Object.keys(properties).sort().join('\n');
  fs.writeFileSync(path.join(outputDir, 'all_properties.txt'), allPropertiesContent, 'utf8');

  // Generate error reports
  generateErrorReports(properties, outputDir);

  console.log(`📊 Generation Summary:`);
  console.log(`   Total properties read: ${Object.keys(properties).length}`);
  console.log(`   Total Broker properties: ${totalBrokerProperties}`);
  console.log(`   Total Cluster properties: ${totalClusterProperties}`);
  console.log(`   Total Object Storage properties: ${totalObjectStorageProperties}`);
  console.log(`   Total Deprecated properties: ${deprecatedCount}`);

  return {
    totalProperties: Object.keys(properties).length,
    brokerProperties: totalBrokerProperties,
    clusterProperties: totalClusterProperties,
    objectStorageProperties: totalObjectStorageProperties,
    deprecatedProperties: deprecatedCount
  };
}

/**
 * Generate error reports for properties with missing or invalid data
 */
function generateErrorReports(properties, outputDir) {
  const errorDir = path.join(outputDir, 'error');
  fs.mkdirSync(errorDir, { recursive: true });

  const emptyDescriptions = [];
  const deprecatedProperties = [];

  Object.values(properties).forEach(prop => {
    if (!prop.description || prop.description.trim() === '') {
      emptyDescriptions.push(prop.name);
    }
    if (prop.is_deprecated) {
      deprecatedProperties.push(prop.name);
    }
  });

  // Write error reports
  if (emptyDescriptions.length > 0) {
    fs.writeFileSync(
      path.join(errorDir, 'empty_description.txt'),
      emptyDescriptions.join('\n'),
      'utf8'
    );
    const percentage = ((emptyDescriptions.length / Object.keys(properties).length) * 100).toFixed(2);
    console.log(`You have ${emptyDescriptions.length} properties with empty description. Percentage of errors: ${percentage}%. Data written in 'empty_description.txt'.`);
  }

  if (deprecatedProperties.length > 0) {
    fs.writeFileSync(
      path.join(errorDir, 'deprecated_properties.txt'),
      deprecatedProperties.join('\n'),
      'utf8'
    );
    const percentage = ((deprecatedProperties.length / Object.keys(properties).length) * 100).toFixed(2);
    console.log(`You have ${deprecatedProperties.length} deprecated properties. Percentage of errors: ${percentage}%. Data written in 'deprecated_properties.txt'.`);
  }
}

module.exports = {
  generateAllDocs,
  generatePropertyDocs,
  generateDeprecatedDocs,
  PROPERTY_CONFIG
};

// CLI interface
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node generate-handlebars-docs.js <input-file> <output-dir>');
    process.exit(1);
  }

  const [inputFile, outputDir] = args;
  
  if (!fs.existsSync(inputFile)) {
    console.error(`❌ Input file not found: ${inputFile}`);
    process.exit(1);
  }

  try {
    generateAllDocs(inputFile, outputDir);
    console.log('✅ Documentation generation completed successfully');
  } catch (error) {
    console.error(`❌ Error generating documentation: ${error.message}`);
    process.exit(1);
  }
}
