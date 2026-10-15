package thinkai

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
)

// Event preserves the complete JSON payload and SSE event metadata. Business
// error events are delivered unchanged; applications decide how to handle them.
type Event struct {
	Type  string
	ID    string
	Retry string
	Data  json.RawMessage
}

func (e Event) Decode(target any) error { return json.Unmarshal(e.Data, target) }

// StreamError reports malformed JSON in an SSE data event and retains its text.
type StreamError struct {
	EventType string
	Data      string
}

func (e *StreamError) Error() string {
	return fmt.Sprintf("thinkai: invalid JSON in SSE event %q", e.EventType)
}

// Stream reads SSE events incrementally, handling fragmented UTF-8, LF/CRLF,
// comments, multiple data lines, event names, and the [DONE] sentinel. Next is
// single-reader; Close may be called concurrently to interrupt a blocked Next.
type Stream struct {
	body      io.ReadCloser
	reader    *bufio.Reader
	ctx       context.Context
	event     Event
	err       error
	firstLine bool
	lastID    string
	eof       bool
	closed    atomic.Bool
	closeOnce sync.Once
	closeErr  error
}

func newStream(body io.ReadCloser, ctx context.Context) *Stream {
	return &Stream{body: body, reader: bufio.NewReader(body), ctx: ctx, firstLine: true}
}

// Next advances to the next JSON event. It returns false on EOF, [DONE], Close,
// or a parsing/transport error. Always inspect Err after the iteration.
func (s *Stream) Next() bool {
	if s.closed.Load() || s.err != nil {
		return false
	}
	if s.contextError() {
		return false
	}
	if s.eof {
		s.err = io.ErrUnexpectedEOF
		_ = s.Close()
		return false
	}
	event := Event{ID: s.lastID}
	var data []string
	for {
		line, readErr := s.reader.ReadString('\n')
		if s.closed.Load() {
			return false
		}
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if s.firstLine {
			line = strings.TrimPrefix(line, "\xef\xbb\xbf")
			s.firstLine = false
		}
		if readErr != nil && readErr != io.EOF {
			s.err = readErr
			if s.ctx.Err() != nil {
				s.err = s.ctx.Err()
			}
			_ = s.Close()
			return false
		}
		if line == "" {
			if len(data) > 0 {
				return s.deliver(event, data)
			}
			event = Event{ID: s.lastID}
		} else if !strings.HasPrefix(line, ":") {
			field, value, _ := strings.Cut(line, ":")
			value = strings.TrimPrefix(value, " ")
			switch field {
			case "data":
				data = append(data, value)
			case "event":
				event.Type = value
			case "id":
				if !strings.ContainsRune(value, '\x00') {
					event.ID, s.lastID = value, value
				}
			case "retry":
				event.Retry = value
			}
		}
		if readErr == io.EOF {
			s.eof = true
			if len(data) > 0 {
				return s.deliver(event, data)
			}
			s.err = io.ErrUnexpectedEOF
			_ = s.Close()
			return false
		}
	}
}

func (s *Stream) deliver(event Event, lines []string) bool {
	if s.closed.Load() || s.contextError() {
		return false
	}
	data := strings.Join(lines, "\n")
	if strings.TrimSpace(data) == "[DONE]" {
		_ = s.Close()
		return false
	}
	if !json.Valid([]byte(data)) {
		s.err = &StreamError{EventType: event.Type, Data: data}
		_ = s.Close()
		return false
	}
	event.Data = json.RawMessage(data)
	s.event = event
	return true
}

func (s *Stream) contextError() bool {
	if err := s.ctx.Err(); err != nil {
		s.err = err
		_ = s.Close()
		return true
	}
	return false
}

func (s *Stream) Event() Event { return s.event }
func (s *Stream) Err() error   { return s.err }

func (s *Stream) Close() error {
	s.closeOnce.Do(func() { s.closed.Store(true); s.closeErr = s.body.Close() })
	return s.closeErr
}
