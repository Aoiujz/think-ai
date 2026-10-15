package tests

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestGitModuleDownload uses the actual Go downloader against a temporary local
// Git repository. It verifies that PHP's root export-ignore does not remove the
// Go module, without publishing tags or contacting a remote registry.
func TestGitModuleDownload(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("Git is required for module distribution regression")
	}
	moduleDir, err := filepath.Abs("..")
	if err != nil {
		t.Fatal(err)
	}
	attributes, err := os.ReadFile(filepath.Join(moduleDir, "..", ".gitattributes"))
	if os.IsNotExist(err) {
		t.Skip("root distribution attributes are available in the SDK monorepo")
	}
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(attributes, []byte("/go export-ignore")) {
		t.Fatal("expected PHP distribution to exclude /go")
	}
	workspace := t.TempDir()
	repository := filepath.Join(workspace, "repository")
	if err := os.MkdirAll(repository, 0755); err != nil {
		t.Fatal(err)
	}
	copyTree(t, moduleDir, filepath.Join(repository, "go"))
	writeFile(t, filepath.Join(repository, ".gitattributes"), attributes)
	writeFile(t, filepath.Join(repository, "php", "sentinel.php"), []byte("<?php // PHP only\n"))
	writeFile(t, filepath.Join(repository, "python", "sentinel.py"), []byte("# Python only\n"))
	writeFile(t, filepath.Join(repository, "typescript", "sentinel.ts"), []byte("// TypeScript only\n"))
	configPath := filepath.Join(workspace, "gitconfig")
	writeFile(t, configPath, nil)
	baseEnv := append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+configPath, "GIT_TERMINAL_PROMPT=0")
	run(t, repository, baseEnv, "git", "init", "--quiet")
	run(t, repository, baseEnv, "git", "add", ".")
	run(t, repository, baseEnv, "git", "-c", "user.name=ThinkAI Offline Tests", "-c", "user.email=offline@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "temporary distribution fixture")
	run(t, repository, baseEnv, "git", "tag", "go/v0.1.0")
	run(t, repository, baseEnv, "git", "update-server-info")
	// A normal root Git archive obeys export-ignore and excludes Go.
	phpArchive := filepath.Join(workspace, "php-dist.zip")
	run(t, repository, baseEnv, "git", "archive", "--format=zip", "--output="+phpArchive, "HEAD")
	rootZip, err := zip.OpenReader(phpArchive)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range rootZip.File {
		if strings.HasPrefix(file.Name, "go/") {
			t.Fatal("PHP root archive contains Go SDK")
		}
	}
	_ = rootZip.Close()
	// Git's dumb HTTP transport serves only this temporary repository. A scoped
	// URL rewrite redirects the Go command's GitHub source URL to the local server.
	server := httptest.NewServer(http.StripPrefix("/repo.git/", http.FileServer(http.Dir(filepath.Join(repository, ".git")))))
	defer server.Close()
	gitConfig := "[url \"" + server.URL + "/repo.git\"]\n\tinsteadOf = https://github.com/top-think/think-ai\n\tinsteadOf = https://github.com/top-think/think-ai.git\n"
	writeFile(t, configPath, []byte(gitConfig))
	consumer := filepath.Join(workspace, "consumer")
	if err := os.MkdirAll(consumer, 0755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(consumer, "go.mod"), []byte("module example.invalid/consumer\n\ngo 1.26.0\n\nrequire github.com/top-think/think-ai/go v0.1.0\n"))
	writeFile(t, filepath.Join(consumer, "main.go"), []byte("package main\nimport thinkai \"github.com/top-think/think-ai/go\"\nfunc main(){ _, _ = thinkai.NewClient(\"offline\") }\n"))
	env := append(baseEnv, "GOWORK=off", "GOENV=off", "GOTOOLCHAIN=local", "GOPROXY=direct", "GOSUMDB=off", "GOPRIVATE=github.com/top-think/think-ai", "GONOPROXY=*", "GONOSUMDB=*", "GOVCS=*:git", "GOMODCACHE="+filepath.Join(workspace, "modcache"))
	output := run(t, consumer, env, "go", "mod", "download", "-json", "github.com/top-think/think-ai/go@v0.1.0")
	var downloaded struct {
		Zip   string
		Dir   string
		Error string
	}
	if err := json.Unmarshal(output, &downloaded); err != nil || downloaded.Error != "" || downloaded.Zip == "" {
		t.Fatalf("module download failed: %s", output)
	}
	moduleZip, err := zip.OpenReader(downloaded.Zip)
	if err != nil {
		t.Fatal(err)
	}
	defer moduleZip.Close()
	prefix := "github.com/top-think/think-ai/go@v0.1.0/"
	files := make(map[string]bool)
	for _, file := range moduleZip.File {
		if !strings.HasPrefix(file.Name, prefix) {
			t.Fatalf("unexpected module zip path %s", file.Name)
		}
		name := strings.TrimPrefix(file.Name, prefix)
		files[name] = true
		if strings.HasPrefix(name, "php/") || strings.HasPrefix(name, "python/") || strings.HasPrefix(name, "typescript/") {
			t.Fatalf("other SDK included in Go package: %s", name)
		}
	}
	for _, required := range []string{"go.mod", "client.go", "resources.go", "stream.go", "README.md", "LICENSE"} {
		if !files[required] {
			t.Errorf("module zip missing %s", required)
		}
	}
	run(t, consumer, env, "go", "build", "-mod=mod", ".")
}

func run(t *testing.T, dir string, env []string, name string, args ...string) []byte {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir, cmd.Env = dir, env
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, output)
	}
	return output
}

func writeFile(t *testing.T, path string, body []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0644); err != nil {
		t.Fatal(err)
	}
}

func copyTree(t *testing.T, source, destination string) {
	t.Helper()
	err := filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.MkdirAll(filepath.Join(destination, relative), 0755)
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		defer input.Close()
		output, err := os.Create(filepath.Join(destination, relative))
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(output, input)
		closeErr := output.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
	if err != nil {
		t.Fatal(err)
	}
}
