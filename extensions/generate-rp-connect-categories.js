'use strict';

module.exports.register = function ({ config }) {
  const logger = this.getLogger('redpanda-connect-category-aggregation-extension');

  // TODO: Integrate these as attributes like common-name in the autogenerated source pages.
  // This hardcoded map is just for launch.
  const componentNameMap = {
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
    "nanomsg": "nanomsg",
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
    const types = Object.keys(descriptions);

    // Initialize connectCategoriesData for each type
    types.forEach(type => {
      connectCategoriesData[type] = [];
    });

    try {
      const files = contentCatalog.findBy({ component: 'redpanda-connect', family: 'page' });

      files.forEach(file => {
        const content = file.contents.toString('utf8');
        const categoryMatch = /:categories: (.*)/.exec(content);
        const typeMatch = /:type: (.*)/.exec(content);
        const statusMatch = /:status: (.*)/.exec(content);
        const pubUrl = file.pub.url;
        const name = file.src.stem;

        if (categoryMatch && typeMatch) {
          let categories = categoryMatch[1];
          const fileType = typeMatch[1];
          let status = statusMatch ? statusMatch[1] : 'Enterprise';
          if (status === 'beta' || status === 'experimental') status = 'Community';
          if (status === 'stable') status = 'Enterprise';

          // Skip deprecated components
          if (status === 'deprecated') return;

          // Map component name to common name
          const commonName = componentNameMap[name] || name;

          // Populate connectCategoriesData
          if (types.includes(fileType) && categories) {
            if (typeof categories === 'string') {
              categories = categories.replace(/[\[\]"]/g, '').split(',').map(category => category.trim());
            }

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
          if (flatItem) {
            if (!flatItem.types.includes(fileType)) {
              flatItem.types.push({ type: fileType, url: pubUrl });
            }
          } else {
            flatItem = { name: commonName, originalName: name, support: status, types: [{ type: fileType, url: pubUrl }] };
            flatComponentsData.push(flatItem);
          }
        }
      });

      try {
        redpandaConnect.latest.asciidoc.attributes.connectCategoriesData = connectCategoriesData;
        redpandaConnect.latest.asciidoc.attributes.flatComponentsData = flatComponentsData;
        logger.info(`Added Redpanda Connect data to latest Asciidoc object: ${JSON.stringify({ connectCategoriesData, flatComponentsData }, null, 2)}`);
      } catch (error) {
        logger.error(`Error updating latest Asciidoc object for Redpanda Connect: ${error.message}`);
      }
    } catch (error) {
      logger.error(`Error processing Redpanda Connect files: ${error.message}`);
    }
  });
};