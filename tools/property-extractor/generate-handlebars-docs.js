'use strict';

const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const helpers = require('./helpers');

/**
 * Handlebars documentation generator for Redpanda configuration properties.
 *
 * Supports custom template overrides using environment variables:
 * - TEMPLATE_PROPERTY: Individual property section template
 * - TEMPLATE_TOPIC_PROPERTY: Individual topic property section template
 * - TEMPLATE_DEPRECATED_PROPERTY: Individual deprecated property section template
 * - TEMPLATE_DEPRECATED: Deprecated properties page template
 *
 * Behavior flags (environment variables):
 * - GENERATE_PARTIALS=1      Generate consolidated property partials and deprecated partials
 * - OUTPUT_PARTIALS_DIR=<p>  Destination for consolidated partials (required if GENERATE_PARTIALS=1)
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
 * Determines if a property is related to object storage.
 * @param {Object} prop - The property object
 * @returns {boolean} True if the property is object storage related
 */
function isObjectStorageProperty(prop) {
  return prop.name && (
    prop.name.includes('cloud_storage') ||
    prop.name.includes('s3_') ||
    prop.name.includes('azure_') ||
    prop.name.includes('gcs_') ||
    prop.name.includes('archival_') ||
    prop.name.includes('remote_') ||
    prop.name.includes('tiered_')
  );
}

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
 * Registers:
 *  - "property"
 *  - "topic-property"
 *  - "deprecated-property"
 */
function registerPartials() {
  const templatesDir = path.join(__dirname, 'templates');

  try {
    console.log('📝 Registering Handlebars templates');

    const propertyTemplatePath = getTemplatePath(
      path.join(templatesDir, 'property.hbs'),
      'TEMPLATE_PROPERTY'
    );
    if (!fs.existsSync(propertyTemplatePath)) {
      throw new Error(`Property template not found: ${propertyTemplatePath}`);
    }
    handlebars.registerPartial('property', fs.readFileSync(propertyTemplatePath, 'utf8'));

    const topicPropertyTemplatePath = getTemplatePath(
      path.join(templatesDir, 'topic-property.hbs'),
      'TEMPLATE_TOPIC_PROPERTY'
    );
    if (!fs.existsSync(topicPropertyTemplatePath)) {
      throw new Error(`Topic property template not found: ${topicPropertyTemplatePath}`);
    }
    handlebars.registerPartial('topic-property', fs.readFileSync(topicPropertyTemplatePath, 'utf8'));

    const deprecatedPropertyTemplatePath = getTemplatePath(
      path.join(templatesDir, 'deprecated-property.hbs'),
      'TEMPLATE_DEPRECATED_PROPERTY'
    );
    if (!fs.existsSync(deprecatedPropertyTemplatePath)) {
      throw new Error(`Deprecated property template not found: ${deprecatedPropertyTemplatePath}`);
    }
    handlebars.registerPartial('deprecated-property', fs.readFileSync(deprecatedPropertyTemplatePath, 'utf8'));

    console.log('✅ Registered all partials');
  } catch (error) {
    console.error('❌ Failed to register Handlebars templates:');
    console.error(`   ${error.message}`);
    throw error;
  }
}

/**
 * Generate consolidated AsciiDoc partials for properties grouped by type.
 */
