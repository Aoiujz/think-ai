# ThinkAI .NET SDK

.NET 10+；NuGet 包及 namespace 为 `TopThink.ThinkAI`，版本 `1.0.1`。HTTP 使用 `HttpClient`，JSON 使用 `System.Text.Json`，无额外运行依赖。覆盖 PHP 当前的 14 类资源、37 个操作。此仓库提供可打包代码，包是否公开发布以仓库发布记录为准。

从仓库根构建本地包：

```sh
dotnet pack dotnet/TopThink.ThinkAI/TopThink.ThinkAI.csproj -c Release -o dotnet/artifacts
dotnet add package TopThink.ThinkAI --version 1.0.1 --source /绝对路径/dotnet/artifacts
```

## 客户端和响应

```csharp
using TopThink.ThinkAI;
using System.Text.Json.Nodes;

using var client = new ThinkAIClient(
    Environment.GetEnvironmentVariable("THINKAI_TOKEN")!,
    new ThinkAIOptions
    {
        Endpoint = new Uri("https://ai.topthink.com/"),
        OperationTimeout = TimeSpan.FromSeconds(300),
        PollInterval = TimeSpan.FromSeconds(5)
    });

using var response = await client.Chat.CompletionsAsync(new JsonObject
{
    ["model"] = "你的模型",
    ["stream"] = false,
    ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "你好" })
});
if (response.Kind == ResultKind.Json)
{
    Console.WriteLine(response.Json);
}
```

参数采用可扩展的 `JsonObject`，响应 JSON 采用 `JsonNode`，不生成模型专用 schema、不筛选未知字段。字段名称保持 API 原样。可用 `JsonNode.Parse` 或 `JsonSerializer.SerializeToNode` 从字典/对象构造参数；SDK 不修改调用者参数。GET 查询采用 PHP 风格括号编码，布尔值为 `1/0`，null 查询值省略。

响应包装 `ApiResult.Kind` 为 `Json`、`Events`、`Binary` 或 `Empty`。JSON null 仍是 `Json`；HTTP 204/205 是 `Empty`。普通接口按实际 Content-Type 判别；下载操作直接提供原始 Binary，JSON 文件也保持原始字节。用 `using` 或 `await using` 释放结果，提前结束流也必须释放。

```csharp
await using var streamed = await client.Chat.CompletionsAsync(new JsonObject
{
    ["model"] = "你的模型",
    ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "你好" })
});
if (streamed.Kind == ResultKind.Events)
{
    await foreach (var item in streamed.Events!)
    {
        Console.WriteLine(item.Data);
        // Event / Id / RawData / Retry 保留 SSE 元数据。
    }
}
else if (streamed.Kind == ResultKind.Json)
{
    Console.WriteLine(streamed.Json);
}
```

Chat 缺省发送 `stream=true`，显式 false 请求 JSON。SSE 支持 UTF-8 跨块、多行 data、CRLF、注释和 DONE；无 DONE 的截断与无效 JSON 会报错。Responses 是 ThinkAI 自有 `chunks`、`stats`、`id` 事件；合法事件内 `error` 原样返回。

## 全部资源操作

以下是独立调用片段，`p` 应按模型填写；流式和二进制结果必须按上文释放。

```csharp
var p = new JsonObject { ["model"] = "你的模型", ["prompt"] = "示例输入" };
await client.Responses.CreateAsync(p);
await client.Chat.CompletionsAsync(p);
await client.Images.GenerationsAsync(p);
await client.Images.InpaintingAsync(p);
await client.Images.OutpaintingAsync(p);
await client.Images.UpscaleAsync(p);
await client.Images.PosterAsync(p);
await client.Images.EditAsync(p);
await client.Videos.GenerationsAsync(p);
await client.Videos.QueryAsync(new JsonObject { ["model"] = "你的模型", ["id"] = "任务ID" });
await client.Audio.SpeechAsync(p); // JSON、SSE 或二进制，按 Kind 读取
await client.Audio.TranscriptionsAsync(p);
await client.Avatar.VideoAsync(p); // 默认不等待
await client.Avatar.QueryAsync(new JsonObject { ["model"] = "你的模型", ["id"] = "任务ID" });
await client.Music.SongAsync(p);
await client.Music.BgmAsync(p);
await client.Music.QueryAsync(new JsonObject { ["model"] = "你的模型", ["id"] = "任务ID" });
await client.Embeddings.CreateAsync(p);
await client.Rerank.CreateAsync(p);
await client.Decision.EvaluateAsync(p);
await client.Plugin.ListAsync();
await client.Model.ListAsync(new JsonObject { ["type"] = "chat" });
await client.Model.ShowAsync("chat", "模型代码");
await client.Sandbox.CreateAsync("demo"); // name 可省略
await client.Sandbox.GetAsync("sandbox-id");
await client.Sandbox.ListFileAsync("sandbox-id", "/workspace");
await client.Sandbox.ReadFileAsync("sandbox-id", "/workspace/main.py");
await client.Sandbox.WriteFileAsync("sandbox-id", "/workspace/main.py", "print('hello')");
await client.Sandbox.EditFileAsync("sandbox-id", "/workspace/main.py", "hello", "你好");
await client.Sandbox.UploadFileAsync("sandbox-id", "/workspace/input.txt", "input.txt");
await client.Sandbox.DownloadFileAsync("sandbox-id", "/workspace/output.bin");
await client.Sandbox.RunCodeAsync("sandbox-id", "print('hello')", new JsonArray(
    new JsonObject { ["url"] = "https://example.com/input.txt", ["name"] = "input.txt" }));
await client.Sandbox.RunCommandAsync("sandbox-id", "echo hello", stream: true);
await client.Sandbox.DeleteAsync("sandbox-id");
await client.Skill.ListAsync(new JsonObject { ["category_id"] = 1 });
await client.Skill.CategoriesAsync();
await client.Skill.DownloadAsync("列表返回的技能包路径");
```

