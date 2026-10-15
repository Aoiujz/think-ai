package thinkai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

type oneByteReader struct{ io.Reader }

func (r oneByteReader) Read(p []byte) (int, error) { return r.Reader.Read(p[:1]) }

func TestSSEFragmentationAndBusinessEvents(t *testing.T) {
	payload := "\xef\xbb\xbf: heartbeat\r\nretry: 500\r\nid: event-1\r\nevent: message\r\ndata: {\r\ndata: \"text\":\"你好🌍\",\"extension\":9007199254740993}\r\n\r\n" +
		"event: error\ndata: {\"error\":{\"message\":\"provider error\"}}\n\n" +
		"data: {\"chunks\":[{\"error\":\"business error\"}]}\n\n" +
		"data: [DONE]\n\ndata: {\"ignored\":true}\n\n"
	s := newStream(io.NopCloser(oneByteReader{strings.NewReader(payload)}), context.Background())
	defer s.Close()
	var events []Event
	for s.Next() {
		events = append(events, s.Event())
	}
	if s.Err() != nil {
		t.Fatal(s.Err())
	}
	if len(events) != 3 {
		t.Fatalf("got %d events", len(events))
	}
	if events[0].Type != "message" || events[0].ID != "event-1" || events[0].Retry != "500" {
		t.Fatalf("metadata lost: %+v", events[0])
	}
	var first map[string]json.RawMessage
	if err := events[0].Decode(&first); err != nil {
		t.Fatal(err)
	}
	if string(first["text"]) != `"你好🌍"` || string(first["extension"]) != "9007199254740993" {
		t.Fatal("JSON data changed")
	}
	if events[1].Type != "error" || events[1].ID != "event-1" || !strings.Contains(string(events[1].Data), "provider error") || !strings.Contains(string(events[2].Data), "business error") {
		t.Fatal("business error events were not retained")
	}
}

func TestSSELargeEventsEOFAndInvalidJSON(t *testing.T) {
	data := `{"text":"` + strings.Repeat("x", 128*1024) + `"}`
	s := newStream(io.NopCloser(strings.NewReader("data: "+data)), context.Background())
	if !s.Next() || string(s.Event().Data) != data {
		t.Fatal("large event or EOF event lost")
	}
	if s.Next() || !errors.Is(s.Err(), io.ErrUnexpectedEOF) {
		t.Fatalf("missing DONE must report an interrupted stream: %v", s.Err())
	}
	s = newStream(io.NopCloser(strings.NewReader("event: broken\ndata: {bad}\n\n")), context.Background())
	if s.Next() {
		t.Fatal("invalid SSE JSON accepted")
	}
	var streamErr *StreamError
	if !errors.As(s.Err(), &streamErr) || streamErr.Data != "{bad}" || streamErr.EventType != "broken" {
		t.Fatalf("parse error details lost: %v", s.Err())
	}
	s = newStream(io.NopCloser(strings.NewReader(": comment\n\nevent: ignored\n\n")), context.Background())
	if s.Next() || !errors.Is(s.Err(), io.ErrUnexpectedEOF) {
		t.Fatal("comments produced an event")
	}
}

type interruptedReader struct{ sent bool }

func (r *interruptedReader) Read(p []byte) (int, error) {
	if !r.sent {
		r.sent = true
		return copy(p, "data: {\"partial\":"), nil
	}
	return 0, io.ErrUnexpectedEOF
}

func TestSSEDisconnectRemainsTransportError(t *testing.T) {
	s := newStream(io.NopCloser(&interruptedReader{}), context.Background())
	if s.Next() || !errors.Is(s.Err(), io.ErrUnexpectedEOF) {
		t.Fatalf("transport error changed: %v", s.Err())
	}
}

func TestSSEDeadlineAppliesToBufferedEvents(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"first\":true}\n\ndata: {\"second\":true}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	r, err := mustClient(t, WithEndpoint(server.URL), WithTimeout(50*time.Millisecond)).Chat().Completions(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if !r.Stream.Next() {
		t.Fatal("first event missing")
	}
	time.Sleep(80 * time.Millisecond)
	if r.Stream.Next() || !errors.Is(r.Stream.Err(), context.DeadlineExceeded) {
		t.Fatalf("buffered event bypassed deadline: %v", r.Stream.Err())
	}
}

type eofReader struct{ io.Reader }

func (r eofReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	if n > 0 {
		err = io.EOF
	}
	return n, err
}

func TestSSEContentLengthEOFDoesNotCancelValidEvents(t *testing.T) {
	const payload = "data: {\"first\":true}\n\ndata: {\"second\":true}\n\ndata: [DONE]\n\n"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		_, _ = io.WriteString(w, payload)
	}))
	defer server.Close()
	for _, testCase := range []string{"fixed-content-length-http", "bytes-and-EOF-together"} {
		t.Run(testCase, func(t *testing.T) {
			options := []Option{WithEndpoint(server.URL)}
			if testCase == "bytes-and-EOF-together" {
				options = append(options, WithHTTPClient(httpDoFunc(func(r *http.Request) (*http.Response, error) {
					return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, ContentLength: int64(len(payload)), Body: io.NopCloser(eofReader{strings.NewReader(payload)})}, nil
				})))
			}
			r, err := mustClient(t, options...).Chat().Completions(context.Background(), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			count := 0
			for r.Stream.Next() {
				count++
			}
			if count != 2 || r.Stream.Err() != nil {
				t.Fatalf("complete SSE mistaken for cancellation: events=%d,error=%v", count, r.Stream.Err())
			}
		})
	}
}
