using System.Text.Json.Nodes;

namespace TopThink.ThinkAI;

public sealed partial class ThinkAIClient
{
    public ResponsesResource Responses
    {
        get;
    }

    public ChatResource Chat
    {
        get;
    }

    public ImagesResource Images
    {
        get;
    }

    public VideosResource Videos
    {
        get;
    }

    public AudioResource Audio
    {
        get;
    }

    public AvatarResource Avatar
    {
        get;
    }

    public MusicResource Music
    {
        get;
    }

    public EmbeddingsResource Embeddings
    {
        get;
    }

    public RerankResource Rerank
    {
        get;
    }

    public DecisionResource Decision
    {
        get;
    }

    public PluginResource Plugin
    {
        get;
    }

    public ModelResource Model
    {
        get;
    }

    public SandboxResource Sandbox
    {
        get;
    }

    public SkillResource Skill
    {
        get;
    }
}

public abstract class Resource
{
    protected readonly ThinkAIClient Client;

    internal Resource(ThinkAIClient client) => Client = client;

    protected Task<ApiResult> Post(string path, JsonObject? parameters, CancellationToken token)
        => Client.JsonRequestAsync(
            "POST", path, parameters ?? new JsonObject(), cancellationToken: token);

    protected Task<ApiResult> Get(string path, JsonObject? query, CancellationToken token)
        => Client.JsonRequestAsync("GET", path, query: query, cancellationToken: token);
}

public sealed class ResponsesResource : Resource
{
    internal ResponsesResource(ThinkAIClient client) : base(client) { }

    public Task<ApiResult> CreateAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("responses", parameters, cancellationToken);
}

public sealed class ChatResource : Resource
{
    internal ChatResource(ThinkAIClient client) : base(client) { }

    public Task<ApiResult> CompletionsAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
    {
        var body = (JsonObject)parameters.DeepClone();
        if (!body.ContainsKey("stream"))
        {
            body["stream"] = true;
        }

        return Post("chat/completions", body, cancellationToken);
    }
}

public sealed class ImagesResource : Resource
{
    internal ImagesResource(ThinkAIClient client) : base(client) { }

    public Task<ApiResult> GenerationsAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("images/generations", parameters, cancellationToken);

    public Task<ApiResult> InpaintingAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("images/inpainting", parameters, cancellationToken);

    public Task<ApiResult> OutpaintingAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("images/outpainting", parameters, cancellationToken);

    public Task<ApiResult> UpscaleAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("images/upscale", parameters, cancellationToken);

    public Task<ApiResult> PosterAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("images/poster", parameters, cancellationToken);

    public Task<ApiResult> EditAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("images/edit", parameters, cancellationToken);
}

public sealed class VideosResource : Resource
{
    internal VideosResource(ThinkAIClient client) : base(client) { }

    public Task<ApiResult> GenerationsAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("videos/generations", parameters, cancellationToken);

    public Task<ApiResult> QueryAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("videos/query", parameters, cancellationToken);
}

public sealed class AudioResource : Resource
{
    internal AudioResource(ThinkAIClient client) : base(client) { }

    public Task<ApiResult> SpeechAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("audio/speech", parameters, cancellationToken);

    public Task<ApiResult> TranscriptionsAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("audio/transcriptions", parameters, cancellationToken);
}

public sealed class AvatarResource : Resource
{
    internal AvatarResource(ThinkAIClient client) : base(client) { }

