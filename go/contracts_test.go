package thinkai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func startContractServer(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("Node.js is required for shared HTTP contract tests")
	}
	serverPath, err := filepath.Abs("../tests/contracts/server.mjs")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(serverPath); os.IsNotExist(err) {
		t.Skip("shared contract server is available in the SDK monorepo")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	cmd := exec.CommandContext(ctx, "node", serverPath)
	cmd.Env = append(os.Environ(), "PORT=0")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); _ = cmd.Wait() })
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatalf("contract server startup: %v", err)
	}
	var config struct {
		Endpoint string `json:"endpoint"`
	}
	if err := json.Unmarshal([]byte(line), &config); err != nil || config.Endpoint == "" {
		t.Fatalf("invalid server endpoint: %s", line)
	}
	return config.Endpoint
}

func TestContractHTTPIntegration(t *testing.T) {
	endpoint := startContractServer(t)
	c := mustClient(t, WithEndpoint(strings.TrimSuffix(endpoint, "/")+"/prefix/"))
	for _, operation := range contractOperations(t) {
		t.Run(operation.Resource+"."+operation.Operation, func(t *testing.T) { invokeContract(t, c, operation) })
	}
	response, err := http.Get(endpoint + "__requests")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var entries []struct {
		Method      string `json:"method"`
		Path        string `json:"path"`
		Body        Params `json:"body"`
		Query       Params `json:"query"`
		ContentType string `json:"content_type"`
		RawBase64   string `json:"raw_base64"`
	}
	if err := json.NewDecoder(response.Body).Decode(&entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 37 {
		t.Fatalf("expected 37 actual HTTP requests, got %d", len(entries))
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Path, "/prefix/") {
			t.Fatal("endpoint prefix lost")
		}
		if entry.Path == "/prefix/chat/completions" && entry.Body["stream"] != true {
			t.Fatal("missing default stream in actual request")
		}
		if strings.HasSuffix(entry.Path, "/code") {
			files, ok := entry.Body["files"].([]any)
			if !ok || len(files) != 1 {
				t.Fatal("code files were not sent as an object array")
			}
			file, ok := files[0].(map[string]any)
			if !ok || file["name"] != "data.csv" || file["url"] != "https://example.invalid/data.csv" {
				t.Fatal("code file objects changed")
			}
		}
		if strings.HasSuffix(entry.Path, "/upload") {
			raw, err := base64.StdEncoding.DecodeString(entry.RawBase64)
			if err != nil || !strings.Contains(entry.ContentType, "multipart/form-data; boundary=") || !bytes.Contains(raw, []byte("upload\x00你好")) {
				t.Fatal("actual HTTP multipart contents changed")
			}
		}
	}
	for _, testCase := range []string{"fragmented-sse", "responses-error", "audio-sse"} {
		t.Run(testCase, func(t *testing.T) {
			var r *Result
			var err error
			params := Params{"__case": testCase}
			switch testCase {
			case "responses-error":
				r, err = c.Responses().Create(context.Background(), params)
			case "audio-sse":
				r, err = c.Audio().Speech(context.Background(), params)
			default:
				r, err = c.Chat().Completions(context.Background(), params)
			}
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			s, err := r.AsStream()
			if err != nil {
				t.Fatal(err)
			}
			var events []string
			for s.Next() {
				events = append(events, string(s.Event().Data))
			}
			if s.Err() != nil {
				t.Fatal(s.Err())
			}
			want := 2
			if testCase == "responses-error" {
				want = 4
			}
			if testCase == "audio-sse" {
				want = 3
			}
			if len(events) != want {
				t.Fatalf("got %d events, want %d", len(events), want)
			}
			decode := func(index int) Params {
				var event Params
				if err := json.Unmarshal([]byte(events[index]), &event); err != nil {
					t.Fatal(err)
				}
				return event
			}
			switch testCase {
			case "fragmented-sse":
				first, last := decode(0), decode(1)
				delta, ok := first["delta"].(map[string]any)
				if !ok || delta["content"] != "你好🌍" || first["choices"] != nil {
					t.Fatalf("native Chat delta changed: %s", events[0])
				}
				usage, ok := last["usage"].(map[string]any)
				if !ok || usage["total_tokens"] != float64(2) || last["finish_reason"] != "stop" {
					t.Fatalf("Chat usage changed: %s", events[1])
				}
			case "responses-error":
				first, failed, stats, last := decode(0), decode(1), decode(2), decode(3)
				chunk, ok := first["chunks"].(map[string]any)
				if !ok || chunk["index"] != float64(0) || chunk["content"] != "你好🌍" {
					t.Fatalf("native Responses chunks object changed: %s", events[0])
				}
				failure, ok := failed["chunks"].(map[string]any)
				if !ok || failure["error"] != "Offline event error" {
					t.Fatalf("Responses business error changed: %s", events[1])
				}
				usage, ok := stats["stats"].(map[string]any)
				if !ok || usage["usage"] != float64(2) || usage["latency"] != float64(1) || last["id"] != "offline-response" {
					t.Fatal("Responses stats/id changed")
				}
			case "audio-sse":
				for index, data := range []string{"AAEC", "/w=="} {
					audio, ok := decode(index)["audio"].(map[string]any)
					if !ok || audio["type"] != "audio/x-wav" || audio["data"] != data {
						t.Fatalf("native audio event changed: %s", events[index])
					}
				}
				last := decode(2)
				sentences, ok := last["sentences"].([]any)
				if !ok || len(sentences) != 0 {
					t.Fatal("audio final sentences lost")
				}
				usage, ok := last["usage"].(map[string]any)
				if !ok || usage["prompt_tokens"] != float64(1) || usage["completion_tokens"] != float64(0) || usage["total_tokens"] != float64(1) {
					t.Fatal("audio final usage lost")
				}
			}
		})
	}
	t.Run("content-type-overrides-flag", func(t *testing.T) {
		r, err := c.Chat().Completions(context.Background(), Params{"__case": "json"})
		if err != nil {
			t.Fatal(err)
		}
		defer r.Close()
		if _, err := r.AsJSON(); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("binary-audio-and-download", func(t *testing.T) {
		r, err := c.Audio().Speech(context.Background(), Params{"__case": "binary"})
		if err != nil {
			t.Fatal(err)
		}
		defer r.Close()
		body, err := r.AsBinary()
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(body)
		if err != nil || !bytes.Equal(raw, []byte{0, 1, 2, 255, 10, 13, 80, 75}) {
			t.Fatal("audio bytes changed")
		}
	})
	t.Run("JSON-file-download-is-raw", func(t *testing.T) {
		body, err := c.Sandbox().DownloadFile(context.Background(), "sandbox-id", "fixture.json")
		if err != nil {
			t.Fatal(err)
		}
		defer body.Close()
		raw, err := io.ReadAll(body)
		if err != nil || string(raw) != "{ \"file\": true }\n" {
			t.Fatalf("JSON file bytes changed: %q, %v", raw, err)
		}
	})
	t.Run("invalid-sse", func(t *testing.T) {
		r, err := c.Chat().Completions(context.Background(), Params{"__case": "invalid-sse"})
		if err != nil {
			t.Fatal(err)
		}
		defer r.Close()
		if r.Stream.Next() {
			t.Fatal("invalid SSE accepted")
		}
		var streamErr *StreamError
		if !errors.As(r.Stream.Err(), &streamErr) {
			t.Fatalf("expected parse error: %v", r.Stream.Err())
		}
	})
	t.Run("disconnect", func(t *testing.T) {
		r, err := c.Chat().Completions(context.Background(), Params{"__case": "disconnect"})
		if err != nil {
			t.Fatal(err)
		}
		defer r.Close()
		if r.Stream.Next() || r.Stream.Err() == nil {
			t.Fatal("disconnect not surfaced")
		}
	})
	for _, testCase := range []string{"wait-success", "wait-fail", "wait-error", "wait-timeout"} {
		t.Run(testCase, func(t *testing.T) {
			raw, err := c.Avatar().Video(context.Background(), Params{"model": "offline-model", "__case": testCase}, WaitOptions{Enabled: true, Timeout: 80 * time.Millisecond, PollInterval: 5 * time.Millisecond})
			switch testCase {
			case "wait-error":
				var apiErr *APIError
				if !errors.As(err, &apiErr) || apiErr.StatusCode != 403 {
					t.Fatalf("query error swallowed: %v", err)
				}
			case "wait-timeout":
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("expected wait deadline: %v", err)
				}
			default:
				if err != nil {
					t.Fatal(err)
				}
				wantStatus := "success"
				if testCase == "wait-fail" {
					wantStatus = "fail"
				}
				var result struct {
					Status string `json:"status"`
				}
				if json.Unmarshal(raw, &result) != nil || result.Status != wantStatus {
					t.Fatalf("terminal task changed: %s", raw)
				}
			}
		})
	}
}
