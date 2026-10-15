package thinkai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	Version         = "1.0.1"
	DefaultEndpoint = "https://ai.topthink.com/"
	DefaultTimeout  = 300 * time.Second
)

// Params holds API parameters, including provider-specific extension fields.
type Params map[string]any

// HTTPClient is implemented by *http.Client and injectable test clients.
type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

type Client struct {
	token    string
	endpoint *url.URL
	timeout  time.Duration
	http     HTTPClient
}

type Option func(*Client) error

// NewClient creates a client with TLS verification enabled and no SDK retries.
func NewClient(token string, options ...Option) (*Client, error) {
	endpoint, _ := url.Parse(DefaultEndpoint)
	c := &Client{token: token, endpoint: endpoint, timeout: DefaultTimeout, http: &http.Client{}}
	for _, option := range options {
		if option == nil {
			return nil, errors.New("thinkai: nil client option")
		}
		if err := option(c); err != nil {
			return nil, err
		}
	}
	return c, nil
}

// WithEndpoint sets the API root. A trailing slash is optional; any path prefix
// is preserved. HTTP is supported for local testing; production defaults to HTTPS.
func WithEndpoint(endpoint string) Option {
	return func(c *Client) error {
		u, err := url.Parse(endpoint)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
			return errors.New("thinkai: endpoint must be an absolute HTTP(S) URL without credentials, query, or fragment")
		}
		u.Path = strings.TrimRight(u.Path, "/") + "/"
		if u.RawPath != "" {
			u.RawPath = strings.TrimRight(u.RawPath, "/") + "/"
		}
		c.endpoint = u
		return nil
	}
}

// WithTimeout sets the total duration of each request, including reading its
// streaming or binary body. A shorter context deadline always takes precedence.
func WithTimeout(timeout time.Duration) Option {
	return func(c *Client) error {
		if timeout <= 0 {
			return errors.New("thinkai: timeout must be positive")
		}
		c.timeout = timeout
		return nil
	}
}

func WithHTTPClient(client HTTPClient) Option {
	return func(c *Client) error {
		if client == nil {
			return errors.New("thinkai: HTTP client must not be nil")
		}
		c.http = client
		return nil
	}
}

// APIError retains the response body and validation details for non-2xx replies.
type APIError struct {
	StatusCode int
	Header     http.Header
	Message    string
	RawBody    []byte
	Details    json.RawMessage
}

func (e *APIError) Error() string {
	return fmt.Sprintf("thinkai: HTTP %d: %s", e.StatusCode, e.Message)
}

// ProtocolError retains an unexpected successful response for diagnosis.
type ProtocolError struct {
	Message string
	RawBody []byte
}

func (e *ProtocolError) Error() string { return "thinkai: " + e.Message }

// ResultKind describes the actual response content type rather than the request's
// stream flag. A server may send JSON even when streaming was requested.
type ResultKind string

const (
	KindJSON   ResultKind = "json"
	KindStream ResultKind = "stream"
	KindBinary ResultKind = "binary"
	KindEmpty  ResultKind = "empty"
)

type Result struct {
	Kind       ResultKind
	JSON       json.RawMessage
	Stream     *Stream
	Binary     io.ReadCloser
	StatusCode int
	Header     http.Header
}

func (r *Result) AsJSON() (json.RawMessage, error) {
	if r == nil || r.Kind != KindJSON {
		return nil, errors.New("thinkai: result is not JSON")
	}
	return r.JSON, nil
}

func (r *Result) AsStream() (*Stream, error) {
	if r == nil || r.Kind != KindStream {
		return nil, errors.New("thinkai: result is not an SSE stream")
	}
	return r.Stream, nil
}

func (r *Result) AsBinary() (io.ReadCloser, error) {
	if r == nil || r.Kind != KindBinary {
		return nil, errors.New("thinkai: result is not binary")
	}
	return r.Binary, nil
}

// Close releases a live SSE or binary response. JSON/empty results need no cleanup.
func (r *Result) Close() error {
	if r == nil {
		return nil
	}
	if r.Stream != nil {
		return r.Stream.Close()
	}
	if r.Binary != nil {
		return r.Binary.Close()
	}
	return nil
}

// managedBody keeps the request deadline active until the response is consumed
// or closed, and cancels it on either path. Close is safe during a blocked read.
type managedBody struct {
	io.ReadCloser
	ctx      context.Context
	cancel   context.CancelFunc
	once     sync.Once
	closeErr error
	keepOpen bool
	readErr  error
}

func (b *managedBody) Close() error {
	b.once.Do(func() { b.cancel(); b.closeErr = b.ReadCloser.Close() })
	return b.closeErr
}

func (b *managedBody) Read(p []byte) (int, error) {
	// Preserve a completed read's EOF: our own Close cancels ctx after EOF,
	// but another read must still report EOF rather than a spurious cancellation.
	if b.readErr != nil {
		return 0, b.readErr
	}
	if err := b.ctx.Err(); err != nil {
		b.readErr = err
		_ = b.Close()
		return 0, err
	}
	n, err := b.ReadCloser.Read(p)
	// A buffered or injected response reader can return bytes after its request
	// deadline. Do not deliver those bytes once the operation has expired.
	if contextErr := b.ctx.Err(); contextErr != nil {
		b.readErr = contextErr
		_ = b.Close()
		return 0, contextErr
	}
	if err != nil {
		b.readErr = err
	}
	if err != nil && !b.keepOpen {
		_ = b.Close()
	}
	return n, err
}