    public async Task<ApiResult> VideoAsync(
        JsonObject parameters,
        bool wait = false,
        TimeSpan? waitTimeout = null,
        TimeSpan? pollInterval = null,
        CancellationToken cancellationToken = default)
    {
        if (!wait)
        {
            return await Post("avatar/video", parameters, cancellationToken).ConfigureAwait(false);
        }

        var timeout = waitTimeout ?? TimeSpan.FromSeconds(300);
        var interval = pollInterval ?? Client.Options.PollInterval;
        if (timeout <= TimeSpan.Zero || interval <= TimeSpan.Zero)
        {
            throw new ArgumentException("等待时限及轮询间隔必须大于零。");
        }

        using var created = await Post("avatar/video", parameters, cancellationToken)
            .ConfigureAwait(false);
        if (created.Kind != ResultKind.Json)
        {
            throw new ThinkAIException("Avatar 创建响应不是 JSON。", created.StatusCode);
        }

        var id = created.Json?["id"]?.DeepClone()
            ?? throw new ThinkAIException("Avatar 创建响应缺少 id。", created.StatusCode);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        try
        {
            while (true)
            {
                var query = new JsonObject
                {
                    ["id"] = id.DeepClone(),
                    ["model"] = parameters["model"]?.DeepClone()
                };
                var result = await QueryAsync(query, deadline.Token).ConfigureAwait(false);
                string? status = result.Kind == ResultKind.Json
                    && result.Json?["status"] is JsonValue value
                    && value.TryGetValue<string>(out var statusValue)
                        ? statusValue
                        : null;
                if (status is "success" or "fail")
                {
                    return result;
                }

                if (status != "processing")
                {
                    result.Dispose();
                    throw new ThinkAIException("Avatar 查询响应包含未知或缺少 status。", result.StatusCode);
                }
                result.Dispose();
                await Task.Delay(interval, deadline.Token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException error) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ThinkAIException("Avatar 等待超时。", innerException: error);
        }
    }

    public Task<ApiResult> QueryAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("avatar/query", parameters, cancellationToken);
}

public sealed class MusicResource : Resource
{
    internal MusicResource(ThinkAIClient client) : base(client) { }

    public Task<ApiResult> SongAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("music/song", parameters, cancellationToken);

    public Task<ApiResult> BgmAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("music/bgm", parameters, cancellationToken);

    public Task<ApiResult> QueryAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("music/query", parameters, cancellationToken);
}

public sealed class EmbeddingsResource : Resource
{
    internal EmbeddingsResource(ThinkAIClient client) : base(client) { }

    public Task<ApiResult> CreateAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("embeddings", parameters, cancellationToken);
}

public sealed class RerankResource : Resource
{
    internal RerankResource(ThinkAIClient client) : base(client) { }

    public Task<ApiResult> CreateAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("rerank", parameters, cancellationToken);
}

public sealed class DecisionResource : Resource
{
    internal DecisionResource(ThinkAIClient client) : base(client) { }

    public Task<ApiResult> EvaluateAsync(
        JsonObject parameters,
        CancellationToken cancellationToken = default)
        => Post("decisions", parameters, cancellationToken);
}

public sealed class PluginResource : Resource
{
    internal PluginResource(ThinkAIClient client) : base(client) { }

    public Task<ApiResult> ListAsync(
        JsonObject? parameters = null,
        CancellationToken cancellationToken = default)
        => Get("plugin", parameters, cancellationToken);
}

public sealed class ModelResource : Resource
{
    internal ModelResource(ThinkAIClient client) : base(client) { }

    public Task<ApiResult> ListAsync(
        JsonObject? parameters = null,
        CancellationToken cancellationToken = default)
        => Get("model", parameters, cancellationToken);

    public Task<ApiResult> ShowAsync(
        string type,
        string code,
        CancellationToken cancellationToken = default)
        => Get(
            $"model/{ThinkAIClient.Segment(type)}/{ThinkAIClient.Segment(code)}",
            null,
            cancellationToken);
}

public sealed class SandboxResource : Resource
{
    internal SandboxResource(ThinkAIClient client) : base(client) { }

    private static string PathFor(string id, string suffix = "")
        => $"sandbox/{ThinkAIClient.Segment(id)}{suffix}";

    public Task<ApiResult> CreateAsync(
        string? name = null,
        CancellationToken cancellationToken = default)
        => Post("sandbox", ThinkAIClient.Obj(("name", name)), cancellationToken);

    public Task<ApiResult> GetAsync(string name, CancellationToken cancellationToken = default)
        => Get(PathFor(name), null, cancellationToken);

    public async Task DeleteAsync(string name, CancellationToken cancellationToken = default)
    {
        using var result = await Client.JsonRequestAsync(
            "DELETE",
            PathFor(name),
            cancellationToken: cancellationToken).ConfigureAwait(false);
    }

    public Task<ApiResult> ListFileAsync(
        string id,
        string? path = null,
        CancellationToken cancellationToken = default)
        => Get(PathFor(id, "/list"), ThinkAIClient.Obj(("path", path)), cancellationToken);

