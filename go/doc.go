// Package thinkai is the official ThinkAI SDK for Go.
//
// Resources use context.Context for cancellation. JSON is returned as
// json.RawMessage so that provider-specific fields and number precision are
// preserved. Streaming and binary responses must be closed by the caller.
package thinkai
