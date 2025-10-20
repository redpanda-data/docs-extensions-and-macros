'use strict';

const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const helpers = require('./helpers');

/**
 * Handlebars documentation generator for Redpanda configuration properties.
 * 
 * Supports custom template overrides using environment variables:
 * - TEMPLATE_PROPERTY_PAGE: Main property page template
 * - TEMPLATE_PROPERTY: Individual property section template  
 * - TEMPLATE_TOPIC_PROPERTY: Individual topic property section template
 * - TEMPLATE_DEPRECATED_PROPERTY: Individual deprecated property section template
 * - TEMPLATE_DEPRECATED: Deprecated properties page template
 * 
 * CLI Usage: node generate-handlebars-docs.js <input-file> <output-dir>
 */

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
        filter: (prop) => prop.config_scope === 'cluster' && !prop.is_deprecated && !(
          prop.name && (
            prop.name.includes('cloud_storage') ||
            prop.name.includes('s3_') ||
            prop.name.includes('azure_') ||
            prop.name.includes('gcs_') ||
            prop.name.includes('archival_') ||
            prop.name.includes('remote_') ||
            prop.name.includes('tiered_')
          )
        )
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
    intro: `A topic-level property sets a Redpanda or Kafka configuration for a particular topic.

Many topic-level properties have corresponding xref:manage:cluster-maintenance/cluster-property-configuration.adoc[cluster properties] that set a default value for all topics of a cluster. To customize the value for a topic, you can set a topic-level property that overrides the value of the corresponding cluster property.

NOTE: All topic properties take effect immediately after being set.`,
    sectionTitle: 'Topic configuration',
    groups: [
      {
        filter: (prop) => prop.config_scope === 'topic' && !prop.is_deprecated,
        template: 'topic-property'
      }
    ],
    filename: 'topic-properties.adoc'
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
 * Register Handlebars partials used to render property documentation.
 *
 * Loads templates from the local templates directory (overridable via environment
 * variables handled by getTemplatePath) and registers three partials:
 *  - "property" (uses cloud-aware `property-cloud.hbs` when enabled)
 *  - "topic-property" (uses cloud-aware `topic-property-cloud.hbs` when enabled)
 *  - "deprecated-property"
 *
 * @param {boolean} [hasCloudSupport=false] - If true, select cloud-aware templates for the `property` and `topic-property` partials.
 * @throws {Error} If any required template file is missing or cannot be read; errors are rethrown after logging.
 */
function registerPartials(hasCloudSupport = false) {
  const templatesDir = path.join(__dirname, 'templates');
  
  try {
    console.log(`📝 Registering Handlebars templates (cloud support: ${hasCloudSupport ? 'enabled' : 'disabled'})`);
    
    // Register property partial (choose cloud or regular version)
    const propertyTemplateFile = hasCloudSupport ? 'property-cloud.hbs' : 'property.hbs';
    const propertyTemplatePath = getTemplatePath(
      path.join(templatesDir, propertyTemplateFile),
      'TEMPLATE_PROPERTY'
    );
    
    if (!fs.existsSync(propertyTemplatePath)) {
      throw new Error(`Property template not found: ${propertyTemplatePath}`);
    }
    
    const propertyTemplate = fs.readFileSync(propertyTemplatePath, 'utf8');
    handlebars.registerPartial('property', propertyTemplate);
    console.log(`✅ Registered property template: ${propertyTemplateFile}`);
    
    // Register topic property partial (choose cloud or regular version)
    const topicPropertyTemplateFile = hasCloudSupport ? 'topic-property-cloud.hbs' : 'topic-property.hbs';
    const topicPropertyTemplatePath = getTemplatePath(
      path.join(templatesDir, topicPropertyTemplateFile),
      'TEMPLATE_TOPIC_PROPERTY'
    );
    
    if (!fs.existsSync(topicPropertyTemplatePath)) {
      throw new Error(`Topic property template not found: ${topicPropertyTemplatePath}`);
    }
    
    const topicPropertyTemplate = fs.readFileSync(topicPropertyTemplatePath, 'utf8');
    handlebars.registerPartial('topic-property', topicPropertyTemplate);
    console.log(`✅ Registered topic property template: ${topicPropertyTemplateFile}`);
    
    // Register deprecated property partial
    const deprecatedPropertyTemplatePath = getTemplatePath(
      path.join(templatesDir, 'deprecated-property.hbs'),
      'TEMPLATE_DEPRECATED_PROPERTY'
    );
    
    if (!fs.existsSync(deprecatedPropertyTemplatePath)) {
      throw new Error(`Deprecated property template not found: ${deprecatedPropertyTemplatePath}`);
    }
    
    const deprecatedPropertyTemplate = fs.readFileSync(deprecatedPropertyTemplatePath, 'utf8');
    handlebars.registerPartial('deprecated-property', deprecatedPropertyTemplate);
    console.log(`✅ Registered deprecated property template`);
    
  } catch (error) {
    console.error('❌ Failed to register Handlebars templates:');
    console.error(`   Error: ${error.message}`);
    console.error('   This indicates missing or corrupted template files.');
    console.error('   Check that all .hbs files exist in tools/property-extractor/templates/');
    throw error;
  }
}

