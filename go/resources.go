package thinkai

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"path"
	"strings"
	"time"
)

type ChatService struct{ client *Client }
type ResponsesService struct{ client *Client }
type ImagesService struct{ client *Client }
type VideosService struct{ client *Client }
type AudioService struct{ client *Client }
type AvatarService struct{ client *Client }
type MusicService struct{ client *Client }
type EmbeddingsService struct{ client *Client }
type RerankService struct{ client *Client }
type DecisionService struct{ client *Client }
type PluginService struct{ client *Client }
type ModelService struct{ client *Client }
type SandboxService struct{ client *Client }
type SkillService struct{ client *Client }

func (c *Client) Chat() *ChatService             { return &ChatService{c} }
func (c *Client) Responses() *ResponsesService   { return &ResponsesService{c} }
func (c *Client) Images() *ImagesService         { return &ImagesService{c} }
func (c *Client) Videos() *VideosService         { return &VideosService{c} }
func (c *Client) Audio() *AudioService           { return &AudioService{c} }
func (c *Client) Avatar() *AvatarService         { return &AvatarService{c} }
func (c *Client) Music() *MusicService           { return &MusicService{c} }
func (c *Client) Embeddings() *EmbeddingsService { return &EmbeddingsService{c} }
func (c *Client) Rerank() *RerankService         { return &RerankService{c} }
func (c *Client) Decision() *DecisionService     { return &DecisionService{c} }
func (c *Client) Plugin() *PluginService         { return &PluginService{c} }
func (c *Client) Model() *ModelService           { return &ModelService{c} }
func (c *Client) Sandbox() *SandboxService       { return &SandboxService{c} }
func (c *Client) Skill() *SkillService           { return &SkillService{c} }

// Completions defaults the wire stream parameter to true without modifying the
// caller's map. The returned Kind always follows the actual Content-Type.
func (s *ChatService) Completions(ctx context.Context, params Params) (*Result, error) {
	copy := make(Params, len(params)+1)
	for k, v := range params {
		copy[k] = v
	}
	if _, exists := copy["stream"]; !exists {
		copy["stream"] = true
	}
	return s.client.jsonRequest(ctx, http.MethodPost, "chat/completions", nil, copy)
}

func (s *ResponsesService) Create(ctx context.Context, params Params) (*Result, error) {
	return s.client.jsonRequest(ctx, http.MethodPost, "responses", nil, params)
}

func (s *ImagesService) Generations(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "images/generations", nil, params)
}
func (s *ImagesService) Inpainting(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "images/inpainting", nil, params)
}
func (s *ImagesService) Outpainting(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "images/outpainting", nil, params)
}
func (s *ImagesService) Upscale(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "images/upscale", nil, params)
}
func (s *ImagesService) Poster(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "images/poster", nil, params)
}
func (s *ImagesService) Edit(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "images/edit", nil, params)
}
func (s *VideosService) Generations(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "videos/generations", nil, params)
}
func (s *VideosService) Query(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "videos/query", nil, params)
}
func (s *AudioService) Speech(ctx context.Context, params Params) (*Result, error) {
	return s.client.jsonRequest(ctx, http.MethodPost, "audio/speech", nil, params)
}
func (s *AudioService) Transcriptions(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "audio/transcriptions", nil, params)
}

// WaitOptions controls Avatar.Video polling. The zero value does not wait.
// Enabled uses a 300-second wait deadline and a 5-second polling interval
// unless overridden. Query failures are returned immediately without retries.
type WaitOptions struct {
	Enabled      bool
	Timeout      time.Duration
	PollInterval time.Duration
}

