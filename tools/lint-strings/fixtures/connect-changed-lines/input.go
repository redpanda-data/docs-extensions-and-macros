package oracledb

import "github.com/redpanda-data/benthos/v4/public/service"

func oracleSpec() *service.ConfigSpec {
	return service.NewConfigSpec().
		Summary("Streams changes from an Oracle database.").
		Description(`
Streams row changes from an Oracle database using LogMiner.

The input reads the redo log and emits one message per row change.

== Metadata

This input adds the following metadata fields to each message:

- database_schema
- table_name
- operation
`).
		Field(service.NewStringField("dsn").Description("The connection string for the Oracle database."))
}

func init() {
	service.MustRegisterBatchInput("oracledb_cdc", oracleSpec(), nil)
}
