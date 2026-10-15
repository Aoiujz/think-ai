using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;

namespace TopThink.ThinkAI.Tests;

public sealed class TransportTests
{
    private sealed class Handler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> send)
        : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => send(request, cancellationToken);
    }

    private sealed class TrackedStream(byte[] bytes) : MemoryStream(bytes)
    {
        internal bool Closed;

        protected override void Dispose(bool disposing)
        {
            Closed = true;
            base.Dispose(disposing);
        }
    }

    private static HttpResponseMessage Response(string type, string body)
        => new(HttpStatusCode.OK)
        {
            Content = new StringContent(body, Encoding.UTF8, type)
        };

    [Fact]
    public async Task InjectedTransportPreservesExplicitNullUnknownFieldsAndJsonNull()
    {
        var input = new JsonObject { ["future"] = new JsonObject { ["present"] = null } };
        using var http = new HttpClient(new Handler(async (request, token) =>
        {
            var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(token));
            Assert.True(JsonNode.DeepEquals(input, body));
            Assert.Equal("Bearer offline", request.Headers.Authorization!.ToString());
            Assert.Equal("ThinkAI-dotnet/" + ThinkAIClient.Version, request.Headers.UserAgent.ToString());
            return Response("application/json", "null");
        }));
        using var client = new ThinkAIClient("offline", httpClient: http);
        using var result = await client.Images.GenerationsAsync(input);
        Assert.Equal(ResultKind.Json, result.Kind);
        Assert.Null(result.Json);
        Assert.True(input["future"]!.AsObject().ContainsKey("present"));
    }

    [Fact]
    public async Task BinaryEarlyCloseDisposesResponseAndSdkDisposalIsIdempotent()
    {
        var stream = new TrackedStream(new byte[] { 0, 255, 42 });
        using var http = new HttpClient(new Handler((request, token) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StreamContent(stream)
            })));
        var client = new ThinkAIClient("offline", httpClient: http);
        var result = await client.Audio.SpeechAsync(new JsonObject());
        Assert.Equal(ResultKind.Binary, result.Kind);
        Assert.Equal(0, result.Binary!.ReadByte());
        result.Dispose();
        result.Dispose();
        Assert.True(stream.Closed);
        client.Dispose();
        client.Dispose();
    }

    [Fact]
    public async Task SseEofWithoutDoneRaisesProtocolErrorAndClosesStream()
    {
        var stream = new TrackedStream(Encoding.UTF8.GetBytes("id: one\nevent: custom\ndata: {\"future\":null}\n\n"));
        using var http = new HttpClient(new Handler((request, token) =>
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StreamContent(stream)
            };
            response.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("text/event-stream");
            return Task.FromResult(response);
        }));
        using var client = new ThinkAIClient("offline", httpClient: http);
        using var result = await client.Responses.CreateAsync(new JsonObject());
        await using var events = result.Events!.GetAsyncEnumerator();
        Assert.True(await events.MoveNextAsync());
        Assert.Equal("one", events.Current.Id);
        Assert.Equal("custom", events.Current.Event);
        Assert.True(events.Current.Data!.AsObject().ContainsKey("future"));
        var error = await Assert.ThrowsAsync<ThinkAIException>(async () => await events.MoveNextAsync());
        Assert.IsType<EndOfStreamException>(error.InnerException);
        Assert.True(stream.Closed);
    }

    [Fact]
    public async Task TransportFailuresKeepOriginalCause()
    {
        var failure = new HttpRequestException("offline connection failure");
        using var http = new HttpClient(new Handler((request, token) => throw failure));
        using var client = new ThinkAIClient("offline", httpClient: http);
        var error = await Assert.ThrowsAsync<ThinkAIException>(() => client.Model.ListAsync());
        Assert.Same(failure, error.InnerException);
        Assert.Null(error.StatusCode);
    }

    [Fact]
    public async Task AvatarMissingOrUnknownStatusDoesNotPollForever()
    {
        int requests = 0;
        using var http = new HttpClient(new Handler((request, token) => Task.FromResult(Response("application/json", ++requests == 1 ? "{\"id\":\"original\"}" : "{\"status\":\"unexpected\"}"))));
        using var client = new ThinkAIClient("offline", httpClient: http);
        await Assert.ThrowsAsync<ThinkAIException>(() => client.Avatar.VideoAsync(new JsonObject { ["model"] = "offline" }, true));
        Assert.Equal(2, requests);
    }
}
