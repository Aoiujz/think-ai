package thinkai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestAvatarWaitStartsAfterCreateAndUsesOriginalID(t *testing.T) {
	var queries atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/video") {
			time.Sleep(120 * time.Millisecond)
			_, _ = io.WriteString(w, `{"id":"original","status":"processing"}`)
			return
		}
		var params Params
		if err := json.NewDecoder(r.Body).Decode(&params); err != nil {
			t.Error(err)
		}
		if params["id"] != "original" || params["model"] != "original-model" {
			t.Errorf("poll target changed: %+v", params)
		}
		if queries.Add(1) == 1 {
			_, _ = io.WriteString(w, `{"id":"different","status":"processing"}`)
		} else {
			_, _ = io.WriteString(w, `{"id":"different","status":"success","extension":true}`)
		}
	}))
	defer server.Close()
	raw, err := mustClient(t, WithEndpoint(server.URL)).Avatar().Video(context.Background(), Params{"model": "original-model"}, WaitOptions{Enabled: true, Timeout: 80 * time.Millisecond, PollInterval: time.Millisecond})
	if err != nil || !strings.Contains(string(raw), `"extension":true`) || queries.Load() != 2 {
		t.Fatalf("wait result %s, error %v", raw, err)
	}
}

func TestAvatarInvalidStatusRetainsResponse(t *testing.T) {
	for _, response := range []string{`{}`, `{"status":"unknown","extension":true}`} {
		t.Run(response, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if strings.HasSuffix(r.URL.Path, "/video") {
					_, _ = io.WriteString(w, `{"id":"task-id"}`)
				} else {
					_, _ = io.WriteString(w, response)
				}
			}))
			defer server.Close()
			_, err := mustClient(t, WithEndpoint(server.URL)).Avatar().Video(context.Background(), nil, WaitOptions{Enabled: true})
			var protocolError *ProtocolError
			if !errors.As(err, &protocolError) || string(protocolError.RawBody) != response {
				t.Fatalf("protocol response lost: %v", err)
			}
		})
	}
}

func TestAvatarDoesNotWaitByDefault(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"task-id","status":"processing"}`)
	}))
	defer server.Close()
	_, err := mustClient(t, WithEndpoint(server.URL)).Avatar().Video(context.Background(), nil)
	if err != nil || calls.Load() != 1 {
		t.Fatalf("default unexpectedly polled: %v, %d calls", err, calls.Load())
	}
}
