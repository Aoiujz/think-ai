package com.topthink.ai;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.*;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

/** Java 17 同步客户端，动态参数原样发送，无 SDK 自动重试，HTTPS 使用 JDK 默认 TLS 验证。 */
public final class ThinkAIClient implements AutoCloseable {
    public static final String VERSION = "1.0.1";
    private final String token;
    private final URI endpoint;
    private final Duration timeout, pollInterval;
    private final HttpClient http;
    private final ObjectMapper mapper = new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private final CancellationToken closed = new CancellationToken();

    public ThinkAIClient(String token) {
        this(builder(token));
    }

    private ThinkAIClient(Builder builder) {
        if (builder.token == null || builder.token.isBlank()) {
            throw new IllegalArgumentException("token 不能为空。");
        }
        if (!builder.endpoint.isAbsolute() || !Set.of("http", "https")
                .contains(builder.endpoint.getScheme())) {
            throw new IllegalArgumentException("endpoint 必须为 HTTP(S) 绝对地址。");
        }
        if (builder.timeout.isNegative() || builder.timeout.isZero() || builder.pollInterval.isNegative() || builder.pollInterval.isZero()) {
            throw new IllegalArgumentException("超时及轮询间隔必须大于零。");
        }
        token = builder.token;
        // @formatter:off
        endpoint = URI.create(builder.endpoint.toString().replaceAll("/+$", "") + "/");
        // @formatter:on
        timeout = builder.timeout;
        pollInterval = builder.pollInterval;
        http = builder.http == null
                ? HttpClient.newBuilder()
                        .followRedirects(HttpClient.Redirect.NEVER)
                        .build()
                : builder.http;
    }

    public static Builder builder(String token) {
        return new Builder(token);
    }

    public static final class Builder {
        private final String token;
        private URI endpoint = URI.create("https://ai.topthink.com/");
        private Duration timeout = Duration.ofSeconds(300), pollInterval = Duration.ofSeconds(5);
        private HttpClient http;

        private Builder(String token) {
            this.token = token;
        }

        public Builder endpoint(URI value) {
            endpoint = Objects.requireNonNull(value);
            return this;
        }

        public Builder timeout(Duration value) {
            timeout = Objects.requireNonNull(value);
            return this;
        }

        public Builder pollInterval(Duration value) {
            pollInterval = Objects.requireNonNull(value);
            return this;
        }

        public Builder httpClient(HttpClient value) {
            http = Objects.requireNonNull(value);
            return this;
        }

        public ThinkAIClient build() {
            return new ThinkAIClient(this);
        }
    }

    static Map<String, Object> object(Object... entries) {
        var map = new LinkedHashMap<String, Object>();
        for (int i = 0; i < entries.length; i += 2) {
            map.put((String) entries[i], entries[i + 1]);
        }
        return map;
    }

    static String segment(String text) {
        return URLEncoder.encode(text, StandardCharsets.UTF_8)
                .replace("+", "%20");
    }

    private void queryPairs(List<String> pairs, String key, JsonNode value) {
        if (value == null || value.isNull()) {
            return;
        }
        if (value.isObject()) {
            value.fields()
                    .forEachRemaining(entry -> queryPairs(pairs, key + "[" + entry.getKey() + "]", entry.getValue()));
            return;
        }
        if (value.isArray()) {
            for (int i = 0; i < value.size(); i++) {
                queryPairs(pairs, key + "[" + i + "]", value.get(i));
            }
            return;
        }
        pairs.add(segment(key) + "=" + segment(value.isBoolean() ? (value.booleanValue() ? "1" : "0") : value.asText()));
    }

    ApiResult request(String method, String path, Map<String, ?> body, Map<String, ?> query, RequestOptions options) {
        try {
            var publisher = body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(mapper.writeValueAsBytes(body));
            return execute(method, path, publisher, body == null ? null : "application/json", query, options);
        } catch (com.fasterxml.jackson.core.JsonProcessingException error) {
            throw new ThinkAIException("请求不是可序列化 JSON。", null, "", error);
        }
    }

    ApiResult execute(String method, String path, HttpRequest.BodyPublisher publisher, String contentType, Map<String, ?> query, RequestOptions options) {
        return execute(method, path, publisher, contentType, query, options, false);
    }

