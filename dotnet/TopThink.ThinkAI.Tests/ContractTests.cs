using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace TopThink.ThinkAI.Tests;

public sealed class ContractServer : IAsyncLifetime
{
    private Process? _process;
    public Uri Endpoint { get; private set; } = null!;
    public string Root { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null &&
            !File.Exists(Path.Combine(directory.FullName, "tests", "contracts", "server.mjs")))
        {
            directory = directory.Parent;
        }

        Root = directory?.FullName ?? throw new InvalidOperationException("找不到共享离线协议服务。");
        var start = new ProcessStartInfo("node")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        start.ArgumentList.Add(Path.Combine(Root, "tests", "contracts", "server.mjs"));
        start.Environment["PORT"] = "0";
        _process = Process.Start(start)!;
        string line = await _process.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(15))
            ?? throw new InvalidOperationException("协议服务未启动。");
        Endpoint = new Uri(JsonNode.Parse(line)!["endpoint"]!.GetValue<string>());
    }

    public Task DisposeAsync()
    {
        if (_process is { HasExited: false })
        {
            _process.Kill(entireProcessTree: true);
        }

        _process?.Dispose();
        return Task.CompletedTask;
    }

    public ThinkAIClient Client(TimeSpan? timeout = null)
        => new("offline-token", new ThinkAIOptions
        {
            Endpoint = Endpoint,
            OperationTimeout = timeout ?? TimeSpan.FromSeconds(5),
            PollInterval = TimeSpan.FromMilliseconds(2)
        });

    public async Task<JsonArray> Requests()
    {
        using var http = new HttpClient();
        return (JsonArray)JsonNode.Parse(await http.GetStringAsync(new Uri(Endpoint, "__requests")))!;
    }

    public async Task Reset()
    {
        using var http = new HttpClient();
        using var response = await http.PostAsync(new Uri(Endpoint, "__reset"), null);
        response.EnsureSuccessStatusCode();
    }
}

public sealed class ContractTests(ContractServer server) : IClassFixture<ContractServer>
{
    static JsonObject P(string? mode = null) => new()
    {
        ["model"] = "offline-model",
        ["stream"] = false,
        ["__case"] = mode,
        ["custom"] = new JsonObject
        {
            ["nested"] = new JsonArray(1, "你好", null)
        }
    };

    static async Task<List<SseEvent>> Events(ApiResult result)
    {
        var events = new List<SseEvent>();
        await foreach (var item in result.Events!)
        {
            events.Add(item);
        }

        return events;
    }