    public Task<ApiResult> ReadFileAsync(
        string id,
        string path,
        CancellationToken cancellationToken = default)
        => Get(PathFor(id, "/read"), ThinkAIClient.Obj(("path", path)), cancellationToken);

    public Task<ApiResult> WriteFileAsync(
        string id,
        string path,
        string content,
        CancellationToken cancellationToken = default)
        => Post(
            PathFor(id, "/write"),
            ThinkAIClient.Obj(("path", path), ("content", content)),
            cancellationToken);

    public Task<ApiResult> EditFileAsync(
        string id,
        string path,
        string oldStr,
        string newStr = "",
        CancellationToken cancellationToken = default)
        => Post(
            PathFor(id, "/edit"),
            ThinkAIClient.Obj(("path", path), ("old_str", oldStr), ("new_str", newStr)),
            cancellationToken);

    public async Task<ApiResult> UploadFileAsync(
        string id,
        string path,
        string file,
        CancellationToken cancellationToken = default)
    {
        using var stream = File.OpenRead(file);
        return await UploadFileAsync(id, path, stream, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>读取调用者提供的流；方法结束后调用者仍拥有并负责释放该流。</summary>
    public Task<ApiResult> UploadFileAsync(
        string id,
        string path,
        Stream file,
        CancellationToken cancellationToken = default)
    {
        var multipart = new MultipartFormDataContent();
        multipart.Add(new StringContent(path), "path");
        var body = new StreamContent(new LeaveOpenStream(file));
        body.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(
            "application/octet-stream");
        multipart.Add(body, "file", path.Replace('\\', '/').Split('/').Last());
        return Client.RequestAsync(
            "POST", PathFor(id, "/upload"), multipart, null, cancellationToken);
    }

    public Task<ApiResult> DownloadFileAsync(
        string id,
        string path,
        CancellationToken cancellationToken = default)
        => Client.JsonRequestAsync(
            "GET",
            PathFor(id, "/download"),
            query: ThinkAIClient.Obj(("path", path)),
            cancellationToken: cancellationToken,
            binary: true);

    public Task<ApiResult> RunCodeAsync(
        string id,
        string code,
        JsonArray? files = null,
        CancellationToken cancellationToken = default)
        => Post(
            PathFor(id, "/code"),
            ThinkAIClient.Obj(("code", code), ("files", files ?? new JsonArray())),
            cancellationToken);

    public Task<ApiResult> RunCommandAsync(
        string id,
        string command,
        bool stream = false,
        CancellationToken cancellationToken = default)
        => Post(
            PathFor(id, "/command"),
            ThinkAIClient.Obj(("command", command), ("stream", stream)),
            cancellationToken);
}

public sealed class SkillResource : Resource
{
    internal SkillResource(ThinkAIClient client) : base(client) { }

    public Task<ApiResult> ListAsync(
        JsonObject? parameters = null,
        CancellationToken cancellationToken = default)
        => Get("skill", parameters, cancellationToken);

    public Task<ApiResult> CategoriesAsync(CancellationToken cancellationToken = default)
        => Get("skill/category", null, cancellationToken);

    public Task<ApiResult> DownloadAsync(string path, CancellationToken cancellationToken = default)
        => Client.JsonRequestAsync(
            "GET",
            "skill/download",
            query: ThinkAIClient.Obj(("path", path)),
            cancellationToken: cancellationToken,
            binary: true);
}

internal sealed class LeaveOpenStream(Stream inner) : Stream
{
    public override bool CanRead => inner.CanRead;
    public override bool CanSeek => inner.CanSeek;
    public override bool CanWrite => false;
    public override long Length => inner.Length;
    public override long Position
    {
        get => inner.Position;
        set => inner.Position = value;
    }

    public override int Read(byte[] buffer, int offset, int count)
        => inner.Read(buffer, offset, count);

    public override ValueTask<int> ReadAsync(
        Memory<byte> buffer,
        CancellationToken cancellationToken = default)
        => inner.ReadAsync(buffer, cancellationToken);

    public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);

    public override void Flush() => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count)
        => throw new NotSupportedException();
}
