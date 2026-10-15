package thinkai

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestBufferedBinaryHonorsDeadlineAndCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write([]byte{0, 1, 2, 255})
	}))
	defer server.Close()
	for _, testCase := range []string{"deadline", "cancel"} {
		t.Run(testCase, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			body, err := mustClient(t, WithEndpoint(server.URL), WithTimeout(50*time.Millisecond)).Sandbox().DownloadFile(ctx, "sandbox-id", "fixture.bin")
			if err != nil {
				t.Fatal(err)
			}
			defer body.Close()
			want := context.DeadlineExceeded
			if testCase == "cancel" {
				cancel()
				want = context.Canceled
			} else {
				time.Sleep(80 * time.Millisecond)
			}
			raw, err := io.ReadAll(body)
			if len(raw) != 0 || !errors.Is(err, want) {
				t.Fatalf("buffered binary bypassed %s: bytes=%v,error=%v", testCase, raw, err)
			}
		})
	}
}

type httpDoFunc func(*http.Request) (*http.Response, error)

func (f httpDoFunc) Do(r *http.Request) (*http.Response, error) { return f(r) }

type slowBinaryBody struct{ closed atomic.Bool }

func (b *slowBinaryBody) Read(p []byte) (int, error) {
	time.Sleep(40 * time.Millisecond)
	return copy(p, []byte{1, 2, 3}), io.EOF
}
func (b *slowBinaryBody) Close() error { b.closed.Store(true); return nil }

func TestBinaryDeadlineAfterUnderlyingRead(t *testing.T) {
	body := &slowBinaryBody{}
	transport := httpDoFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/octet-stream"}}, Body: body, ContentLength: 3}, nil
	})
	download, err := mustClient(t, WithHTTPClient(transport), WithTimeout(20*time.Millisecond)).Skill().Download(context.Background(), "fixture.bin")
	if err != nil {
		t.Fatal(err)
	}
	defer download.Close()
	raw, err := io.ReadAll(download)
	if len(raw) != 0 || !errors.Is(err, context.DeadlineExceeded) || !body.closed.Load() {
		t.Fatalf("late underlying read bypassed deadline: bytes=%v,error=%v,closed=%v", raw, err, body.closed.Load())
	}
}
