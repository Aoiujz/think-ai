package thinkai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func mustClient(t *testing.T, options ...Option) *Client {
	t.Helper()
	c, err := NewClient("offline-token", options...)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

type contractOperation struct {
	Resource   string `json:"resource"`
	Operation  string `json:"operation"`
	HTTPMethod string `json:"http_method"`
	Path       string `json:"path"`
	Response   string `json:"response"`
}

func contractOperations(t *testing.T) []contractOperation {
	t.Helper()
	raw, err := os.ReadFile("../tests/contracts/operations.json")
	if os.IsNotExist(err) {
		t.Skip("shared contract fixtures are available in the SDK monorepo")
	}
	if err != nil {
		t.Fatal(err)
	}
	var operations []contractOperation
	if err := json.Unmarshal(raw, &operations); err != nil {
		t.Fatal(err)
	}
	if len(operations) != 37 {
		t.Fatalf("expected 37 shared operations, got %d", len(operations))
	}
	return operations
}

// invokeContract exercises the public resource methods named in the common
// manifest. Signature-specific arguments cover multipart, optional values,
// files, path segments, and the dynamic streaming responses.
func invokeContract(t *testing.T, c *Client, operation contractOperation) {
	t.Helper()
	resourceName := strings.ToUpper(operation.Resource[:1]) + operation.Resource[1:]
	constructor := reflect.ValueOf(c).MethodByName(resourceName)
	if !constructor.IsValid() {
		t.Fatalf("missing resource %s", resourceName)
	}
	service := constructor.Call(nil)[0]
	name := strings.ToUpper(operation.Operation[:1]) + operation.Operation[1:]
	if name == "Bgm" {
		name = "BGM"
	}
	method := service.MethodByName(name)
	if !method.IsValid() {
		t.Fatalf("missing operation %s.%s", resourceName, name)
	}
	ctx := reflect.ValueOf(context.Background())
	params := reflect.ValueOf(Params{"model": "offline-model", "extension": Params{"enabled": true}})
	args := []reflect.Value{ctx}
	filePath := "/work/example.txt"
	switch operation.Resource + "." + operation.Operation {
	case "model.show":
		args = append(args, reflect.ValueOf("chat"), reflect.ValueOf("offline-model"))
	case "sandbox.create":
		args = append(args, reflect.Zero(reflect.TypeOf((*string)(nil))))
	case "sandbox.get", "sandbox.delete":
		args = append(args, reflect.ValueOf("sandbox-id"))
	case "sandbox.listFile":
		args = append(args, reflect.ValueOf("sandbox-id"), reflect.ValueOf(&filePath))
	case "sandbox.readFile", "sandbox.downloadFile":
		args = append(args, reflect.ValueOf("sandbox-id"), reflect.ValueOf(filePath))
	case "sandbox.writeFile":
		args = append(args, reflect.ValueOf("sandbox-id"), reflect.ValueOf(filePath), reflect.ValueOf("你好🌍"))
	case "sandbox.editFile":
		args = append(args, reflect.ValueOf("sandbox-id"), reflect.ValueOf(filePath), reflect.ValueOf("old"), reflect.ValueOf("new"))
	case "sandbox.uploadFile":
		args = append(args, reflect.ValueOf("sandbox-id"), reflect.ValueOf(filePath), reflect.ValueOf(strings.NewReader("upload\x00你好")))
	case "sandbox.runCode":
		args = append(args, reflect.ValueOf("sandbox-id"), reflect.ValueOf("print('hello')"), reflect.ValueOf([]Params{{"url": "https://example.invalid/data.csv", "name": "data.csv"}}))
	case "sandbox.runCommand":
		args = append(args, reflect.ValueOf("sandbox-id"), reflect.ValueOf("echo hello"), reflect.ValueOf(false))
	case "skill.categories":
	case "skill.download":
		args = append(args, reflect.ValueOf("skill/example.zip"))
	default:
		args = append(args, params)
	}
	values := method.Call(args)
	if last := values[len(values)-1]; !last.IsNil() {
		t.Fatal(last.Interface().(error))
	}
	if len(values) == 1 {
		return
	}
	switch result := values[0].Interface().(type) {
	case *Result:
		defer result.Close()
		if result.Kind == KindStream {
			count := 0
			for result.Stream.Next() {
				count++
			}
			if result.Stream.Err() != nil {
				t.Fatal(result.Stream.Err())
			}
			if count == 0 {
				t.Fatal("expected SSE events")
			}
		}
	case io.ReadCloser:
		defer result.Close()
		if _, err := io.ReadAll(result); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSharedOperationCoverage(t *testing.T) {
	for _, operation := range contractOperations(t) {
		t.Run(operation.Resource+"."+operation.Operation, func(t *testing.T) {
			var called atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called.Store(true)
				expected := strings.NewReplacer("{type}", "chat", "{code}", "offline-model", "{id}", "sandbox-id").Replace(operation.Path)
				if r.Method != operation.HTTPMethod || r.URL.EscapedPath() != "/prefix/"+expected {
					t.Errorf("got %s %s; want %s /prefix/%s", r.Method, r.URL.EscapedPath(), operation.HTTPMethod, expected)
				}
				if r.Header.Get("Authorization") != "Bearer offline-token" {
					t.Error("missing bearer authentication")
				}
				if r.Header.Get("User-Agent") != "ThinkAI-Go/"+Version {
					t.Error("missing SDK user agent")
				}
				if operation.Operation == "uploadFile" {
					if err := r.ParseMultipartForm(1 << 20); err != nil {
						t.Error(err)
						return
					}
					if r.FormValue("path") != "/work/example.txt" {
						t.Error("multipart target path lost")
					}
					file, header, err := r.FormFile("file")
					if err != nil {
						t.Error(err)
						return
					}
					defer file.Close()
					raw, _ := io.ReadAll(file)
					if header.Filename != "example.txt" || string(raw) != "upload\x00你好" {
						t.Error("multipart contents changed")
					}
				}
				switch operation.Response {
				case "sse":
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = io.WriteString(w, "data: {\"id\":\"response-id\"}\n\ndata: [DONE]\n\n")
				case "binary":
					w.Header().Set("Content-Type", "application/octet-stream")
					_, _ = w.Write([]byte{0, 1, 255})
				case "empty":
					w.WriteHeader(http.StatusNoContent)
				default:
					w.Header().Set("Content-Type", "application/json")
					_, _ = io.WriteString(w, `{"ok":true,"extension":{"retained":true}}`)
				}
			}))
			defer server.Close()
			invokeContract(t, mustClient(t, WithEndpoint(server.URL+"/prefix")), operation)
			if !called.Load() {
				t.Fatal("resource did not issue a request")
			}
		})
	}
}