func (s *AvatarService) Video(ctx context.Context, params Params, options ...WaitOptions) (json.RawMessage, error) {
	if len(options) > 1 {
		return nil, errors.New("thinkai: only one WaitOptions value is accepted")
	}
	wait := WaitOptions{}
	if len(options) == 1 {
		wait = options[0]
	}
	if wait.Timeout < 0 || wait.PollInterval < 0 {
		return nil, errors.New("thinkai: wait durations must not be negative")
	}
	if wait.Enabled {
		if ctx == nil {
			return nil, errors.New("thinkai: context must not be nil")
		}
		if wait.Timeout == 0 {
			wait.Timeout = DefaultTimeout
		}
		if wait.PollInterval == 0 {
			wait.PollInterval = 5 * time.Second
		}
	}
	created, err := s.client.json(ctx, http.MethodPost, "avatar/video", nil, params)
	if err != nil || !wait.Enabled {
		return created, err
	}
	var task map[string]json.RawMessage
	if json.Unmarshal(created, &task) != nil || len(task["id"]) == 0 || string(task["id"]) == "null" {
		return nil, &ProtocolError{Message: "avatar response has no task id", RawBody: created}
	}
	originalID := append(json.RawMessage(nil), task["id"]...)
	ctx, cancel := context.WithTimeout(ctx, wait.Timeout)
	defer cancel()
	for {
		result, err := s.Query(ctx, Params{"model": params["model"], "id": originalID})
		if err != nil {
			return nil, err
		}
		var status struct {
			Status string `json:"status"`
		}
		if err := json.Unmarshal(result, &status); err != nil {
			return nil, err
		}
		if status.Status == "success" || status.Status == "fail" {
			return result, nil
		}
		if status.Status != "processing" {
			return nil, &ProtocolError{Message: "unknown or missing avatar status", RawBody: result}
		}
		timer := time.NewTimer(wait.PollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func (s *AvatarService) Query(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "avatar/query", nil, params)
}
func (s *MusicService) Song(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "music/song", nil, params)
}
func (s *MusicService) BGM(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "music/bgm", nil, params)
}
func (s *MusicService) Query(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "music/query", nil, params)
}
func (s *EmbeddingsService) Create(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "embeddings", nil, params)
}
func (s *RerankService) Create(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "rerank", nil, params)
}
func (s *DecisionService) Evaluate(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "decisions", nil, params)
}
func (s *PluginService) List(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodGet, "plugin", params, nil)
}
func (s *ModelService) List(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodGet, "model", params, nil)
}
func (s *ModelService) Show(ctx context.Context, modelType, code string) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodGet, "model/"+segment(modelType)+"/"+segment(code), nil, nil)
}
func (s *SandboxService) Create(ctx context.Context, name *string) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "sandbox", nil, Params{"name": name})
}
func (s *SandboxService) Get(ctx context.Context, name string) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodGet, "sandbox/"+segment(name), nil, nil)
}
func (s *SandboxService) Delete(ctx context.Context, name string) error {
	r, err := s.client.jsonRequest(ctx, http.MethodDelete, "sandbox/"+segment(name), nil, nil)
	if err == nil {
		return r.Close()
	}
	return err
}
func (s *SandboxService) ListFile(ctx context.Context, id string, filePath *string) (json.RawMessage, error) {
	var value any
	if filePath != nil {
		value = *filePath
	}
	return s.client.json(ctx, http.MethodGet, "sandbox/"+segment(id)+"/list", Params{"path": value}, nil)
}
func (s *SandboxService) ReadFile(ctx context.Context, id, filePath string) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodGet, "sandbox/"+segment(id)+"/read", Params{"path": filePath}, nil)
}
func (s *SandboxService) WriteFile(ctx context.Context, id, filePath, content string) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "sandbox/"+segment(id)+"/write", nil, Params{"path": filePath, "content": content})
}
func (s *SandboxService) EditFile(ctx context.Context, id, filePath, oldStr, newStr string) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodPost, "sandbox/"+segment(id)+"/edit", nil, Params{"path": filePath, "old_str": oldStr, "new_str": newStr})
}

// UploadFile sends the target path and a multipart file without buffering the
// entire input. The caller owns file and must close it if applicable.
func (s *SandboxService) UploadFile(ctx context.Context, id, filePath string, file io.Reader) (json.RawMessage, error) {
	if file == nil {
		return nil, errors.New("thinkai: upload reader must not be nil")
	}
	reader, writer := io.Pipe()
	defer reader.Close()
	multipartWriter := multipart.NewWriter(writer)
	contentType := multipartWriter.FormDataContentType()
	go func() {
		err := multipartWriter.WriteField("path", filePath)
		if err == nil {
			var part io.Writer
			part, err = multipartWriter.CreateFormFile("file", path.Base(strings.ReplaceAll(filePath, "\\", "/")))
			if err == nil {
				_, err = io.Copy(part, file)
			}
		}
		if err == nil {
			err = multipartWriter.Close()
		}
		_ = writer.CloseWithError(err)
	}()
	r, err := s.client.request(ctx, http.MethodPost, "sandbox/"+segment(id)+"/upload", nil, reader, contentType, false)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	if r.Kind == KindEmpty {
		return nil, nil
	}
	return r.AsJSON()
}
func (s *SandboxService) DownloadFile(ctx context.Context, id, filePath string) (io.ReadCloser, error) {
	return s.client.download(ctx, "sandbox/"+segment(id)+"/download", Params{"path": filePath})
}
func (s *SandboxService) RunCode(ctx context.Context, id, code string, files []Params) (json.RawMessage, error) {
	if files == nil {
		files = []Params{}
	}
	return s.client.json(ctx, http.MethodPost, "sandbox/"+segment(id)+"/code", nil, Params{"code": code, "files": files})
}
func (s *SandboxService) RunCommand(ctx context.Context, id, command string, stream bool) (*Result, error) {
	return s.client.jsonRequest(ctx, http.MethodPost, "sandbox/"+segment(id)+"/command", nil, Params{"command": command, "stream": stream})
}
func (s *SkillService) List(ctx context.Context, params Params) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodGet, "skill", params, nil)
}
func (s *SkillService) Categories(ctx context.Context) (json.RawMessage, error) {
	return s.client.json(ctx, http.MethodGet, "skill/category", nil, nil)
}
func (s *SkillService) Download(ctx context.Context, filePath string) (io.ReadCloser, error) {
	return s.client.download(ctx, "skill/download", Params{"path": filePath})
}
