using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace TopThink.ThinkAI;

public sealed class ThinkAIOptions
{
    public Uri Endpoint { get; init; } = new("https://ai.topthink.com/");

    public TimeSpan OperationTimeout { get; init; } = TimeSpan.FromSeconds(300);

    public TimeSpan PollInterval { get; init; } = TimeSpan.FromSeconds(5);
}

public sealed partial class ThinkAIClient : IDisposable
{
    public const string Version = "1.0.1";
    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    private readonly string _token;
    private readonly Uri _endpoint;

    private readonly CancellationTokenSource _closed = new();
    private int _disposed;
    internal readonly ThinkAIOptions Options;

    public ThinkAIClient(string token, ThinkAIOptions? options = null, HttpClient? httpClient = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(token);
        Options = options ?? new ThinkAIOptions();
        if (!Options.Endpoint.IsAbsoluteUri || Options.Endpoint.Scheme is not ("https" or "http"))
        {
            throw new ArgumentException("Endpoint 必须为 HTTP(S) 绝对地址。");
        }

        if (Options.OperationTimeout <= TimeSpan.Zero || Options.PollInterval <= TimeSpan.Zero)
        {
            throw new ArgumentException("超时及轮询间隔必须大于零。");
        }

        _token = token;
        _endpoint = new Uri(Options.Endpoint.AbsoluteUri.TrimEnd('/') + "/");
        _ownsHttp = httpClient is null;
        _http = httpClient ?? new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        Responses = new(this);
        Chat = new(this);
        Images = new(this);
        Videos = new(this);
        Audio = new(this);
        Avatar = new(this);
        Music = new(this);
        Embeddings = new(this);
        Rerank = new(this);
        Decision = new(this);
        Plugin = new(this);
        Model = new(this);
        Sandbox = new(this);
        Skill = new(this);
    }

    internal static string Segment(string value) => Uri.EscapeDataString(value);

    internal static JsonObject Obj(params (string Key, object? Value)[] values)
    {
        var result = new JsonObject();
        foreach (var (key, value) in values)
        {
            result[key] = value is JsonNode node
                ? node.DeepClone()
                : JsonSerializer.SerializeToNode(value);
        }

        return result;
    }

    private static void QueryPairs(List<string> output, string key, JsonNode? value)
    {
        if (value is null)
        {
            return;
        }

        if (value is JsonObject obj)
        {
            foreach (var pair in obj)
            {
                QueryPairs(output, $"{key}[{pair.Key}]", pair.Value);
            }

            return;
        }
        if (value is JsonArray array)
        {
            for (int i = 0; i < array.Count; i++)
            {
                QueryPairs(output, $"{key}[{i}]", array[i]);
            }

            return;
        }
        string text = value is JsonValue scalar && scalar.TryGetValue<string>(out var str)
            ? str
            : value.ToJsonString();
        if (text is "true" or "false")
        {
            text = text == "true" ? "1" : "0";
        }

        output.Add(Uri.EscapeDataString(key) + "=" + Uri.EscapeDataString(text));
    }

    internal Task<ApiResult> JsonRequestAsync(string method, string path, JsonObject? body = null, JsonObject? query = null, CancellationToken cancellationToken = default, bool binary = false)
    {
        HttpContent? content = body is null
            ? null
            : new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        return RequestAsync(method, path, content, query, cancellationToken, binary);
    }

    internal async Task<ApiResult> RequestAsync(string method, string path, HttpContent? content, JsonObject? query, CancellationToken cancellationToken, bool binary = false)
    {
        var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _closed.Token);
        lifetime.CancelAfter(Options.OperationTimeout);
        HttpResponseMessage? response = null;
        bool transferred = false;
        try
        {
            var pairs = new List<string>();
            if (query is not null)
            {
                foreach (var pair in query)
                {
                    QueryPairs(pairs, pair.Key, pair.Value);
                }
            }

            var url = new Uri(_endpoint, path + (pairs.Count == 0 ? "" : "?" + string.Join("&", pairs)));
            using var request = new HttpRequestMessage(new HttpMethod(method), url)
            {
                Content = content
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _token);
            request.Headers.UserAgent.ParseAdd("ThinkAI-dotnet/" + Version);
            request.Headers.Accept.ParseAdd("application/json, text/event-stream, application/octet-stream");
            response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, lifetime.Token).ConfigureAwait(false);
            int status = (int)response.StatusCode;
            if (!response.IsSuccessStatusCode)
            {
                var raw = await response.Content.ReadAsStringAsync(lifetime.Token).ConfigureAwait(false);
                throw new ThinkAIException($"ThinkAI HTTP {status}", status, raw);
            }
            if (status is 204 or 205 || (!binary && response.Content.Headers.ContentLength == 0))
            {
                return new ApiResult(ResultKind.Empty, status);
            }

            string type = response.Content.Headers.ContentType?.MediaType?.ToLowerInvariant() ?? "";
            if (!binary &&
                (type == "application/json" || type.EndsWith("+json", StringComparison.Ordinal)))
            {
                var raw = await response.Content.ReadAsStringAsync(lifetime.Token).ConfigureAwait(false);
                if (raw.Length == 0)
                {
                    return new ApiResult(ResultKind.Empty, status);
                }

                try
                {
                    return new ApiResult(ResultKind.Json, status, JsonNode.Parse(raw));
                }
                catch (JsonException error)
                {
                    throw new ThinkAIException("无效 JSON 响应。", status, raw, error);
                }
            }
            var stream = new ResponseStream(await response.Content.ReadAsStreamAsync(lifetime.Token).ConfigureAwait(false), response, lifetime, cancellationToken);
            transferred = true;
            return !binary && type == "text/event-stream"
                ? new ApiResult(ResultKind.Events, status, events: new EventStream(stream, status))
                : new ApiResult(ResultKind.Binary, status, binary: stream);
        }
        catch (OperationCanceledException error) when (
            !cancellationToken.IsCancellationRequested && !_closed.IsCancellationRequested)
        {
            throw new ThinkAIException("操作总时限已到。", response is null ? null : (int)response.StatusCode, innerException: error);
        }
        catch (HttpRequestException error)
        {
            throw new ThinkAIException("ThinkAI HTTP 传输失败。", error.StatusCode is null ? null : (int)error.StatusCode, innerException: error);
        }
        catch (IOException error)
        {
            throw new ThinkAIException("读取响应失败。", response is null ? null : (int)response.StatusCode, innerException: error);
        }
        finally
        {
            if (!transferred)
            {
                response?.Dispose();
                lifetime.Dispose();
                content?.Dispose();
            }
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        _closed.Cancel();
        if (_ownsHttp)
        {
            _http.Dispose();
        }

        _closed.Dispose();
    }
}
