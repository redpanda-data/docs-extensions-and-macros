'use strict';

module.exports.register = function ({ config }) {
  const logger = this.getLogger('redpanda-connect-category-aggregation-extension');

  // Component name mapping for common names
  const componentNameMap = {}
    /*
    "aws_kinesis_data_streams": "AWS Kinesis Data Streams",
    "aws_kinesis_firehose": "AWS Kinesis Firehose",
    "aws_kinesis": "AWS Kinesis",
    "aws_sqs": "AWS SQS",
    "aws_sns": "AWS SNS",
    "azure_cosmosdb": "Azure Cosmos DB",
    "azure_table_storage": "Azure Table Storage",
    "gcp_bigquery": "GCP BigQuery",
    "oracle": "Oracle",
    "snowflake_put": "Snowflake",
    "aws_dynamodb": "AWS DynamoDB",
    "azure_blob_storage": "Azure Blob Storage",
    "aws_s3": "AWS S3",
    "cassandra": "Cassandra",
    "gcp_cloud_storage": "GCP Cloud Storage",
    "amqp": "AMQP",
    "avro": "Avro",
    "awk": "AWK",
    "aws_lambda": "AWS Lambda",
    "azure_queue_storage": "Azure Queue Storage",
    "clickhouse": "ClickHouse",
    "cockroachdb_changefeed": "CockroachDB",
    "couchbase": "Couchbase",
    "csv": "CSV",
    "discord": "Discord",
    "elasticsearch": "Elasticsearch",
    "kafka_franz": "Franz-go",
    "gcp_pubsub": "GCP Pub/Sub",
    "grok": "Grok",
    "hdfs": "HDFS",
    "http": "HTTP",
    "javascript": "JavaScript",
    "jmespath": "JMESPath",
    "json_schema": "JSON Schema",
    "kafka": "Kafka",
    "memcached": "Memcached",
    "msgpack": "MessagePack",
    "mongodb": "MongoDB",
    "mqtt": "MQTT",
    "mysql": "MySQL",
    "nats": "NATS",
    "nsq": "NSQ",
    "opensearch": "OpenSearch",
    "parquet": "Parquet",
    "postgresql": "PostgreSQL",
    "protobuf": "Protobuf",
    "pulsar": "Pulsar",
    "redis": "Redis",
    "ristretto": "Ristretto",
    "schema_registry": "Schema Registry",
    "sentry": "Sentry",
    "socket": "Socket",
    "sql": "SQL",
    "sqlite": "SQLite",
    "trino": "Trino",
    "wasm": "Wasm (WebAssembly)",
    "websocket": "WebSocket",
    "twitter_search": "X (Twitter)",
    "xml": "XML"
  };
  */

  const certifiedConnectors = {
    "aws_kinesis_firehose": ["output"],
    "aws_s3": ["input", "output"],
    "aws_sqs": ["input", "output"],
    "sql_raw": ["input", "output", "processor"],
    "sql_insert": ["output", "processor"],
    "sql_select": ["input", "output", "processor"],
    "aws_kinesis": ["input", "output"],
    "csv": ["input"],
    "generate": ["input"],
    "redis_scan": ["input"],
    "opensearch": ["output"],
    "redis_hash": ["output"],
    "amqp_0_9": ["input", "output"],
    "file": ["input", "output"],
    "http_client": ["input", "output"],
    "http_server": ["input", "output"],
    "kafka": ["input", "output"],
    "kafka_franz": ["input", "output"],
    "nats": ["input", "output"],
    "nats_jetstream": ["input", "output"],
    "nats_kv": ["input", "output"],
    "redis_list": ["input", "output"],
    "redis_pubsub": ["input", "output"],
    "redis_streams": ["input", "output"],
    "socket": ["input", "output"],
    "socket_server": ["input", "output"],
    "websocket": ["input", "output"],
    "sftp": ["output"],
    "archive": ["processor"],
    "aws_dynamodb_partiql": ["processor"],
    "aws_lambda": ["processor"],
    "bloblang": ["processor"],
    "bounds_check": ["processor"],
    "cache": ["processor"],
    "cached": ["processor"],
    "command": ["processor"],
    "compress": ["processor"],
    "decompress": ["processor"],
    "dedupe": ["processor"],
    "group_by": ["processor"],
    "group_by_value": ["processor"],
    "http": ["processor"],
    "javascript": ["processor"],
    "jmespath": ["processor"],
    "jq": ["processor"],
    "json_schema": ["processor"],
    "log": ["processor"],
    "mapping": ["processor"],
    "metric": ["processor"],
    "mutation": ["processor"],
    "nats_kv": ["processor"],
    "nats_request_reply": ["processor"],
    "parquet_decode": ["processor"],
    "parquet_encode": ["processor"],
    "protobuf": ["processor"],
    "rate_limit": ["processor"],
    "redis": ["processor"],
    "redis_script": ["processor"],
    "schema_registry_decode": ["processor"],
    "schema_registry_encode": ["processor"],
    "select_parts": ["processor"],
    "sleep": ["processor"],
    "unarchive": ["processor"],
    "workflow": ["processor"]
  };

  this.once('contentClassified', ({ siteCatalog, contentCatalog }) => {
    const redpandaConnect = contentCatalog.getComponents().find(component => component.name === 'redpanda-connect');
    if (!redpandaConnect || !redpandaConnect.latest) {
      logger.info('Could not find the redpanda-connect component');
      return;
    }

    const descriptions = redpandaConnect.latest.asciidoc.attributes.categories;
    if (!descriptions) {
      logger.info('No categories attribute found in redpanda-connect component');
      return;
    }

    const connectCategoriesData = {};
    const flatComponentsData = [];
    const driverSupportData = {};
    const cacheSupportData = {};
    const types = Object.keys(descriptions);

    // Initialize connectCategoriesData for each type
    types.forEach(type => {
      connectCategoriesData[type] = [];
    });

    try {
      const files = contentCatalog.findBy({ component: 'redpanda-connect', family: 'page' });

      files.forEach(file => {
        let content = file.contents.toString('utf8');
        const categoryMatch = /:categories: (.*)/.exec(content);
        const typeMatch = /:type: (.*)/.exec(content);
        const statusMatch = /:status: (.*)/.exec(content);
        const driverSupportMatch = /:driver-support: (.*)/.exec(content);
        const cacheSupportMatch = /:cache-support: (.*)/.exec(content);
        const enterpriseMatch = /:enterprise: true/.exec(content);
        const pubUrl = file.pub.url;
        const name = file.src.stem;

        if (typeMatch) {
          const fileType = typeMatch[1];
          let status = statusMatch ? statusMatch[1] : 'community';
          //if (status === 'beta' || status === 'experimental') status = 'community';
          //if (status === 'stable') status = 'certified';

          // Skip deprecated components
          if (status === 'deprecated') return;

          // Override status to "certified" if in the lookup table
          if (certifiedConnectors[name] && certifiedConnectors[name].includes(fileType) || enterpriseMatch) {
            status = 'certified';
          } else {
            status = 'community';
          }

          // Replace :status: attribute with :page-status:
          content = content.replace(/:status: .*/, `:page-status: ${status}`);
          content = content.replace(/:driver-support: .*/, driverSupportMatch ? `:page-driver-support: ${driverSupportMatch[1]}` : ':page-driver-support:');
          content = content.replace(/:cache-support: .*/, cacheSupportMatch ? `:page-cache-support: ${cacheSupportMatch[1]}` : ':page-cache-support:');
          content = content.replace(/:enterprise: true/, enterpriseMatch ? ':page-enterprise: true' : ':page-enterprise:');
          file.contents = Buffer.from(content, 'utf8');

          const commonName = componentNameMap?.[name] ?? name;

          // Populate connectCategoriesData
          if (types.includes(fileType) && categoryMatch) {
            const categories = categoryMatch[1].replace(/[\[\]"]/g, '').split(',').map(category => category.trim());
            categories.forEach(category => {
              let categoryObj = connectCategoriesData[fileType].find(cat => cat.name === category);

              if (!categoryObj) {
                categoryObj = descriptions[fileType].find(desc => desc.name === category) || { name: category, description: "" };
                categoryObj.items = [];
                connectCategoriesData[fileType].push(categoryObj);
              }

              categoryObj.items.push({ name: commonName, url: pubUrl, status: status });
            });
          }

          // Populate flatComponentsData
          let flatItem = flatComponentsData.find(item => item.name === commonName);
          if (!flatItem) {
            flatItem = { name: commonName, originalName: name, support: status, types: [], enterprise: enterpriseMatch ? true : false};
            flatComponentsData.push(flatItem);
          }

          if (!flatItem.types.some(type => type.type === fileType)) {
            flatItem.types.push({ type: fileType, url: pubUrl, enterprise: enterpriseMatch? true : false, support: status});
          }

          // Populate support data
          if (driverSupportMatch) driverSupportData[name] = driverSupportMatch[1];
          if (cacheSupportMatch) cacheSupportData[name] = cacheSupportMatch[1];
        }
      });

      redpandaConnect.latest.asciidoc.attributes.connectCategoriesData = connectCategoriesData;
      redpandaConnect.latest.asciidoc.attributes.flatComponentsData = flatComponentsData;
      redpandaConnect.latest.asciidoc.attributes.driverSupportData = driverSupportData;
      redpandaConnect.latest.asciidoc.attributes.cacheSupportData = cacheSupportData;

      logger.info(`Added Redpanda Connect data to latest Asciidoc object: ${JSON.stringify({ connectCategoriesData, flatComponentsData }, null, 2)}`);
    } catch (error) {
      logger.error(`Error processing Redpanda Connect files: ${error.message}`);
    }
  });
};
