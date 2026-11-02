package azure

import "github.com/redpanda-data/benthos/v4/public/service"

func init() {
	conf := azureComponentSpec().
		Summary("Writes things to " + thingProduct + ".")
	conf = conf.Field(accountField("Azure Thing output"))
	// A field added in place, without reassignment.
	conf.Field(service.NewStringField("container").Description("The container to write things to."))
	service.MustRegisterOutput("azure_thing", conf, nil)
}