func (c *Client) request(ctx context.Context, method, path string, query Params, body io.Reader, contentType string, rawResponse bool) (*Result, error) {
	if ctx == nil {
		return nil, errors.New("thinkai: context must not be nil")
	}
	requestURL, err := c.endpoint.Parse(path)
	if err != nil {
		return nil, fmt.Errorf("thinkai: invalid request path: %w", err)
	}
	values := requestURL.Query()
	if query != nil {
		raw, err := json.Marshal(query)
		if err != nil {
			return nil, fmt.Errorf("thinkai: encode query: %w", err)
		}
		var normalized map[string]any
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if err := decoder.Decode(&normalized); err != nil {
			return nil, fmt.Errorf("thinkai: encode query: %w", err)
		}
		for key, value := range normalized {
			addQueryValue(values, key, value)
		}
	}
	requestURL.RawQuery = values.Encode()
	requestCtx, cancel := context.WithTimeout(ctx, c.timeout)
	req, err := http.NewRequestWithContext(requestCtx, method, requestURL.String(), body)
	if err != nil {
		cancel()
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("User-Agent", "ThinkAI-Go/"+Version)
	req.Header.Set("Accept", "application/json, text/event-stream, application/octet-stream")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	response, err := c.http.Do(req)
	if err != nil {
		cancel()
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		return nil, err
	}
	if response == nil || response.Body == nil {
		cancel()
		return nil, errors.New("thinkai: HTTP client returned no response body")
	}
	wrapped := &managedBody{ReadCloser: response.Body, ctx: requestCtx, cancel: cancel}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, readErr := io.ReadAll(wrapped)
		_ = wrapped.Close()
		if readErr != nil {
			return nil, readErr
		}
		return nil, newAPIError(response, raw)
	}
	r := &Result{StatusCode: response.StatusCode, Header: response.Header.Clone()}
	if response.StatusCode == http.StatusNoContent || response.ContentLength == 0 {
		_ = wrapped.Close()
		r.Kind = KindEmpty
		return r, nil
	}
	if rawResponse {
		r.Kind, r.Binary = KindBinary, wrapped
		return r, nil
	}
	mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	mediaType = strings.ToLower(mediaType)
	switch {
	case mediaType == "application/json" || strings.HasSuffix(mediaType, "+json"):
		raw, readErr := io.ReadAll(wrapped)
		_ = wrapped.Close()
		if readErr != nil {
			return nil, readErr
		}
		if len(bytes.TrimSpace(raw)) == 0 {
			r.Kind = KindEmpty
			return r, nil
		}
		if !json.Valid(raw) {
			return nil, errors.New("thinkai: invalid JSON response")
		}
		r.Kind, r.JSON = KindJSON, json.RawMessage(raw)
	case mediaType == "text/event-stream":
		wrapped.keepOpen = true
		r.Kind, r.Stream = KindStream, newStream(wrapped, requestCtx)
	default:
		r.Kind, r.Binary = KindBinary, wrapped
	}
	return r, nil
}

func newAPIError(response *http.Response, raw []byte) *APIError {
	e := &APIError{StatusCode: response.StatusCode, Header: response.Header.Clone(), RawBody: raw, Message: http.StatusText(response.StatusCode)}
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) == nil {
		e.Details = append(json.RawMessage(nil), raw...)
		_ = json.Unmarshal(obj["message"], &e.Message)
		var nested struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(obj["error"], &nested) == nil && nested.Message != "" {
			e.Message = nested.Message
		}
	}
	if e.Message == "" {
		e.Message = "request failed"
	}
	return e
}

func (c *Client) jsonRequest(ctx context.Context, method, path string, query Params, params Params) (*Result, error) {
	var body io.Reader
	contentType := ""
	if method != http.MethodGet && method != http.MethodDelete {
		if params == nil {
			params = Params{}
		}
		raw, err := json.Marshal(params)
		if err != nil {
			return nil, fmt.Errorf("thinkai: encode parameters: %w", err)
		}
		body, contentType = bytes.NewReader(raw), "application/json"
	}
	return c.request(ctx, method, path, query, body, contentType, false)
}

func (c *Client) json(ctx context.Context, method, path string, query, params Params) (json.RawMessage, error) {
	r, err := c.jsonRequest(ctx, method, path, query, params)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	if r.Kind == KindEmpty {
		return nil, nil
	}
	return r.AsJSON()
}

func (c *Client) download(ctx context.Context, path string, query Params) (io.ReadCloser, error) {
	r, err := c.request(ctx, http.MethodGet, path, query, nil, "", true)
	if err != nil {
		return nil, err
	}
	if r.Kind == KindBinary {
		return r.Binary, nil
	}
	if r.Kind == KindEmpty {
		return io.NopCloser(bytes.NewReader(nil)), nil
	}
	_ = r.Close()
	return nil, errors.New("thinkai: expected downloadable content")
}

func segment(value string) string {
	if value == "." {
		return "%2E"
	}
	if value == ".." {
		return "%2E%2E"
	}
	return url.PathEscape(value)
}

// addQueryValue matches PHP/Guzzle's bracket-style query encoding. JSON
// normalization above also accepts typed maps/slices and preserves json.Number.
func addQueryValue(values url.Values, key string, value any) {
	switch v := value.(type) {
	case nil:
	case bool:
		if v {
			values.Set(key, "1")
		} else {
			values.Set(key, "0")
		}
	case map[string]any:
		for field, item := range v {
			addQueryValue(values, key+"["+field+"]", item)
		}
	case []any:
		for index, item := range v {
			addQueryValue(values, fmt.Sprintf("%s[%d]", key, index), item)
		}
	default:
		values.Set(key, fmt.Sprint(value))
	}
}
