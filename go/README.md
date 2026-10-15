# ThinkAI Go SDK

Go 1.26 及以上；模块为 `github.com/top-think/think-ai/go`，导入名称为 `thinkai`。首版版本为 `1.0.1`，使用标准库，无运行时第三方依赖。覆盖 PHP SDK 当前 14 类资源、37 个方法，参数名和资源划分保持一致。

## 安装

只有 `go/v1.0.1` 已实际公开并被 Go 索引后，下面的版本安装命令才可使用。维护者可手动显式执行发布脚本发布该版本；CI 只测试与构建，不发布或推送标签：

```sh
go get github.com/top-think/think-ai/go@v1.0.1
```

尚未发布的本地开发版本可在使用方模块设置替换，路径改为本机 SDK 目录：

```sh
go mod edit -replace github.com/top-think/think-ai/go=/absolute/path/think-ai/go
go mod tidy
```

## 快速开始

```go
package main

import (
    "context"
    "fmt"
    "os"

    thinkai "github.com/top-think/think-ai/go"
)

func main() {
    client, err := thinkai.NewClient(os.Getenv("THINKAI_TOKEN"))
    if err != nil { panic(err) }
    result, err := client.Chat().Completions(context.Background(), thinkai.Params{
        "model": "YOUR_MODEL",
        "messages": []thinkai.Params{{"role": "user", "content": "你好"}},
        "stream": false,
    })
    if err != nil { panic(err) }
    defer result.Close()
    raw, err := result.AsJSON()
    if err != nil { panic(err) }
    fmt.Println(string(raw))
}
```

所有资源方法都接受 `context.Context`。`Params` 是 `map[string]any`，会完整转发扩展参数；普通 JSON 方法返回 `json.RawMessage`，不会丢失未知字段或大整数原文。可用 `json.Unmarshal(raw, &target)` 按需解析。

## 配置、错误和响应

```go
client, err := thinkai.NewClient("YOUR_TOKEN",
    thinkai.WithEndpoint("https://ai.topthink.com/"),
    thinkai.WithTimeout(300*time.Second),
    thinkai.WithHTTPClient(&http.Client{}),
)
if err != nil { panic(err) }
ctx, cancel := context.WithCancel(context.Background())
defer cancel()
```

默认验证 TLS，不自动重试。每个 HTTP 操作的总时限默认 300 秒，覆盖连接、读取 JSON、流式读取及二进制下载；调用方更短的 context deadline 优先。`WithEndpoint` 支持路径前缀。注入的 `HTTPClient` 需实现 `Do(*http.Request) (*http.Response, error)`；它自身若配置更短的超时也会生效。

HTTP 非 2xx 返回 `*thinkai.APIError`，包含 `StatusCode`、`Header`、`Message`、`RawBody` 和原始 JSON `Details`，422 验证错误内容也完整保留。网络、context 取消、超时和协议解析失败通过 `error` 返回。SSE 中合法的 `error`、`chunks.error` 事件和任务 `status: fail` 保留为业务结果。

`Chat.Completions`、`Responses.Create`、`Audio.Speech`、`Sandbox.RunCommand` 返回 `*Result`，根据实际响应的 Content-Type 判断：

| `Kind` | 数据 | 转换方法 |
| --- | --- | --- |
| `KindJSON` | 原始 `JSON` | `AsJSON()` |
| `KindStream` | 可关闭 SSE `Stream` | `AsStream()` |
| `KindBinary` | 二进制 `io.ReadCloser` | `AsBinary()` |
| `KindEmpty` | 空成功响应 | 无需转换 |

调用 `result.Close()` 可统一释放动态响应。`AsJSON`/`AsStream`/`AsBinary` 类型不匹配会返回错误。其他 JSON 方法遇到空成功响应返回 `nil, nil`。下载方法返回 `io.ReadCloser`，调用方必须关闭。

下面示例沿用已创建的 `client` 和 `ctx`。JSON 示例中的 `show` 为：

```go
func show(raw json.RawMessage, err error) {
    if err != nil { panic(err) }
    fmt.Println(string(raw))
}
```

## 对话和 Responses

Chat 未提供 `stream` 时会发送 `stream: true`；显式 `false` 请求普通 JSON。最终仍以服务器实际 Content-Type 判断返回类型：