func TestContentTypeAndStreamFlag(t *testing.T) {
	for _, test := range []struct {
		name              string
		params            Params
		contentType, body string
		kind              ResultKind
		wantStream        bool
	}{
		{"default-JSON", Params{"extension": "你好"}, "application/json; charset=UTF-8", `{"unknown":9007199254740993}`, KindJSON, true},
		{"false-SSE", Params{"stream": false}, "text/event-stream; charset=utf-8", "data: {\"chunk\":1}\n\n", KindStream, false},
		{"binary", Params{}, "audio/wav", "RIFF\x00wave", KindBinary, true},
		{"empty", Params{}, "application/json", "", KindEmpty, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if body["stream"] != test.wantStream {
					t.Errorf("wire stream = %v", body["stream"])
				}
				w.Header().Set("Content-Type", test.contentType)
				_, _ = io.WriteString(w, test.body)
			}))
			defer server.Close()
			original, _ := json.Marshal(test.params)
			r, err := mustClient(t, WithEndpoint(server.URL)).Chat().Completions(context.Background(), test.params)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			if r.Kind != test.kind {
				t.Fatalf("got %s, want %s", r.Kind, test.kind)
			}
			current, _ := json.Marshal(test.params)
			if !bytes.Equal(current, original) {
				t.Fatal("caller parameters were mutated")
			}
			if r.Kind == KindJSON {
				raw, err := r.AsJSON()
				if err != nil || string(raw) != test.body {
					t.Fatal("raw JSON changed")
				}
				if _, err := r.AsStream(); err == nil {
					t.Fatal("JSON converted to stream")
				}
			}
			if r.Kind == KindBinary {
				body, _ := r.AsBinary()
				raw, err := io.ReadAll(body)
				if err != nil || string(raw) != test.body {
					t.Fatal("binary bytes changed")
				}
			}
		})
	}
}