/**
 * Generates documentation for a specific property type
 */
function generatePropertyDocs(properties, config, outputDir) {
  // Check if partials are being generated to determine which template to use
  const useIncludes = process.env.GENERATE_PARTIALS === '1';
  
  let templatePath;
  if (useIncludes) {
    // Use the include-based template when partials are also being generated
    templatePath = getTemplatePath(
      path.join(__dirname, 'templates', 'property-page-with-includes.hbs'),
      'TEMPLATE_PROPERTY_PAGE_WITH_INCLUDES'
    );
  } else {
    // Use the standard template for full content
    templatePath = getTemplatePath(
      path.join(__dirname, 'templates', 'property-page.hbs'),
      'TEMPLATE_PROPERTY_PAGE'
    );
  }
  
  const template = handlebars.compile(fs.readFileSync(templatePath, 'utf8'));

  if (useIncludes) {
    // For include-based pages, we need minimal data - just page metadata and filename for include
    const data = {
      ...config,
      filename: config.filename.replace('.adoc', '') // Remove .adoc extension for include
    };

    const output = template(data);
    const outputPath = path.join(outputDir, config.filename);
    
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output, 'utf8');
    
    console.log(`✅ Generated include-based page ${outputPath}`);
    
    // Count properties for this type
    const typeCount = Object.values(properties).filter(prop => {
      return config.groups.some(group => group.filter(prop));
    }).length;
    
    return typeCount;
  } else {
    // Filter and group properties according to configuration
    const groups = config.groups.map(group => {
      const filteredProperties = Object.values(properties)
        .filter(prop => group.filter(prop))
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

      return {
        title: group.title,
        intro: group.intro,
        properties: filteredProperties,
        template: group.template || 'property' // Default to 'property' template
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
    
    console.log(`✅ Generated full content page ${outputPath}`);
    return groups.reduce((total, group) => total + group.properties.length, 0);
  }
}

/**
 * Generate consolidated AsciiDoc partials for properties grouped by type.
 *
 * Creates separate .adoc files for each property type (cluster-properties.adoc, 
 * topic-properties.adoc, object-storage-properties.adoc, broker-properties.adoc) 
 * containing all properties of that type using the appropriate templates.
 *
 * @param {Object} properties - Map of properties (property name → property object).
 * @param {string} partialsDir - Directory where consolidated property files will be written.
 * @param {boolean} [hasCloudSupport=false] - If true, use cloud-aware templates.
 * @returns {number} The total number of properties included in the consolidated partials.
 */
function generatePropertyPartials(properties, partialsDir, hasCloudSupport = false) {
  console.log(`📝 Generating consolidated property partials in ${partialsDir}…`);
  
  // Use the appropriate template based on cloud support
  const templateName = hasCloudSupport ? 'property-cloud' : 'property';
  const templatePath = getTemplatePath(
    path.join(__dirname, 'templates', `${templateName}.hbs`),
    'TEMPLATE_PROPERTY'
  );
  const template = handlebars.compile(fs.readFileSync(templatePath, 'utf8'));

  // Use the topic property template for topic properties
  const topicTemplateName = hasCloudSupport ? 'topic-property-cloud' : 'topic-property';
  const topicTemplatePath = getTemplatePath(
    path.join(__dirname, 'templates', `${topicTemplateName}.hbs`),
    'TEMPLATE_TOPIC_PROPERTY'
  );
  const topicTemplate = handlebars.compile(fs.readFileSync(topicTemplatePath, 'utf8'));

  // Create the main partials directory
  const propertiesPartialsDir = path.join(partialsDir, 'properties');
  fs.mkdirSync(propertiesPartialsDir, { recursive: true });
  
  // Group properties by type
  const propertyGroups = {
    cluster: [],
    topic: [],
    broker: [],
    'object-storage': []
  };

  // Categorize properties
  Object.values(properties).forEach(prop => {
    if (!prop.name || !prop.config_scope) return; // Skip properties without names or scope
    
    if (prop.config_scope === 'topic') {
      propertyGroups.topic.push(prop);
    } else if (prop.config_scope === 'broker') {
      propertyGroups.broker.push(prop);
    } else if (prop.config_scope === 'cluster') {
      // Check if it's an object storage property
      if (prop.name && (
        prop.name.includes('cloud_storage') ||
        prop.name.includes('s3_') ||
        prop.name.includes('azure_') ||
        prop.name.includes('gcs_') ||
        prop.name.includes('archival_') ||
        prop.name.includes('remote_') ||
        prop.name.includes('tiered_')
      )) {
        propertyGroups['object-storage'].push(prop);
      } else {
        propertyGroups.cluster.push(prop);
      }
    }
  });

  let totalCount = 0;
  
  // Generate consolidated partials for each property type
  Object.entries(propertyGroups).forEach(([type, props]) => {
    if (props.length === 0) return;
    
    // Sort properties by name
    props.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    
    // Choose the appropriate template based on property type
    const selectedTemplate = type === 'topic' ? topicTemplate : template;
    
    // Generate content for all properties of this type
    const content = props.map(prop => selectedTemplate(prop)).join('\n');
    
    // Write the consolidated file
    const filename = `${type}-properties.adoc`;
    const outputPath = path.join(propertiesPartialsDir, filename);
    fs.writeFileSync(outputPath, content, 'utf8');
    
    console.log(`✅ Generated ${outputPath} with ${props.length} properties`);
    totalCount += props.length;
  });
  
  console.log(`✅ Generated consolidated property partials in ${partialsDir} (${totalCount} total properties)`);
  return totalCount;
}

/**
 * Generate an AsciiDoc fragment listing deprecated properties and write it to disk.
 *
 * Scans the provided properties map for entries with `is_deprecated === true`, groups
 * them by `config_scope` ("broker" and "cluster"), sorts each group by property name,
 * renders the `deprecated-properties` Handlebars template, and writes the output to
 * `<outputDir>/deprecated/partials/deprecated-properties.adoc`.
 *
 * @param {Object.<string, Object>} properties - Map of property objects keyed by property name.
 *   Each property object may contain `is_deprecated`, `config_scope`, and `name` fields.
 * @param {string} outputDir - Destination directory where the deprecated fragment will be written.
 * @returns {number} The total number of deprecated properties found and written.
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
  
  // Determine the correct path for deprecated properties
  let outputPath;
  if (outputDir.includes('pages/properties')) {
    // Navigate back from pages/properties to reference, then into partials/deprecated
    outputPath = path.join(path.dirname(path.dirname(outputDir)), 'partials', 'deprecated', 'deprecated-properties.adoc');
  } else {
    // Direct path when outputDir is the base directory
    outputPath = path.join(outputDir, 'partials', 'deprecated', 'deprecated-properties.adoc');
  }
  
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output, 'utf8');
  
  console.log(`✅ Generated ${outputPath}`);
  return deprecatedProperties.length;
}

/**
 * Determine whether any property includes cloud support metadata.
 *
 * Checks the provided map of properties and returns true if at least one
 * property object has a `cloud_supported` own property (regardless of its value).
 *
 * @param {Object<string, Object>} properties - Map from property name to its metadata object.
 * @return {boolean} True if any property has a `cloud_supported` attribute; otherwise false.
 */
function hasCloudSupportMetadata(properties) {
  return Object.values(properties).some(prop => 
    Object.prototype.hasOwnProperty.call(prop, 'cloud_supported')
  );
}

/**
 * Generate all property documentation and write output files to disk.
 *
 * Reads properties from the provided JSON file, detects whether any property
 * includes cloud support metadata to select cloud-aware templates, registers
 * Handlebars partials accordingly, renders per-type property pages and a
 * deprecated-properties partial, writes a flat list of all property names, and
 * produces error reports.
 *
 * Generated artifacts are written under the given output directory (e.g.:
 * pages/<type>/*.adoc, pages/deprecated/partials/deprecated-properties.adoc,
 * all_properties.txt, and files under outputDir/error).
 *
 * @param {string} inputFile - Filesystem path to the input JSON containing a top-level `properties` object.
 * @param {string} outputDir - Destination directory where generated pages and reports will be written.
 * @returns {{totalProperties: number, brokerProperties: number, clusterProperties: number, objectStorageProperties: number, topicProperties: number, deprecatedProperties: number}} Summary counts for all properties and per-type totals.
 */
function generateAllDocs(inputFile, outputDir) {
  // Read input JSON
  const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const properties = data.properties || {};

  // Check if cloud support is enabled
  const hasCloudSupport = hasCloudSupportMetadata(properties);
  if (hasCloudSupport) {
    console.log('🌤️ Cloud support metadata detected, using cloud-aware templates');
  }

  // Register partials with cloud support detection
  registerPartials(hasCloudSupport);

  let totalProperties = 0;
  let totalBrokerProperties = 0;
  let totalClusterProperties = 0;
  let totalObjectStorageProperties = 0;
  let totalTopicProperties = 0;

  // Generate complete property pages only if requested
  if (process.env.GENERATE_PAGES === '1') {
    console.log(`📄 Generating complete property pages...`);
    
    // Generate each type of documentation
    for (const [type, config] of Object.entries(PROPERTY_CONFIG)) {
      const count = generatePropertyDocs(properties, config, outputDir);
      totalProperties += count;
      
      if (type === 'broker') totalBrokerProperties = count;
      else if (type === 'cluster') totalClusterProperties = count;
      else if (type === 'object-storage') totalObjectStorageProperties = count;
      else if (type === 'topic') totalTopicProperties = count;
    }
  } else {
    console.log(`📄 Skipping complete property pages (use --generate-pages to enable)`);
    
    // Still count properties for summary
    Object.values(properties).forEach(prop => {
      if (prop.config_scope === 'broker' && !prop.is_deprecated) totalBrokerProperties++;
      else if (prop.config_scope === 'cluster' && !prop.is_deprecated) {
        if (prop.name && (
          prop.name.includes('cloud_storage') ||
          prop.name.includes('s3_') ||
          prop.name.includes('azure_') ||
          prop.name.includes('gcs_') ||
          prop.name.includes('archival_') ||
          prop.name.includes('remote_') ||
          prop.name.includes('tiered_')
        )) {
          totalObjectStorageProperties++;
        } else {
          totalClusterProperties++;
        }
      }
      else if (prop.config_scope === 'topic' && !prop.is_deprecated) totalTopicProperties++;
    });
    totalProperties = totalBrokerProperties + totalClusterProperties + totalObjectStorageProperties + totalTopicProperties;
  }

  // Generate individual property partials if requested
  let partialsCount = 0;
  let deprecatedCount = 0;
  if (process.env.GENERATE_PARTIALS === '1' && process.env.OUTPUT_PARTIALS_DIR) {
    // Generate deprecated properties documentation
    deprecatedCount = generateDeprecatedDocs(properties, outputDir);
    
    partialsCount = generatePropertyPartials(properties, process.env.OUTPUT_PARTIALS_DIR, hasCloudSupport);
  } else {
    console.log(`📄 Skipping property partials (use --generate-partials to enable)`);
    console.log(`📄 Skipping deprecated properties documentation (use --generate-partials to enable)`);
  }

  // Generate error reports and add to input JSON output
  const errorReport = generateErrorReports(properties, outputDir);

  // Add error arrays directly to the input file so they're included when copied
  const inputData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  inputData.empty_descriptions = errorReport.empty_descriptions;
  inputData.deprecated_properties = errorReport.deprecated_properties;
  fs.writeFileSync(inputFile, JSON.stringify(inputData, null, 2), 'utf8');
  console.log(`📝 Added error arrays to ${inputFile}`);

  console.log(`📊 Generation Summary:`);
  console.log(`   Total properties read: ${Object.keys(properties).length}`);
  console.log(`   Total Broker properties: ${totalBrokerProperties}`);
  console.log(`   Total Cluster properties: ${totalClusterProperties}`);
  console.log(`   Total Object Storage properties: ${totalObjectStorageProperties}`);
  console.log(`   Total Topic properties: ${totalTopicProperties}`);
  console.log(`   Total Deprecated properties: ${deprecatedCount}`);
  if (partialsCount > 0) {
    console.log(`   Total Property partials: ${partialsCount}`);
  }

  return {
    totalProperties: Object.keys(properties).length,
    brokerProperties: totalBrokerProperties,
    clusterProperties: totalClusterProperties,
    objectStorageProperties: totalObjectStorageProperties,
    topicProperties: totalTopicProperties,
    deprecatedProperties: deprecatedCount,
    propertyPartials: partialsCount
  };
}

/**
 * Generate error reports for properties with missing or invalid data
 */
function generateErrorReports(properties, outputDir) {
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

  // Add these arrays to the properties JSON file
  const totalProperties = Object.keys(properties).length;
  const percentageEmpty = totalProperties > 0 ? ((emptyDescriptions.length / totalProperties) * 100).toFixed(2) : '0.00';
  const percentageDeprecated = totalProperties > 0 ? ((deprecatedProperties.length / totalProperties) * 100).toFixed(2) : '0.00';
  console.log(`You have ${emptyDescriptions.length} properties with empty description. Percentage of errors: ${percentageEmpty}%.`);
  console.log(`You have ${deprecatedProperties.length} deprecated properties. Percentage of errors: ${percentageDeprecated}%.`);

  // Return the arrays so they can be added to the JSON output
  return {
    empty_descriptions: emptyDescriptions,
    deprecated_properties: deprecatedProperties
  };
}

module.exports = {
  generateAllDocs,
  generatePropertyDocs,
  generateDeprecatedDocs,
  generatePropertyPartials,
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