```go
result, err := client.Chat().Completions(ctx, thinkai.Params{
    "model": "YOUR_MODEL",
    "messages": []thinkai.Params{{"role": "user", "content": "你好"}},
})
if err != nil { panic(err) }
defer result.Close()
switch result.Kind {
case thinkai.KindStream:
    stream, _ := result.AsStream()
    for stream.Next() {
        event := stream.Event()
        fmt.Println(event.Type, event.ID, string(event.Data))
        // event.Decode(&target) 可解析完整 JSON，包括扩展字段和业务错误。
    }
    if err := stream.Err(); err != nil { panic(err) }
case thinkai.KindJSON:
    raw, _ := result.AsJSON()
    fmt.Println(string(raw))
}
```

SSE 支持任意网络分块、UTF-8、CRLF、多行 data、注释和 `[DONE]`；未收到 `[DONE]` 的断流返回 `io.ErrUnexpectedEOF`。`Next` 供单个读取者使用；可从其他 goroutine 调用 `Close` 取消阻塞读取。调用方主动关闭流后正常结束迭代。

Responses 使用 ThinkAI 自身的 `chunks`、`stats`、`id` 事件，不转换为 Chat choices 结构：

```go
response, err := client.Responses().Create(ctx, thinkai.Params{
    "model": "YOUR_MODEL", "messages": []thinkai.Params{{"role": "user", "content": "你好"}},
})
if err != nil { panic(err) }
defer response.Close()
stream, err := response.AsStream()
if err != nil { panic(err) }
for stream.Next() { fmt.Println(string(stream.Event().Data)) }
if err := stream.Err(); err != nil { panic(err) }
```

## 图像、视频和音频

```go
imageParams := thinkai.Params{"model": "YOUR_IMAGE_MODEL", "prompt": "一只猫"}
show(client.Images().Generations(ctx, imageParams))
show(client.Images().Inpainting(ctx, thinkai.Params{"model": "YOUR_IMAGE_MODEL", "image": "IMAGE_URL", "mask": "MASK_URL", "prompt": "一只猫"}))
show(client.Images().Outpainting(ctx, thinkai.Params{"model": "YOUR_IMAGE_MODEL", "image": "IMAGE_URL"}))
show(client.Images().Upscale(ctx, thinkai.Params{"model": "YOUR_IMAGE_MODEL", "image": "IMAGE_URL"}))
show(client.Images().Poster(ctx, thinkai.Params{"model": "YOUR_IMAGE_MODEL", "prompt": "活动海报"}))
show(client.Images().Edit(ctx, thinkai.Params{"model": "YOUR_IMAGE_MODEL", "image": "IMAGE_URL", "prompt": "改成蓝色"}))

show(client.Videos().Generations(ctx, thinkai.Params{"model": "YOUR_VIDEO_MODEL", "prompt": "海面日出"}))
show(client.Videos().Query(ctx, thinkai.Params{"model": "YOUR_VIDEO_MODEL", "id": "TASK_ID"}))

speech, err := client.Audio().Speech(ctx, thinkai.Params{"model": "YOUR_TTS_MODEL", "input": "你好"})
if err != nil { panic(err) }
defer speech.Close()
// speech.Kind 可能为 JSON、SSE 或二进制；按上表处理，音频事件不自动拼接。
show(client.Audio().Transcriptions(ctx, thinkai.Params{"model": "YOUR_ASR_MODEL", "file": "AUDIO_URL"}))
```

模型特定字段按对应接口要求提供；SDK 不改写协议字段，也不自动等待视频或音乐任务完成。

## 数字人和音乐

```go
avatarParams := thinkai.Params{"model": "YOUR_AVATAR_MODEL", "image": "IMAGE_URL", "audio": "AUDIO_URL"}
show(client.Avatar().Video(ctx, avatarParams)) // 默认仅创建任务。
show(client.Avatar().Query(ctx, thinkai.Params{"model": "YOUR_AVATAR_MODEL", "id": "TASK_ID"}))
show(client.Avatar().Video(ctx, avatarParams, thinkai.WaitOptions{
    Enabled: true,
    Timeout: 300*time.Second,
    PollInterval: 5*time.Second,
}))

show(client.Music().Song(ctx, thinkai.Params{"model": "YOUR_MUSIC_MODEL", "prompt": "春天"}))
show(client.Music().BGM(ctx, thinkai.Params{"model": "YOUR_MUSIC_MODEL", "prompt": "轻快钢琴"}))
show(client.Music().Query(ctx, thinkai.Params{"model": "YOUR_MUSIC_MODEL", "id": "TASK_ID"}))
```