上传支持本地文件路径或调用者的 `Stream`。multipart 包含 `path`、`file`，filename 取远端 path 的 basename；调用者传入的 Stream 由调用者释放。

```csharp
await using var download = await client.Sandbox.DownloadFileAsync("sandbox-id", "/workspace/output.bin");
if (download.Kind == ResultKind.Binary)
{
    await using var destination = File.Create("output.bin");
    await download.Binary!.CopyToAsync(destination);
}
```

## 等待、取消、注入和异常

```csharp
using var cancellation = new CancellationTokenSource();
using var result = await client.Avatar.VideoAsync(p, wait: true,
    waitTimeout: TimeSpan.FromSeconds(300), pollInterval: TimeSpan.FromSeconds(5),
    cancellationToken: cancellation.Token);
Console.WriteLine(result.Json);
// 另一线程可以 cancellation.Cancel()；其他方法也接受 cancellationToken。
```

Avatar 默认立即返回。启用等待后，从创建响应返回开始计时，使用原始任务 ID/model；`processing` 继续，`success`/`fail` 原样返回，HTTP 错误立即抛出，未知或缺少 status 报协议错误。创建请求单独受操作时限约束。

每次操作的默认总时限 300 秒，包括响应头和 JSON/SSE/二进制读取，可通过 `ThinkAIOptions.OperationTimeout` 配置。取消会覆盖请求、等待及流读取。超时抛 `ThinkAIException` 并保留底层原因；调用者取消采用 `OperationCanceledException`。SSE 消费还可以 `WithCancellation(token)`。

```csharp
using var http = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
using var injected = new ThinkAIClient("token", httpClient: http);
// SDK 不释放注入的 HttpClient；其较短 Timeout、TLS 和代理设置仍有效。

try
{
    using var failed = await client.Images.GenerationsAsync(p);
}
catch (ThinkAIException error)
{
    Console.Error.WriteLine(error.StatusCode); // 传输错误可为 null
    Console.Error.WriteLine(error.RawBody);
    Console.Error.WriteLine(error.InnerException);
}
```

SDK 默认正常验证 TLS，不自动重试，避免生成任务重复提交。任务 `fail` 和合法 SSE `error` 数据不会被转换成 HTTP 异常。

## 离线验证与打包

在仓库根执行：

```sh
dotnet test dotnet/TopThink.ThinkAI.Tests/TopThink.ThinkAI.Tests.csproj -c Release
python dotnet/scripts/verify_package.py
```

xUnit 自动启动共享 Node.js loopback 服务，逐项调用 37 个操作，验证请求、JSON/SSE、错误、取消、轮询、multipart 及下载字节。消费者脚本实际生成 `.nupkg`，检查隔离内容，再从本地 feed 安装到临时消费者运行。包中包含 DLL、XML 文档、中文 README 与 Apache LICENSE，不包含其他语言 SDK。测试不调用真 API，也不公开发布包。

## 代码格式

`dotnet/.editorconfig` 规定 C# 使用 4 空格和 LF，展开控制语句及非空方法块，控制语句使用大括号，保留现有 file-scoped namespace。使用 .NET SDK 自带的格式工具，在已 restore 的仓库根执行以下只读检查：

```sh
dotnet format whitespace dotnet/TopThink.ThinkAI/TopThink.ThinkAI.csproj --no-restore --verify-no-changes
dotnet format whitespace dotnet/TopThink.ThinkAI.Tests/TopThink.ThinkAI.Tests.csproj --no-restore --verify-no-changes
dotnet format style dotnet/TopThink.ThinkAI/TopThink.ThinkAI.csproj --no-restore --diagnostics IDE0011 --severity info --verify-no-changes
dotnet format style dotnet/TopThink.ThinkAI.Tests/TopThink.ThinkAI.Tests.csproj --no-restore --diagnostics IDE0011 --severity info --verify-no-changes
```

本地修正时移除 `--verify-no-changes`。样式修正限定 `IDE0011`，用于补齐控制语句的大括号。
