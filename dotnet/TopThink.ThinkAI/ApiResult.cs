using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json.Nodes;

namespace TopThink.ThinkAI;

public enum ResultKind { Json, Events, Binary, Empty }

/// <summary>按实际 Content-Type 判别的响应；流式结果必须释放。</summary>
public sealed class ApiResult : IDisposable, IAsyncDisposable
{
    public ResultKind Kind { get; }
    public JsonNode? Json { get; }
    public EventStream? Events { get; }
    public Stream? Binary { get; }
    public int StatusCode { get; }
    internal ApiResult(ResultKind kind, int status, JsonNode? json = null, EventStream? events = null, Stream? binary = null)
        => (Kind, StatusCode, Json, Events, Binary) = (kind, status, json, events, binary);
    public void Dispose() { Events?.Dispose(); Binary?.Dispose(); }
    public async ValueTask DisposeAsync()
    {
        if (Events is not null) await Events.DisposeAsync().ConfigureAwait(false);
        if (Binary is not null) await Binary.DisposeAsync().ConfigureAwait(false);
    }
}

public sealed class ThinkAIException : Exception
{
    public int? StatusCode { get; }
    public string RawBody { get; }
    public ThinkAIException(string message, int? statusCode = null, string rawBody = "", Exception? innerException = null)
        : base(message, innerException) => (StatusCode, RawBody) = (statusCode, rawBody);
}

public sealed record SseEvent(string? Event, string? Id, string RawData, JsonNode? Data, string? Retry);

/// <summary>单次消费的 SSE 流；保留事件名、ID 和原始 JSON 数据。</summary>
public sealed class EventStream : IAsyncEnumerable<SseEvent>, IDisposable, IAsyncDisposable
{
    private readonly Stream _stream;
    private readonly int _status;
    private int _enumerated;
    internal EventStream(Stream stream, int status) => (_stream, _status) = (stream, status);
    public async IAsyncEnumerator<SseEvent> GetAsyncEnumerator(CancellationToken cancellationToken = default)
    {
        if (Interlocked.Exchange(ref _enumerated, 1) != 0) throw new InvalidOperationException("事件流只能读取一次。");
        using var reader = new StreamReader(_stream, new UTF8Encoding(false, true), true, 1024, leaveOpen: true);
        var data = new List<string>();
        string? eventName = null, id = null, retry = null;
        try
        {
            while (true)
            {
                if (_stream is ResponseStream active) active.CheckActive(cancellationToken);
                var line = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
                if (line is null) throw new ThinkAIException("事件流在 [DONE] 前截断。", _status, string.Join("\n", data), new EndOfStreamException());
                if (line is null || line.Length == 0)
                {
                    if (data.Count > 0)
                    {
                        var raw = string.Join("\n", data);
                        if (raw.Trim() == "[DONE]") yield break;
                        JsonNode? json;
                        try { json = JsonNode.Parse(raw); }
                        catch (System.Text.Json.JsonException error) { throw new ThinkAIException("无效 SSE JSON。", _status, raw, error); }
                        if (_stream is ResponseStream activeResult) activeResult.CheckActive(cancellationToken);
                        yield return new SseEvent(eventName, id, raw, json, retry);
                    }
                    data.Clear(); eventName = null; retry = null;
                    if (line is null) yield break;
                    continue;
                }
                if (line.StartsWith(':')) continue;
                int colon = line.IndexOf(':');
                var field = colon < 0 ? line : line[..colon];
                var value = colon < 0 ? "" : line[(colon + 1)..];
                if (value.StartsWith(' ')) value = value[1..];
                switch (field)
                {
                    case "data": data.Add(value); break;
                    case "event": eventName = value; break;
                    case "id" when !value.Contains('\0'): id = value; break;
                    case "retry": retry = value; break;
                }
            }
        }
        finally { await DisposeAsync().ConfigureAwait(false); }
    }
    public void Dispose() => _stream.Dispose();
    public ValueTask DisposeAsync() => _stream.DisposeAsync();
}

internal sealed class ResponseStream : Stream
{
    private readonly Stream _inner;
    private readonly HttpResponseMessage _response;
    private readonly CancellationTokenSource _lifetime;
    private readonly CancellationToken _caller;
    private bool _disposed;
    internal ResponseStream(Stream inner, HttpResponseMessage response, CancellationTokenSource lifetime, CancellationToken caller)
        => (_inner, _response, _lifetime, _caller) = (inner, response, lifetime, caller);
    public override bool CanRead => !_disposed && _inner.CanRead;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
    internal void CheckActive(CancellationToken cancellationToken = default)
    {
        _caller.ThrowIfCancellationRequested(); cancellationToken.ThrowIfCancellationRequested();
        if (_lifetime.IsCancellationRequested) throw new ThinkAIException("操作总时限已到。", (int)_response.StatusCode, innerException: new OperationCanceledException());
        ObjectDisposedException.ThrowIf(_disposed, this);
    }
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        CheckActive(cancellationToken);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token, cancellationToken);
        try { return await _inner.ReadAsync(buffer, linked.Token).ConfigureAwait(false); }
        catch (OperationCanceledException error) when (!_caller.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        { throw new ThinkAIException("操作总时限已到。", (int)_response.StatusCode, innerException: error); }
        catch (IOException error) { throw new ThinkAIException("读取响应失败。", (int)_response.StatusCode, innerException: error); }
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing && !_disposed) { _disposed = true; _inner.Dispose(); _response.Dispose(); _lifetime.Dispose(); }
        base.Dispose(disposing);
    }
    public override ValueTask DisposeAsync() { Dispose(); return ValueTask.CompletedTask; }
    public override void Flush() => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