func TestErrorsNoRetryAndTLS(t *testing.T) {
	for _, status := range []int{400, 401, 403, 404, 422, 429, 500, 502, 503, 504} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				_, _ = io.WriteString(w, `{"message":"validation","details":{"field":"model"},"extension":true}`)
			}))
			defer server.Close()
			_, err := mustClient(t, WithEndpoint(server.URL)).Images().Generations(context.Background(), Params{})
			var apiErr *APIError
			if !errors.As(err, &apiErr) || apiErr.StatusCode != status || apiErr.Message != "validation" || !bytes.Contains(apiErr.Details, []byte(`"field":"model"`)) {
				t.Fatalf("error details lost: %#v", err)
			}
			if calls.Load() != 1 {
				t.Fatal("SDK retried a request")
			}
		})
	}
	tls := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer tls.Close()
	_, err := mustClient(t, WithEndpoint(tls.URL)).Model().List(context.Background(), nil)
	if err == nil {
		t.Fatal("default client accepted untrusted TLS certificate")
	}
	// Trust is configurable through an injected standard HTTP client.
	_, err = mustClient(t, WithEndpoint(tls.URL), WithHTTPClient(tls.Client())).Model().List(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
}

func TestPathAndQueryEncoding(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/model/") {
			if r.URL.EscapedPath() != "/prefix/model/chat%2Ftype/a%2Fb%20%3F%23%E4%B8%AD" {
				t.Errorf("escaped path = %s", r.URL.EscapedPath())
			}
		} else {
			if r.URL.Path != "/prefix/skill" || r.URL.Query().Get("category_id") != "A & 中" || r.URL.Query().Has("unused") {
				t.Errorf("query = %s", r.URL.String())
			}
			if r.URL.Query().Get("tag[0]") != "one" || r.URL.Query().Get("tag[1]") != "two" {
				t.Error("query array lost")
			}
			if r.URL.Query().Get("enabled") != "0" || r.URL.Query().Get("filter[q]") != "你好" || r.URL.Query().Has("skip") || r.URL.Query().Get("number") != "9007199254740993" {
				t.Errorf("nested query changed: %s", r.URL.RawQuery)
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer server.Close()
	_, err := mustClient(t, WithEndpoint(server.URL+"/prefix/")).Model().Show(context.Background(), "chat/type", "a/b ?#中")
	if err != nil {
		t.Fatal(err)
	}
	_, err = mustClient(t, WithEndpoint(server.URL+"/prefix/")).Skill().List(context.Background(), Params{"category_id": "A & 中", "unused": nil, "tag": []string{"one", "two"}, "enabled": false, "filter": Params{"q": "你好"}, "skip": nil, "number": json.Number("9007199254740993")})
	if err != nil {
		t.Fatal(err)
	}
}

func TestTimeoutAndCancellation(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		t.Run(map[bool]string{false: "headers", true: "stream"}[streaming], func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				if streaming {
					w.Header().Set("Content-Type", "text/event-stream")
					w.(http.Flusher).Flush()
				}
				<-r.Context().Done()
			}))
			defer server.Close()
			r, err := mustClient(t, WithEndpoint(server.URL), WithTimeout(50*time.Millisecond)).Chat().Completions(context.Background(), nil)
			if streaming {
				if err != nil {
					t.Fatal(err)
				}
				defer r.Close()
				if r.Stream.Next() {
					t.Fatal("unexpected event")
				}
				err = r.Stream.Err()
			}
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("expected deadline exceeded, got %v", err)
			}
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	r, err := mustClient(t, WithEndpoint(server.URL)).Chat().Completions(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if r.Stream.Next() || !errors.Is(r.Stream.Err(), context.Canceled) {
		t.Fatalf("expected canceled stream, got %v", r.Stream.Err())
	}
	_ = r.Close()
	// Closing a live response also releases a blocked reader and the connection.
	r, err = mustClient(t, WithEndpoint(server.URL)).Chat().Completions(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { r.Stream.Next(); close(done) }()
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Close did not unblock Next")
	}
}

func TestInvalidJSONAndOptions(t *testing.T) {
	for _, option := range []Option{WithEndpoint("relative"), WithEndpoint("ftp://host"), WithEndpoint("https://host/?query=1"), WithTimeout(0), WithHTTPClient(nil), nil} {
		if _, err := NewClient("offline", option); err == nil {
			t.Fatal("invalid option accepted")
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, "{broken")
	}))
	defer server.Close()
	c := mustClient(t, WithEndpoint(server.URL))
	if _, err := c.Model().List(context.Background(), nil); err == nil {
		t.Fatal("invalid JSON accepted")
	}
	if _, err := c.Model().List(nil, nil); err == nil {
		t.Fatal("nil context accepted")
	}
	if _, err := c.Images().Generations(context.Background(), Params{"unsupported": make(chan int)}); err == nil {
		t.Fatal("JSON encoding error swallowed")
	}
}