function generatePropertyPartials(properties, partialsDir) {
  console.log(`📝 Generating consolidated property partials in ${partialsDir}…`);

  const propertyTemplate = handlebars.compile(
    fs.readFileSync(getTemplatePath(path.join(__dirname, 'templates', 'property.hbs'), 'TEMPLATE_PROPERTY'), 'utf8')
  );
  const topicTemplate = handlebars.compile(
    fs.readFileSync(getTemplatePath(path.join(__dirname, 'templates', 'topic-property.hbs'), 'TEMPLATE_TOPIC_PROPERTY'), 'utf8')
  );

  const propertiesPartialsDir = path.join(partialsDir, 'properties');
  fs.mkdirSync(propertiesPartialsDir, { recursive: true });

  const propertyGroups = { cluster: [], topic: [], broker: [], 'object-storage': [] };

  Object.values(properties).forEach(prop => {
    if (!prop.name || !prop.config_scope) return;
    if (prop.config_scope === 'topic') propertyGroups.topic.push(prop);
    else if (prop.config_scope === 'broker') propertyGroups.broker.push(prop);
    else if (prop.config_scope === 'cluster') {
      if (isObjectStorageProperty(prop)) propertyGroups['object-storage'].push(prop);
      else propertyGroups.cluster.push(prop);
    }
  });

  let totalCount = 0;

  Object.entries(propertyGroups).forEach(([type, props]) => {
    if (props.length === 0) return;
    props.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const selectedTemplate = type === 'topic' ? topicTemplate : propertyTemplate;
    const content = props.map(p => selectedTemplate(p)).join('\n');
    const filename = `${type}-properties.adoc`;
  const notice = '// This content is autogenerated. Do not edit manually. To override descriptions, use the doc-tools CLI with the --overrides option: https://redpandadata.atlassian.net/wiki/spaces/DOC/pages/1396244485/Review+Redpanda+configuration+properties\n';
  fs.writeFileSync(path.join(propertiesPartialsDir, filename), notice + content, 'utf8');
    console.log(`✅ Generated ${filename} (${props.length} properties)`);
    totalCount += props.length;
  });

  console.log(`✅ Done. ${totalCount} total properties.`);
  return totalCount;
}

/**
 * Generate deprecated properties documentation.
 */
function generateDeprecatedDocs(properties, outputDir) {
  const templatePath = getTemplatePath(
    path.join(__dirname, 'templates', 'deprecated-properties.hbs'),
    'TEMPLATE_DEPRECATED'
  );
  const template = handlebars.compile(fs.readFileSync(templatePath, 'utf8'));

  const deprecatedProperties = Object.values(properties).filter(p => p.is_deprecated);
  const brokerProperties = deprecatedProperties
    .filter(p => p.config_scope === 'broker')
    .sort((a, b) => a.name.localeCompare(b.name));
  const clusterProperties = deprecatedProperties
    .filter(p => p.config_scope === 'cluster')
    .sort((a, b) => a.name.localeCompare(b.name));

  const data = {
    deprecated: deprecatedProperties.length > 0,
    brokerProperties: brokerProperties.length ? brokerProperties : null,
    clusterProperties: clusterProperties.length ? clusterProperties : null
  };

  const output = template(data);
  const outputPath = process.env.OUTPUT_PARTIALS_DIR
    ? path.join(process.env.OUTPUT_PARTIALS_DIR, 'deprecated', 'deprecated-properties.adoc')
    : path.join(outputDir, 'partials', 'deprecated', 'deprecated-properties.adoc');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const notice = '// This content is autogenerated. Do not edit manually. To override descriptions, use the doc-tools CLI with the --overrides option: https://redpandadata.atlassian.net/wiki/spaces/DOC/pages/1396244485/Review+Redpanda+configuration+properties\n';
  fs.writeFileSync(outputPath, notice + output, 'utf8');
  console.log(`✅ Generated ${outputPath}`);
  return deprecatedProperties.length;
}

/**
 * Generate topic-property-mappings.adoc using the mappings template and topic properties.
 */