    [Fact]
    public async Task EverySharedOperationSendsExpectedRouteAndPayload()
    {
        await server.Reset();
        using var client = server.Client();
        var manifest = (JsonArray)JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(server.Root, "tests", "contracts", "operations.json")))!;
        Assert.Equal(37, manifest.Count);
        int count = 0;
        foreach (var entry in manifest)
        {
            string resource = entry!["resource"]!.GetValue<string>(),
                operation = entry["operation"]!.GetValue<string>();
            string Capital(string value) => char.ToUpperInvariant(value[0]) + value[1..];
            object target = typeof(ThinkAIClient).GetProperty(Capital(resource))!.GetValue(client)!;
            var method = target.GetType().GetMethods().First(x => x.Name == Capital(operation) + "Async" && (operation != "uploadFile" || x.GetParameters().Any(p => p.ParameterType == typeof(Stream))));
            using var upload = new MemoryStream(new byte[] { 0, 1, 255, 42 });
            object?[] arguments = method.GetParameters().Select(parameter => parameter.Name switch
            {
                "parameters" => (object)P(),
                "id" or "name" => "box",
                "type" => "chat",
                "code" => "code",
                "path" => "folder/文 件&x.bin",
                "content" => "hello",
                "oldStr" => "old",
                "newStr" => "new",
                "command" => "echo 你好",
                "file" => upload,
                "files" => JsonNode.Parse("[{\"url\":\"https://example.test/a\",\"name\":\"a.txt\",\"extra\":true}]") as JsonArray,
                "wait" or "stream" => false,
                "waitTimeout" or "pollInterval" => null,
                "cancellationToken" => (object)CancellationToken.None,
                _ => throw new InvalidOperationException(parameter.Name)
            }).ToArray();
            var task = (Task)method.Invoke(target, arguments)!;
            await task;
            using var result = task.GetType().GetProperty("Result")?.GetValue(task) as ApiResult;
            if (result?.Kind == ResultKind.Events)
            {
                await Events(result);
            }

            if (result?.Kind == ResultKind.Binary)
            {
                using var sink = new MemoryStream();
                await result.Binary!.CopyToAsync(sink);
                Assert.Equal(8, sink.Length);
            }
            var captured = (await server.Requests())[count++]!;
            Assert.Equal(entry["http_method"]!.GetValue<string>(), captured["method"]!.GetValue<string>());
            Assert.Equal("/" + entry["path"]!.GetValue<string>().Replace("{id}", "box").Replace("{type}", "chat").Replace("{code}", "code"), captured["path"]!.GetValue<string>());
            Assert.Equal("Bearer offline-token", captured["authorization"]!.GetValue<string>());
            if (captured["body"]?["custom"] is not null)
            {
                Assert.True(JsonNode.DeepEquals(P()["custom"], captured["body"]!["custom"]));
            }

            if (operation == "runCode")
            {
                Assert.Equal("https://example.test/a", captured["body"]!["files"]![0]!["url"]!.GetValue<string>());
            }

            if (operation == "uploadFile")
            {
                var raw = Convert.FromBase64String(captured["raw_base64"]!.GetValue<string>());
                Assert.Matches("name=\"?path\"?", Encoding.UTF8.GetString(raw));
                Assert.Matches("name=\"?file\"?", Encoding.UTF8.GetString(raw));
                Assert.True(raw.AsSpan().IndexOf(new byte[] { 0, 1, 255, 42 }) >= 0);
                Assert.True(upload.CanRead);
            }
        }
        Assert.Equal(37, (await server.Requests()).Count);
    }

    [Fact]
    public async Task JsonAndStreamSelectionUsesActualContentType()
    {
        using var client = server.Client();
        var body = P("json");
        body.Remove("stream");
        using var json = await client.Chat.CompletionsAsync(body);
        Assert.Equal(ResultKind.Json, json.Kind);
        Assert.True(json.Json!["body"]!["stream"]!.GetValue<bool>());
        Assert.False(body.ContainsKey("stream"));
        using var normal = await client.Chat.CompletionsAsync(P());
        Assert.Equal(ResultKind.Json, normal.Kind);
        using var streamed = await client.Chat.CompletionsAsync(new JsonObject { ["model"] = "offline" });
        Assert.Equal(2, (await Events(streamed)).Count);
        using var audio = await client.Audio.SpeechAsync(P("audio-sse"));
        Assert.Equal("AAEC", (await Events(audio))[0].Data!["audio"]!["data"]!.GetValue<string>());
        using var command = await client.Sandbox.RunCommandAsync("box", "echo hi", true);
        Assert.Equal(2, (await Events(command)).Count);
    }

    [Fact]
    public async Task FragmentedUtf8MultilineSseAndBusinessErrorsRemainData()
    {
        using var client = server.Client();
        using var fragmented = await client.Chat.CompletionsAsync(P("fragmented-sse"));
        var events = await Events(fragmented);
        Assert.Equal("你好🌍", events[0].Data!["delta"]!["content"]!.GetValue<string>());
        Assert.Equal("message", events[0].Event);
        using var response = await client.Responses.CreateAsync(P("responses-error"));
        var own = await Events(response);
        Assert.Equal(4, own.Count);
        Assert.Equal("Offline event error", own[1].Data!["chunks"]!["error"]!.GetValue<string>());
        Assert.NotNull(own[2].Data!["stats"]);
        Assert.NotNull(own[3].Data!["id"]);
    }

    [Theory]
    [InlineData(400)]
    [InlineData(422)]
    [InlineData(429)]
    [InlineData(500)]
    public async Task HttpErrorsPreserveBodyAndDoNotRetry(int status)
    {
        await server.Reset();
        using var client = server.Client();
        var p = P("error");
        p["__status"] = status;
        var error = await Assert.ThrowsAsync<ThinkAIException>(() => client.Images.GenerationsAsync(p));
        Assert.Equal(status, error.StatusCode);
        Assert.Contains("Offline fixture error", error.RawBody);
        Assert.Single(await server.Requests());
    }

    [Fact]
    public async Task InvalidJsonInvalidSseAndDisconnectFailVisibly()
    {
        using var client = server.Client();
        var json = await Assert.ThrowsAsync<ThinkAIException>(() => client.Images.GenerationsAsync(P("invalid-json")));
        Assert.Equal("{invalid", json.RawBody);
        Assert.NotNull(json.InnerException);
        using var invalid = await client.Responses.CreateAsync(P("invalid-sse"));
        await Assert.ThrowsAsync<ThinkAIException>(() => Events(invalid));
        using var truncated = await client.Responses.CreateAsync(P("disconnect"));
        await Assert.ThrowsAsync<ThinkAIException>(() => Events(truncated));
    }

    [Fact]
    public async Task TotalTimeoutAndCancellationApplyWhileReadingStream()
    {
        using var client = server.Client(TimeSpan.FromMilliseconds(150));
        var p = P("slow");
        p["__delay_ms"] = 1000;
        using var result = await client.Responses.CreateAsync(p);
        var error = await Assert.ThrowsAsync<ThinkAIException>(() => Events(result));
        Assert.NotNull(error.InnerException);
        using var fullClient = server.Client();
        using var cancel = new CancellationTokenSource();
        using var pending = await fullClient.Responses.CreateAsync(p, cancel.Token);
        cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Events(pending));
    }

    [Fact]
    public async Task AvatarWaitUsesOriginalIdReturnsFailAndStopsOnQueryError()
    {
        await server.Reset();
        using var client = server.Client();
        using var created = await client.Avatar.VideoAsync(P("wait-success"));
        Assert.Equal("processing", created.Json!["status"]!.GetValue<string>());
        Assert.Single(await server.Requests());
        using var completed = await client.Avatar.VideoAsync(P("wait-success"), true);
        Assert.Equal("success", completed.Json!["status"]!.GetValue<string>());
        using var failed = await client.Avatar.VideoAsync(P("wait-fail"), true);
        Assert.Equal("fail", failed.Json!["status"]!.GetValue<string>());
        var error = await Assert.ThrowsAsync<ThinkAIException>(() => client.Avatar.VideoAsync(P("wait-error"), true));
        Assert.Equal(403, error.StatusCode);
        await Assert.ThrowsAsync<ThinkAIException>(() => client.Avatar.VideoAsync(P("wait-timeout"), true, TimeSpan.FromMilliseconds(40), TimeSpan.FromMilliseconds(2)));
        var requests = await server.Requests();
        var queries = requests.Where(r => r!["path"]!.GetValue<string>() == "/avatar/query").ToArray();
        Assert.All(queries, r => Assert.StartsWith("offline-task-", r!["body"]!["id"]!.GetValue<string>()));
    }

    [Fact]
    public async Task InjectedHttpClientIsUsableAfterSdkDisposalAndEndpointPrefixIsPreserved()
    {
        using var http = new HttpClient();
        using (var client = new ThinkAIClient("offline-token", new ThinkAIOptions { Endpoint = new Uri(server.Endpoint, "prefix") }, http))
        {
            using var result = await client.Model.ShowAsync("chat", "code/a b");
            Assert.Equal("/prefix/model/chat/code%2Fa%20b", result.Json!["path"]!.GetValue<string>());
        }
        Assert.Contains("true", await http.GetStringAsync(new Uri(server.Endpoint, "__health")));
    }

    [Fact]
    public async Task NestedQueryValuesUsePhpBracketEncoding()
    {
        using var client = server.Client();
        using var result = await client.Model.ListAsync(new JsonObject
        {
            ["enabled"] = false,
            ["tags"] = new JsonArray("a", "b"),
            ["filter"] = new JsonObject { ["q"] = "你好" },
            ["skip"] = null
        });
        var query = result.Json!["query"]!;
        Assert.Equal("0", query["enabled"]!.GetValue<string>());
        Assert.Equal("a", query["tags[0]"]!.GetValue<string>());
        Assert.Equal("b", query["tags[1]"]!.GetValue<string>());
        Assert.Equal("你好", query["filter[q]"]!.GetValue<string>());
        Assert.Null(query["skip"]);
    }

    [Fact]
    public async Task DownloadJsonPreservesExactFileBytes()
    {
        using var client = server.Client();
        using var result = await client.Sandbox.DownloadFileAsync("box", "fixture.json");
        Assert.Equal(ResultKind.Binary, result.Kind);
        using var bytes = new MemoryStream();
        await result.Binary!.CopyToAsync(bytes);
        Assert.Equal("{ \"file\": true }\n", Encoding.UTF8.GetString(bytes.ToArray()));
    }

    [Fact]
    public async Task BufferedEventsStillObserveDeadlineAndCancellation()
    {
        using var client = server.Client(TimeSpan.FromMilliseconds(150));
        using var result = await client.Responses.CreateAsync(P());
        await using var events = result.Events!.GetAsyncEnumerator();
        Assert.True(await events.MoveNextAsync());
        await Task.Delay(200);
        await Assert.ThrowsAsync<ThinkAIException>(async () => await events.MoveNextAsync());
        using var fullClient = server.Client();
        using var cancellation = new CancellationTokenSource();
        using var cancellable = await fullClient.Responses.CreateAsync(P(), cancellation.Token);
        await using var pending = cancellable.Events!.GetAsyncEnumerator();
        Assert.True(await pending.MoveNextAsync());
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await pending.MoveNextAsync());
    }
}