    ApiResult execute(String method, String path, HttpRequest.BodyPublisher publisher, String contentType, Map<String, ?> query, RequestOptions options, boolean binary) {
        closed.throwIfCancelled();
        Duration operationTimeout = options != null && options.timeout() != null ? options.timeout() : timeout;
        CancellationToken cancellation = options != null && options.cancellationToken() != null ? options.cancellationToken() : new CancellationToken();
        cancellation.throwIfCancelled();
        long deadline = System.nanoTime() + operationTimeout.toNanos();
        var pairs = new ArrayList<String>();
        if (query != null) {
            query.forEach((key, value) -> queryPairs(pairs, key, mapper.valueToTree(value)));
        }
        URI uri = endpoint.resolve(path + (pairs.isEmpty() ? "" : "?" + String.join("&", pairs)));
        var builder = HttpRequest.newBuilder(uri)
                .timeout(operationTimeout)
                .header("Authorization", "Bearer " + token)
                .header("User-Agent", "ThinkAI-java/" + VERSION)
                .header("Accept", "application/json, text/event-stream, application/octet-stream");
        if (contentType != null) {
            builder.header("Content-Type", contentType);
        }
        // @formatter:off
        var future = http.sendAsync(builder.method(method, publisher).build(), HttpResponse.BodyHandlers.ofInputStream());
        // @formatter:on
        try (var registration = cancellation.register(() -> future.cancel(true)); var shutdown = closed.register(() -> future.cancel(true))) {
            HttpResponse<InputStream> response = future.get(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
            int status = response.statusCode();
            var stream = new DeadlineInputStream(response.body(), status, deadline - System.nanoTime(), cancellation, closed);
            if (status < 200 || status >= 300) {
                try (stream) {
                    throw new ThinkAIException("ThinkAI HTTP " + status, status, new String(stream.readAllBytes(), StandardCharsets.UTF_8));
                }
            }
            if (status == 204 || status == 205 || (!binary && response.headers()
                    .firstValueAsLong("Content-Length")
                    .orElse(-1) == 0)) {
                stream.close();
                return new ApiResult.Empty(status);
            }
            String type = response.headers()
                    .firstValue("Content-Type")
                    .orElse("")
                    .split(";", 2)[0].trim()
                    .toLowerCase(Locale.ROOT);
            if (!binary && (type.equals("application/json") || type.endsWith("+json"))) {
                try (stream) {
                    String raw = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
                    if (raw.isEmpty()) {
                        return new ApiResult.Empty(status);
                    }
                    try {
                        JsonNode json = mapper.readTree(raw);
                        if (json == null) {
                            throw new IOException("Empty JSON document");
                        }
                        return new ApiResult.Json(status, json);
                    } catch (IOException error) {
                        throw new ThinkAIException("无效 JSON 响应。", status, raw, error);
                    }
                }
            }
            if (!binary && type.equals("text/event-stream")) {
                return new ApiResult.Events(status, new EventStream(stream, mapper, status));
            }
            return new ApiResult.Binary(status, stream);
        } catch (InterruptedException error) {
            future.cancel(true);
            Thread.currentThread()
                    .interrupt();
            throw new ThinkAIException("操作已中断。", null, "", error);
        } catch (TimeoutException error) {
            future.cancel(true);
            throw new ThinkAIException("操作总时限已到。", null, "", error);
        } catch (CancellationException error) {
            throw new ThinkAIException("操作已取消。", null, "", error);
        } catch (ExecutionException error) {
            throw new ThinkAIException("ThinkAI HTTP 传输失败。", null, "", error.getCause());
        } catch (IOException error) {
            throw new ThinkAIException("读取响应失败。", null, "", error);
        }
    }

    public Responses responses() {
        return new Responses();
    }

    public Chat chat() {
        return new Chat();
    }

    public Images images() {
        return new Images();
    }

    public Videos videos() {
        return new Videos();
    }

    public Audio audio() {
        return new Audio();
    }

    public Avatar avatar() {
        return new Avatar();
    }

    public Music music() {
        return new Music();
    }

    public Embeddings embeddings() {
        return new Embeddings();
    }

    public Rerank rerank() {
        return new Rerank();
    }

    public Decision decision() {
        return new Decision();
    }

    public Plugin plugin() {
        return new Plugin();
    }

    public Model model() {
        return new Model();
    }

    public Sandbox sandbox() {
        return new Sandbox();
    }

    public Skill skill() {
        return new Skill();
    }

    public abstract class Resource {
        ApiResult post(String path, Map<String, ?> parameters, RequestOptions options) {
            return request("POST", path, parameters == null ? Map.of() : parameters, null, options);
        }

        ApiResult get(String path, Map<String, ?> query, RequestOptions options) {
            return request("GET", path, null, query, options);
        }
    }

    public final class Responses extends Resource {
        public ApiResult create(Map<String, ?> parameters) {
            return create(parameters, null);
        }

        public ApiResult create(Map<String, ?> parameters, RequestOptions options) {
            return post("responses", parameters, options);
        }
    }

    public final class Chat extends Resource {
        public ApiResult completions(Map<String, ?> parameters) {
            return completions(parameters, null);
        }

        public ApiResult completions(Map<String, ?> parameters, RequestOptions options) {
            var body = new LinkedHashMap<String, Object>(parameters);
            if (!body.containsKey("stream")) {
                body.put("stream", true);
            }
            return post("chat/completions", body, options);
        }
    }

    public final class Images extends Resource {
        public ApiResult generations(Map<String, ?> p) {
            return generations(p, null);
        }

        public ApiResult generations(Map<String, ?> p, RequestOptions o) {
            return post("images/generations", p, o);
        }

        public ApiResult inpainting(Map<String, ?> p) {
            return inpainting(p, null);
        }

        public ApiResult inpainting(Map<String, ?> p, RequestOptions o) {
            return post("images/inpainting", p, o);
        }

        public ApiResult outpainting(Map<String, ?> p) {
            return outpainting(p, null);
        }

        public ApiResult outpainting(Map<String, ?> p, RequestOptions o) {
            return post("images/outpainting", p, o);
        }

        public ApiResult upscale(Map<String, ?> p) {
            return upscale(p, null);
        }

        public ApiResult upscale(Map<String, ?> p, RequestOptions o) {
            return post("images/upscale", p, o);
        }

        public ApiResult poster(Map<String, ?> p) {
            return poster(p, null);
        }

        public ApiResult poster(Map<String, ?> p, RequestOptions o) {
            return post("images/poster", p, o);
        }

        public ApiResult edit(Map<String, ?> p) {
            return edit(p, null);
        }

        public ApiResult edit(Map<String, ?> p, RequestOptions o) {
            return post("images/edit", p, o);
        }
    }

    public final class Videos extends Resource {
        public ApiResult generations(Map<String, ?> p) {
            return generations(p, null);
        }

        public ApiResult generations(Map<String, ?> p, RequestOptions o) {
            return post("videos/generations", p, o);
        }

        public ApiResult query(Map<String, ?> p) {
            return query(p, null);
        }

        public ApiResult query(Map<String, ?> p, RequestOptions o) {
            return post("videos/query", p, o);
        }
    }

    public final class Audio extends Resource {
        public ApiResult speech(Map<String, ?> p) {
            return speech(p, null);
        }

        public ApiResult speech(Map<String, ?> p, RequestOptions o) {
            return post("audio/speech", p, o);
        }

        public ApiResult transcriptions(Map<String, ?> p) {
            return transcriptions(p, null);
        }

        public ApiResult transcriptions(Map<String, ?> p, RequestOptions o) {
            return post("audio/transcriptions", p, o);
        }
    }

    public final class Avatar extends Resource {
        public ApiResult video(Map<String, ?> p) {
            return video(p, false, Duration.ofSeconds(300), pollInterval, null);
        }

        public ApiResult video(Map<String, ?> p, boolean wait) {
            return video(p, wait, Duration.ofSeconds(300), pollInterval, null);
        }

        public ApiResult video(Map<String, ?> p, boolean wait, Duration waitTimeout, Duration interval, RequestOptions options) {
            if (!wait) {
                return post("avatar/video", p, options);
            }
            if (waitTimeout.isNegative() || waitTimeout.isZero() || interval.isNegative() || interval.isZero()) {
                throw new IllegalArgumentException("等待时限及轮询间隔必须大于零。");
            }
            CancellationToken token = options != null && options.cancellationToken() != null ? options.cancellationToken() : new CancellationToken();
            var created = post("avatar/video", p, options);
            if (!(created instanceof ApiResult.Json)) {
                created.close();
                throw new ThinkAIException("Avatar 创建响应不是 JSON。", created.statusCode(), "");
            }
            JsonNode id = created.json()
                    .get("id");
            created.close();
            if (id == null || id.isNull()) {
                throw new ThinkAIException("Avatar 创建响应缺少 id。", created.statusCode(), "");
            }
            long deadline = System.nanoTime() + waitTimeout.toNanos();
            while (true) {
                var result = query(object("model", p.get("model"), "id", id), pollOptions(deadline, options, token));
                String status = result instanceof ApiResult.Json json
                        ? json.value()
                                .path("status")
                                .asText()
                        : "";
                if (status.equals("success") || status.equals("fail")) {
                    return result;
                }
                if (!status.equals("processing")) {
                    result.close();
                    throw new ThinkAIException("Avatar 查询响应包含未知或缺少 status。", result.statusCode(), "");
                }
                result.close();
                long left = deadline - System.nanoTime();
                if (left <= 0) {
                    throw new ThinkAIException("Avatar 等待超时。", null, "", new TimeoutException());
                }
                token.pause(Duration.ofNanos(Math.min(left, interval.toNanos())));
            }
        }

        private RequestOptions pollOptions(long deadline, RequestOptions options, CancellationToken token) {
            long left = deadline - System.nanoTime();
            if (left <= 0) {
                throw new ThinkAIException("Avatar 等待超时。", null, "", new TimeoutException());
            }
            Duration perRequest = options != null && options.timeout() != null ? options.timeout() : timeout;
            return new RequestOptions(Duration.ofNanos(Math.min(left, perRequest.toNanos())), token);
        }

        public ApiResult query(Map<String, ?> p) {
            return query(p, null);
        }

        public ApiResult query(Map<String, ?> p, RequestOptions o) {
            return post("avatar/query", p, o);
        }
    }

    public final class Music extends Resource {
        public ApiResult song(Map<String, ?> p) {
            return song(p, null);
        }

        public ApiResult song(Map<String, ?> p, RequestOptions o) {
            return post("music/song", p, o);
        }

        public ApiResult bgm(Map<String, ?> p) {
            return bgm(p, null);
        }

        public ApiResult bgm(Map<String, ?> p, RequestOptions o) {
            return post("music/bgm", p, o);
        }

        public ApiResult query(Map<String, ?> p) {
            return query(p, null);
        }

        public ApiResult query(Map<String, ?> p, RequestOptions o) {
            return post("music/query", p, o);
        }
    }

    public final class Embeddings extends Resource {
        public ApiResult create(Map<String, ?> p) {
            return create(p, null);
        }

        public ApiResult create(Map<String, ?> p, RequestOptions o) {
            return post("embeddings", p, o);
        }
    }

    public final class Rerank extends Resource {
        public ApiResult create(Map<String, ?> p) {
            return create(p, null);
        }

        public ApiResult create(Map<String, ?> p, RequestOptions o) {
            return post("rerank", p, o);
        }
    }

    public final class Decision extends Resource {
        public ApiResult evaluate(Map<String, ?> p) {
            return evaluate(p, null);
        }

        public ApiResult evaluate(Map<String, ?> p, RequestOptions o) {
            return post("decisions", p, o);
        }
    }

    public final class Plugin extends Resource {
        public ApiResult list() {
            return list(Map.of());
        }

        public ApiResult list(Map<String, ?> p) {
            return list(p, null);
        }

        public ApiResult list(Map<String, ?> p, RequestOptions o) {
            return get("plugin", p, o);
        }
    }

    public final class Model extends Resource {
        public ApiResult list() {
            return list(Map.of());
        }

        public ApiResult list(Map<String, ?> p) {
            return list(p, null);
        }

        public ApiResult list(Map<String, ?> p, RequestOptions o) {
            return get("model", p, o);
        }

        public ApiResult show(String type, String code) {
            return show(type, code, null);
        }

        public ApiResult show(String type, String code, RequestOptions o) {
            return get("model/" + segment(type) + "/" + segment(code), null, o);
        }
    }

    public final class Sandbox extends Resource {
        private String path(String id, String suffix) {
            return "sandbox/" + segment(id) + suffix;
        }

        public ApiResult create() {
            return create(null);
        }

        public ApiResult create(String name) {
            return create(name, null);
        }

        public ApiResult create(String name, RequestOptions o) {
            return post("sandbox", object("name", name), o);
        }

        public ApiResult get(String name) {
            return get(name, null);
        }

        public ApiResult get(String name, RequestOptions o) {
            return super.get(path(name, ""), null, o);
        }

        public void delete(String name) {
            delete(name, null);
        }

        public void delete(String name, RequestOptions o) {
            try (var ignored = request("DELETE", path(name, ""), null, null, o)) {}
        }

        public ApiResult listFile(String id) {
            return listFile(id, null);
        }

        public ApiResult listFile(String id, String path) {
            return listFile(id, path, null);
        }

        public ApiResult listFile(String id, String path, RequestOptions o) {
            return super.get(path(id, "/list"), object("path", path), o);
        }

        public ApiResult readFile(String id, String path) {
            return readFile(id, path, null);
        }

        public ApiResult readFile(String id, String path, RequestOptions o) {
            return super.get(path(id, "/read"), object("path", path), o);
        }

        public ApiResult writeFile(String id, String path, String content) {
            return writeFile(id, path, content, null);
        }

        public ApiResult writeFile(String id, String path, String content, RequestOptions o) {
            return post(path(id, "/write"), object("path", path, "content", content), o);
        }

        public ApiResult editFile(String id, String path, String oldStr) {
            return editFile(id, path, oldStr, "");
        }

        public ApiResult editFile(String id, String path, String oldStr, String newStr) {
            return editFile(id, path, oldStr, newStr, null);
        }

        public ApiResult editFile(String id, String path, String oldStr, String newStr, RequestOptions o) {
            return post(path(id, "/edit"), object("path", path, "old_str", oldStr, "new_str", newStr), o);
        }

        public ApiResult uploadFile(String id, String path, Path file) {
            return uploadFile(id, path, file, null);
        }

        public ApiResult uploadFile(String id, String path, Path file, RequestOptions o) {
            try {
                return upload(id, path, HttpRequest.BodyPublishers.ofFile(file), o);
            } catch (FileNotFoundException error) {
                throw new ThinkAIException("无法打开上传文件。", null, "", error);
            }
        }

        public ApiResult uploadFile(String id, String path, InputStream file) {
            return uploadFile(id, path, file, null);
        }

        /** 调用者拥有 file，SDK 不关闭调用者传入的流。 */
        public ApiResult uploadFile(String id, String path, InputStream file, RequestOptions o) {
            return upload(id, path, HttpRequest.BodyPublishers.ofInputStream(() -> new FilterInputStream(file) {
                @Override
                public void close() {}
            }), o);
        }

        private ApiResult upload(String id, String path, HttpRequest.BodyPublisher file, RequestOptions o) {
            String boundary = "thinkai-" + UUID.randomUUID();
            String filename = path.replace('\\', '/');
            filename = filename.substring(filename.lastIndexOf('/') + 1)
                    .replace("\"", "%22")
                    .replace("\r", "%0D")
                    .replace("\n", "%0A");
            String prefix = "--" + boundary + "\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n" + path + "\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + filename + "\"\r\nContent-Type: application/octet-stream\r\n\r\n";
            var body = HttpRequest.BodyPublishers.concat(HttpRequest.BodyPublishers.ofString(prefix, StandardCharsets.UTF_8), file, HttpRequest.BodyPublishers.ofString("\r\n--" + boundary + "--\r\n"));
            return execute("POST", path(id, "/upload"), body, "multipart/form-data; boundary=" + boundary, null, o);
        }

        public ApiResult downloadFile(String id, String path) {
            return downloadFile(id, path, null);
        }

        public ApiResult downloadFile(String id, String path, RequestOptions o) {
            return execute("GET", path(id, "/download"), HttpRequest.BodyPublishers.noBody(), null, object("path", path), o, true);
        }

        public ApiResult runCode(String id, String code) {
            return runCode(id, code, List.of());
        }

        public ApiResult runCode(String id, String code, List<?> files) {
            return runCode(id, code, files, null);
        }

        public ApiResult runCode(String id, String code, List<?> files, RequestOptions o) {
            return post(path(id, "/code"), object("code", code, "files", files), o);
        }

        public ApiResult runCommand(String id, String command) {
            return runCommand(id, command, false);
        }

        public ApiResult runCommand(String id, String command, boolean stream) {
            return runCommand(id, command, stream, null);
        }

        public ApiResult runCommand(String id, String command, boolean stream, RequestOptions o) {
            return post(path(id, "/command"), object("command", command, "stream", stream), o);
        }
    }

    public final class Skill extends Resource {
        public ApiResult list() {
            return list(Map.of());
        }

        public ApiResult list(Map<String, ?> p) {
            return list(p, null);
        }

        public ApiResult list(Map<String, ?> p, RequestOptions o) {
            return get("skill", p, o);
        }

        public ApiResult categories() {
            return categories(null);
        }

        public ApiResult categories(RequestOptions o) {
            return get("skill/category", null, o);
        }

        public ApiResult download(String path) {
            return download(path, null);
        }

        public ApiResult download(String path, RequestOptions o) {
            return execute("GET", "skill/download", HttpRequest.BodyPublishers.noBody(), null, object("path", path), o, true);
        }
    }

    @Override
    public void close() {
        closed.cancel();
    }
}
