// Package retries is a helper package outside internal/impl whose fields
// appear on every component that calls it.
package retries

import "github.com/redpanda-data/benthos/v4/public/service"

// CommonRetryBackOffFields returns the common retry fields.
func CommonRetryBackOffFields(defaultMaxRetries int, initial, maxInterval, maxElapsed string) []*service.ConfigField {
	return []*service.ConfigField{
		service.NewIntField("max_retries").
			Description("The maximum number of retries before giving up on the request."),
	}
}