等待模式在创建成功后开始计算独立的等待期限，默认 300 秒，每 5 秒查询创建时的原始任务 ID 和原始 model；interval 可配置，context 可取消。`success`、`fail` 原样返回；仅 `processing` 继续查询。缺失 ID、缺失或未知 status 返回含原始响应的 `ProtocolError`；查询 HTTP 错误立即返回。

## 向量、重排、决策、模型和插件

```go
show(client.Embeddings().Create(ctx, thinkai.Params{"model": "YOUR_EMBEDDING_MODEL", "input": "你好"}))
show(client.Rerank().Create(ctx, thinkai.Params{"model": "YOUR_RERANK_MODEL", "query": "问题", "documents": []string{"文档一", "文档二"}}))
show(client.Decision().Evaluate(ctx, thinkai.Params{
    "model": "YOUR_DECISION_MODEL", "state": "用户希望退款",
    "questions": thinkai.Params{"urgent": thinkai.Params{"type": "noul", "instructions": "判断是否紧急"}},
}))
show(client.Model().List(ctx, nil))
show(client.Model().Show(ctx, "chat", "MODEL_CODE"))
show(client.Plugin().List(ctx, nil))
```

列表 query 使用 PHP 式编码：布尔值 `0`/`1`，数组 `tags[0]`、`tags[1]`，对象 `filter[q]`，`nil` 略过；路径参数作为单独的 URL 段编码。

## Sandbox

```go
name := "example"
show(client.Sandbox().Create(ctx, &name)) // nil 表示由服务端生成名称。
show(client.Sandbox().Get(ctx, name))
directory := "/work"
show(client.Sandbox().ListFile(ctx, name, &directory)) // nil 表示缺省目录。
show(client.Sandbox().ReadFile(ctx, name, "/work/demo.txt"))
show(client.Sandbox().WriteFile(ctx, name, "/work/demo.txt", "你好"))
show(client.Sandbox().EditFile(ctx, name, "/work/demo.txt", "你好", "Hello"))
show(client.Sandbox().UploadFile(ctx, name, "/work/upload.txt", strings.NewReader("文件内容")))
show(client.Sandbox().RunCode(ctx, name, "print('hello')", []thinkai.Params{
    {"url": "https://example.com/data.csv", "name": "data.csv"},
})) // nil files 会编码为 []。
command, err := client.Sandbox().RunCommand(ctx, name, "echo hello", true)
if err != nil { panic(err) }
defer command.Close() // 按实际 Kind 读取 JSON 或 SSE。

body, err := client.Sandbox().DownloadFile(ctx, name, "/work/demo.txt")
if err != nil { panic(err) }
defer body.Close()
output, err := os.Create("demo.txt")
if err != nil { panic(err) }
defer output.Close()
if _, err := io.Copy(output, body); err != nil { panic(err) }
if err := client.Sandbox().Delete(ctx, name); err != nil { panic(err) }
```

上传采用 multipart，字段为 `path` 和 `file`，文件名取目标路径末段；接受 `io.Reader`，SDK 不关闭调用方提供的文件。

## Skill

```go
show(client.Skill().List(ctx, thinkai.Params{"category_id": "CATEGORY_ID"}))
show(client.Skill().Categories(ctx))
body, err := client.Skill().Download(ctx, "SKILL_PACKAGE_PATH")
if err != nil { panic(err) }
defer body.Close()
// 可用 io.Copy 保存原始技能包字节。
```

## 本地验证与发布

在本目录运行 `go test ./...` 和 `go vet ./...`。共享 HTTP 测试需要 Node.js，读取仓库的 `tests/contracts/operations.json` 并启动本地服务；独立安装模块时缺少这些仓库级测试夹具会明确跳过。全部测试使用离线令牌，不调用真实 API。

`tests/TestGitModuleDownload` 使用临时 Git 仓库、本地 HTTP 服务及真实 `go mod download`：验证 PHP 根归档排除 `/go` 的同时，Go 模块仍完整可下载，且不包含其他语言 SDK。测试只在临时仓库创建标签。

仓库工具提供 Go 的 `prepare`、`build`、`publish` 和只读 `verify`。`publish go` 默认仅预演；只有维护者手动显式执行 `publish go --execute` 才推送精确的 `go/v1.0.1` 模块版本标签并查询公共 Go proxy 索引，不上传包文件。索引尚未可见时记录 index-pending，可再次执行或只读 verify；没有公开版本标签时，不能发布对应的新 Go 稳定版本。CI 不执行发布、不推送任何标签。许可证为 Apache-2.0，详见 [LICENSE](LICENSE)。
