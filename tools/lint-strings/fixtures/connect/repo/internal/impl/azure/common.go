// Package azure is a lint-strings fixture mirroring connect's Azure package:
// specs start from a helper constructor and share parameterized fields.
package azure

import "github.com/redpanda-data/benthos/v4/public/service"

const azureFieldAccount = "storage_account"

// azureComponentSpec builds the spec every Azure component starts from.
func azureComponentSpec() *service.ConfigSpec {
	return service.NewConfigSpec().
		Categories("Services", "Azure")
}

// accountField is called once per component, with a different product.
func accountField(product string) *service.ConfigField {
	return service.NewStringField(azureFieldAccount).
		Description("The storage account to access for " + product + ".").
		ShortDescription("The `storage account` to access.")
}