function generateTopicPropertyMappings(properties, partialsDir) {
  const templatesDir = path.join(__dirname, 'templates');
  const mappingsTemplatePath = getTemplatePath(
    path.join(templatesDir, 'topic-property-mappings.hbs'),
    'TEMPLATE_TOPIC_PROPERTY_MAPPINGS'
  );
  if (!fs.existsSync(mappingsTemplatePath)) {
    throw new Error(`topic-property-mappings.hbs template not found: ${mappingsTemplatePath}`);
  }
  const topicProperties = Object.values(properties).filter(
    p => p.is_topic_property && p.corresponding_cluster_property
  );
  if (topicProperties.length === 0) {
    console.log('ℹ️ No topic properties with corresponding_cluster_property found. Skipping topic-property-mappings.adoc.');
    return 0;
  }
  const hbsSource = fs.readFileSync(mappingsTemplatePath, 'utf8');
  const hbs = handlebars.compile(hbsSource);
  const rendered = hbs({ topicProperties });
  const mappingsOut = path.join(partialsDir, 'topic-property-mappings.adoc');
  const notice = '// This content is autogenerated. Do not edit manually. To override descriptions, use the doc-tools CLI with the --overrides option: https://redpandadata.atlassian.net/wiki/spaces/DOC/pages/1396244485/Review+Redpanda+configuration+properties\n';
  fs.writeFileSync(mappingsOut, notice + rendered, 'utf8');
  console.log(`✅ Generated ${mappingsOut}`);
  return topicProperties.length;
}

/**
 * Generate error reports for missing descriptions and deprecated properties.
 */
function generateErrorReports(properties) {
  const emptyDescriptions = [];
  const deprecatedProperties = [];

  Object.values(properties).forEach(p => {
    if (!p.description || !p.description.trim()) emptyDescriptions.push(p.name);
    if (p.is_deprecated) deprecatedProperties.push(p.name);
  });

  const total = Object.keys(properties).length;
  const pctEmpty = total ? ((emptyDescriptions.length / total) * 100).toFixed(2) : '0.00';
  const pctDeprecated = total ? ((deprecatedProperties.length / total) * 100).toFixed(2) : '0.00';
  console.log(`Empty descriptions: ${emptyDescriptions.length} (${pctEmpty}%)`);
  console.log(`Deprecated: ${deprecatedProperties.length} (${pctDeprecated}%)`);

  return {
    empty_descriptions: emptyDescriptions.sort(),
    deprecated_properties: deprecatedProperties.sort()
  };
}

/**
 * Main generator — only supports partials and deprecated docs.
 */
function generateAllDocs(inputFile, outputDir) {
  const data = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const properties = data.properties || {};

  registerPartials();

  let partialsCount = 0;
  let deprecatedCount = 0;

  if (process.env.GENERATE_PARTIALS === '1' && process.env.OUTPUT_PARTIALS_DIR) {
    console.log('📄 Generating property partials and deprecated docs...');
    deprecatedCount = generateDeprecatedDocs(properties, outputDir);
    partialsCount = generatePropertyPartials(properties, process.env.OUTPUT_PARTIALS_DIR);

    // Generate topic-property-mappings.adoc
    try {
      generateTopicPropertyMappings(properties, process.env.OUTPUT_PARTIALS_DIR);
    } catch (err) {
      console.error(`❌ Failed to generate topic-property-mappings.adoc: ${err.message}`);
    }
  } else {
    console.log('📄 Skipping partial generation (set GENERATE_PARTIALS=1 and OUTPUT_PARTIALS_DIR to enable)');
  }

  const errors = generateErrorReports(properties);
  const inputData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  inputData.empty_descriptions = errors.empty_descriptions;
  inputData.deprecated_properties = errors.deprecated_properties;
  fs.writeFileSync(inputFile, JSON.stringify(inputData, null, 2), 'utf8');

  console.log('📊 Summary:');
  console.log(`   Total properties: ${Object.keys(properties).length}`);
  console.log(`   Total partials generated: ${partialsCount}`);
  console.log(`   Deprecated properties: ${deprecatedCount}`);

  return {
    totalProperties: Object.keys(properties).length,
    propertyPartials: partialsCount,
    deprecatedProperties: deprecatedCount
  };
}

module.exports = {
  generateAllDocs,
  generateDeprecatedDocs,
  generatePropertyPartials
};

// CLI
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
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  }
}
