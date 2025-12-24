#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const glob = require('glob');

// Commercial name mappings based on connector patterns
const commercialNameMappings = {
  // AWS services
  'aws_s3': 'Amazon S3, AWS S3, S3, Simple Storage Service',
  'aws_kinesis': 'Amazon Kinesis, AWS Kinesis, Kinesis',
  'aws_sqs': 'Amazon SQS, AWS SQS, SQS, Simple Queue Service',
  'aws_sns': 'Amazon SNS, AWS SNS, SNS, Simple Notification Service',
  'aws_dynamodb': 'Amazon DynamoDB, AWS DynamoDB, DynamoDB',
  'aws_kinesis_firehose': 'Amazon Kinesis Firehose, AWS Kinesis Firehose, Kinesis Firehose',
  'aws_lambda': 'Amazon Lambda, AWS Lambda, Lambda',
  'aws_cloudwatch': 'Amazon CloudWatch, AWS CloudWatch, CloudWatch',

  // Message queues
  'amqp_0_9': 'RabbitMQ, AMQP',
  'amqp_1': 'RabbitMQ, AMQP, Apache Qpid',
  'kafka': 'Apache Kafka, Kafka',
  'kafka_franz': 'Apache Kafka, Kafka',
  'nats': 'NATS, NATS.io',
  'nats_jetstream': 'NATS JetStream, NATS',
  'nats_stream': 'NATS Streaming, NATS',
  'pulsar': 'Apache Pulsar, Pulsar',
  'redis_pubsub': 'Redis Pub/Sub, Redis',
  'redis_streams': 'Redis Streams, Redis',
  'redis_list': 'Redis Lists, Redis',

  // Databases - general patterns
  'mongodb': 'MongoDB, Mongo',
  'cassandra': 'Apache Cassandra, Cassandra',
  'elasticsearch': 'Elasticsearch, Elastic',
  'influxdb': 'InfluxDB, Influx',
  'redis_hash': 'Redis, Redis Hash',

  // HTTP/API
  'http_client': 'HTTP, REST API, REST',
  'http_server': 'HTTP, REST API, REST, Gateway',
  'webhook': 'Webhook, HTTP',

  // File formats
  'unarchive': 'ZIP, TAR, GZIP, Archive, JSON, CSV',
  'archive': 'ZIP, TAR, GZIP, Archive',
  'lines': 'Text Files, Plain Text, Log Files',
  'csv': 'CSV, Comma-Separated Values',

  // Cloud providers (generic patterns will catch aws_*, gcp_*, azure_*)
  'gcp_pubsub': 'Google Cloud Pub/Sub, GCP Pub/Sub, Google Pub/Sub',
  'gcp_bigquery': 'Google BigQuery, GCP BigQuery, BigQuery',
  'gcp_cloud_storage': 'Google Cloud Storage, GCS, GCP Cloud Storage',
  'azure_blob_storage': 'Azure Blob Storage, Microsoft Azure Storage',
  'azure_queue_storage': 'Azure Queue Storage, Microsoft Azure Queue',
  'azure_table_storage': 'Azure Table Storage, Microsoft Azure Table',
};

// Pattern-based commercial names (for connectors not in explicit mapping)
function getCommercialNamesFromPattern(connectorName) {
  const names = [];

  // AWS pattern
  if (connectorName.startsWith('aws_')) {
    names.push('Amazon');
    names.push('AWS');
    const serviceName = connectorName.replace('aws_', '').replace(/_/g, ' ');
    names.push(serviceName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
  }

  // GCP pattern
  if (connectorName.startsWith('gcp_')) {
    names.push('Google Cloud');
    names.push('GCP');
  }

  // Azure pattern
  if (connectorName.startsWith('azure_')) {
    names.push('Microsoft Azure');
    names.push('Azure');
  }

  // SQL databases
  if (connectorName.startsWith('sql_')) {
    names.push('SQL');
    names.push('PostgreSQL');
    names.push('MySQL');
    names.push('Microsoft SQL Server');
    names.push('ClickHouse');
    names.push('Trino');
  }

  return names;
}

function getCommercialNames(connectorName) {
  // Check explicit mapping first
  if (commercialNameMappings[connectorName]) {
    return commercialNameMappings[connectorName];
  }

  // Try pattern matching
  const patternNames = getCommercialNamesFromPattern(connectorName);
  if (patternNames.length > 0) {
    return patternNames.join(', ');
  }

  return null;
}

function addCommercialNamesToFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  let lines = content.split('\n');

  // Extract connector name from file path
  const connectorName = path.basename(filePath, '.adoc');

  // Remove existing page-commercial-names if present (we'll re-add in correct location)
  lines = lines.filter(line => !line.includes(':page-commercial-names:'));

  // Get commercial names
  const commercialNames = getCommercialNames(connectorName);
  if (!commercialNames) {
    return { status: 'skip', reason: 'no commercial names found' };
  }

  // Find the position to insert (after single-source tag if present, otherwise after title)
  let insertIndex = -1;
  let titleIndex = -1;

  // First find the title
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('= ')) {
      titleIndex = i;
      break;
    }
  }

  if (titleIndex === -1) {
    return { status: 'error', reason: 'could not find title' };
  }

  // Look for single-source tag after the title (with or without space after //)
  let foundSingleSource = false;
  for (let i = titleIndex + 1; i < Math.min(titleIndex + 10, lines.length); i++) {
    if (lines[i].includes('tag::single-source[]')) {
      insertIndex = i + 1;
      foundSingleSource = true;
      break;
    }
  }

  // If no single-source tag, insert after title
  if (!foundSingleSource) {
    insertIndex = titleIndex + 1;
    // Skip any existing page attributes
    while (insertIndex < lines.length && lines[insertIndex].startsWith(':')) {
      insertIndex++;
    }
  }

  if (insertIndex === -1) {
    return { status: 'error', reason: 'could not find title' };
  }

  // Insert the attribute
  lines.splice(insertIndex, 0, `:page-commercial-names: ${commercialNames}`);

  // Write back
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

  return { status: 'added', commercialNames };
}

// Main execution
const basePath = process.argv[2] || '/Users/jakecahill/Documents/rp-connect-docs';
const pattern = `${basePath}/modules/components/pages/{inputs,outputs,processors}/*.adoc`;

console.log(`Finding connector files in: ${pattern}`);
const files = glob.sync(pattern).filter(f => !f.endsWith('about.adoc'));

console.log(`Found ${files.length} connector files\n`);

let added = 0;
let skipped = 0;
let errors = 0;

files.forEach(file => {
  const connectorName = path.basename(file, '.adoc');
  const result = addCommercialNamesToFile(file);

  if (result.status === 'added') {
    console.log(`✅ ${connectorName}: ${result.commercialNames}`);
    added++;
  } else if (result.status === 'skip') {
    skipped++;
  } else if (result.status === 'error') {
    console.error(`❌ ${connectorName}: ${result.reason}`);
    errors++;
  }
});

console.log(`\n📊 Summary:`);
console.log(`  ✅ Added: ${added}`);
console.log(`  ⏭️  Skipped: ${skipped}`);
console.log(`  ❌ Errors: ${errors}`);
console.log(`  📝 Total: ${files.length}`);
