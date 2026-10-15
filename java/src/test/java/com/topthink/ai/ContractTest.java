package com.topthink.ai;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import org.junit.jupiter.api.*;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.*;
import java.net.URI;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

class ContractTest {
    static final ObjectMapper JSON = new ObjectMapper();
    static Process server;
    static URI endpoint;
    static Path root;

    @BeforeAll
    static void start() throws Exception {
        root = Path.of("")
                .toAbsolutePath();
        while (root != null && !Files.exists(root.resolve("tests/contracts/server.mjs"))) {
            root = root.getParent();
        }
        assertNotNull(root, "找不到共享离线协议服务");
        // @formatter:off
        var builder = new ProcessBuilder("node", root.resolve("tests/contracts/server.mjs").toString());
        builder.environment()
                .put("PORT", "0");
        server = builder.start();
        String line = new BufferedReader(new InputStreamReader(server.getInputStream(), StandardCharsets.UTF_8)).readLine();
        endpoint = URI.create(JSON.readTree(line).path("endpoint").asText());
        // @formatter:on
    }

    @AfterAll
    static void stop() {
        if (server != null) {
            server.destroyForcibly();
        }
    }

    static ThinkAIClient client() {
        return ThinkAIClient.builder("offline-token")
                .endpoint(endpoint)
                .timeout(Duration.ofSeconds(5))
                .pollInterval(Duration.ofMillis(2))
                .build();
    }

    static Map<String, Object> params(String mode) {
        var p = ThinkAIClient.object("model", "offline-model", "stream", false, "custom", ThinkAIClient.object("nested", Arrays.asList(1, "你好", null)));
        if (mode != null) {
            p.put("__case", mode);
        }
        return p;
    }

    static JsonNode control(String path, boolean post) throws Exception {
        var request = HttpRequest.newBuilder(endpoint.resolve(path));
        if (post) {
            request.POST(HttpRequest.BodyPublishers.noBody());
        }
        // @formatter:off
        return JSON.readTree(HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString()).body());
        // @formatter:on
    }

    static List<EventStream.Event> events(ApiResult result) {
        var output = new ArrayList<EventStream.Event>();
        for (var item : ((ApiResult.Events) result).stream()) {
            output.add(item);
        }
        return output;
    }

    ApiResult invoke(ThinkAIClient client, String resource, String operation) throws Exception {
        if (resource.equals("sandbox")) {
            var sandbox = client.sandbox();
            return switch (operation) {
                case "create" -> sandbox.create("box");
                case "get" -> sandbox.get("box");
                case "delete" -> {
                    sandbox.delete("box");
                    yield null;
                }
                case "listFile" -> sandbox.listFile("box", "folder/文 件&x.bin");
                case "readFile" -> sandbox.readFile("box", "folder/文 件&x.bin");
                case "writeFile" -> sandbox.writeFile("box", "folder/文 件&x.bin", "hello");
                case "editFile" -> sandbox.editFile("box", "folder/文 件&x.bin", "old", "new");
                case "uploadFile" -> sandbox.uploadFile("box", "folder/文 件&x.bin", new ByteArrayInputStream(new byte[]{0, 1, (byte) 255, 42}));
                case "downloadFile" -> sandbox.downloadFile("box", "folder/文 件&x.bin");
                case "runCode" -> sandbox.runCode("box", "code", List.of(ThinkAIClient.object("url", "https://example.test/a", "name", "a.txt", "extra", true)));
                case "runCommand" -> sandbox.runCommand("box", "echo 你好");
                default -> throw new AssertionError(operation);
            };
        }
        if (resource.equals("model") && operation.equals("show")) {
            return client.model()
                    .show("chat", "code");
        }
        if (resource.equals("skill") && operation.equals("categories")) {
            return client.skill()
                    .categories();
        }
        if (resource.equals("skill") && operation.equals("download")) {
            return client.skill()
                    .download("folder/文 件&x.bin");
        }
        var target = ThinkAIClient.class.getMethod(resource)
                .invoke(client);
        return (ApiResult) target.getClass()
                .getMethod(operation, Map.class)
                .invoke(target, params(null));
    }

    @Test
    void all37SharedOperationsSendCorrectRoutesAndPayloads() throws Exception {
        control("__reset", true);
        // @formatter:off
        var manifest = JSON.readTree(root.resolve("tests/contracts/operations.json").toFile());
        // @formatter:on
        assertEquals(37, manifest.size());
        try (var client = client()) {
            int count = 0;
            for (JsonNode entry : manifest) {
                String resource = entry.path("resource")
                        .asText(), operation = entry.path("operation")
                                .asText();
                // @formatter:off
                try (var result = invoke(client, resource, operation)) {
                    if (result instanceof ApiResult.Events) {
                        assertFalse(events(result).isEmpty());
                    }
                    if (result instanceof ApiResult.Binary binary) {
                        assertArrayEquals(new byte[]{0, 1, 2, (byte) 255, 10, 13, 80, 75}, binary.stream().readAllBytes());
                    }
                }
                JsonNode captured = control("__requests", false).get(count++);
                assertEquals(entry.path("http_method").asText(), captured.path("method").asText());
                assertEquals("/" + entry.path("path").asText().replace("{id}", "box").replace("{type}", "chat").replace("{code}", "code"), captured.path("path").asText());
                assertEquals("Bearer offline-token", captured.path("authorization").asText());
                if (captured.path("body")
                        .has("custom")) {
                    assertEquals(JSON.valueToTree(params(null).get("custom")), captured.path("body").get("custom"));
                }
                if (operation.equals("runCode")) {
                    assertEquals("https://example.test/a", captured.at("/body/files/0/url").asText());
                }
                if (operation.equals("uploadFile")) {
                    byte[] raw = Base64.getDecoder()
                            .decode(captured.path("raw_base64").asText());
                    String multipart = new String(raw, StandardCharsets.UTF_8);
                    assertTrue(multipart.contains("name=\"path\""));
                    assertTrue(multipart.contains("name=\"file\""));
                    assertTrue(multipart.contains("filename=\"文 件&x.bin\""));
                    boolean found = false;
                    for (int i = 0; i + 4 <= raw.length; i++) {
                        if (raw[i] == 0 && raw[i + 1] == 1 && raw[i + 2] == (byte) 255 && raw[i + 3] == 42) {
                            found = true;
                        }
                    }
                    assertTrue(found);
                }
                // @formatter:on
            }
            assertEquals(37, control("__requests", false).size());
        }
    }

    @Test
    void contentTypeDecidesJsonBinaryOrEventsAndChatDoesNotMutateInput() {
        try (var client = client()) {
            var p = params("json");
            p.remove("stream");
            // @formatter:off
            try (var result = client.chat()
                    .completions(p)) {
                assertInstanceOf(ApiResult.Json.class, result);
                assertTrue(result.json().at("/body/stream").asBoolean());
                assertFalse(p.containsKey("stream"));
            }
            try (var result = client.chat()
                    .completions(params(null))) {
                assertInstanceOf(ApiResult.Json.class, result);
            }
            try (var result = client.chat()
                    .completions(Map.of("model", "offline"))) {
                assertEquals(2, events(result).size());
            }
            try (var result = client.audio()
                    .speech(params("audio-sse"))) {
                assertEquals("AAEC", events(result).get(0).data().at("/audio/data").asText());
            }
            try (var result = client.sandbox()
                    .runCommand("box", "echo hi", true)) {
                assertEquals(2, events(result).size());
            }
            // @formatter:on
        }
    }

    @Test
    void fragmentedUtf8AndThinkAiEventErrorsRemainData() {
        try (var client = client()) {
            // @formatter:off
            try (var result = client.chat()
                    .completions(params("fragmented-sse"))) {
                var events = events(result);
                assertEquals("你好🌍", events.get(0).data().at("/delta/content").asText());
                assertEquals("message", events.get(0).event());
            }
            try (var result = client.responses()
                    .create(params("responses-error"))) {
                var events = events(result);
                assertEquals(4, events.size());
                assertEquals("Offline event error", events.get(1).data().at("/chunks/error").asText());
                assertTrue(events.get(2).data().has("stats"));
                assertTrue(events.get(3).data().has("id"));
            }
            // @formatter:on
        }
    }

    @ParameterizedTest
    @ValueSource(ints = {400, 422, 429, 500})
    void errorsPreserveStatusRawBodyAndAreNotRetried(int status) throws Exception {
        control("__reset", true);
        try (var client = client()) {
            var p = params("error");
            p.put("__status", status);
            // @formatter:off
            var error = assertThrows(ThinkAIException.class, () -> client.images().generations(p));
            assertEquals(status, error.statusCode());
            assertTrue(error.rawBody().contains("Offline fixture error"));
            assertEquals(1, control("__requests", false).size());
            // @formatter:on
        }
    }

    @Test
    void invalidJsonSseAndDisconnectedStreamFailVisibly() {
        try (var client = client()) {
            // @formatter:off
            var error = assertThrows(ThinkAIException.class, () -> client.images().generations(params("invalid-json")));
            assertEquals("{invalid", error.rawBody());
            assertNotNull(error.getCause());
            // @formatter:on
            try (var result = client.responses()
                    .create(params("invalid-sse"))) {
                assertThrows(ThinkAIException.class, () -> events(result));
            }
            try (var result = client.responses()
                    .create(params("disconnect"))) {
                assertThrows(ThinkAIException.class, () -> events(result));
            }
        }
    }

    @Test
    void totalTimeoutAndCancellationCoverStreamReading() {
        var slow = params("slow");
        slow.put("__delay_ms", 1000);
        try (var client = ThinkAIClient.builder("offline-token")
                .endpoint(endpoint)
                .timeout(Duration.ofMillis(150))
                .build()) {
            try (var result = client.responses()
                    .create(slow)) {
                assertNotNull(assertThrows(ThinkAIException.class, () -> events(result)).getCause());
            }
        }
        try (var client = client(); var cancel = new CancellationToken()) {
            try (var result = client.responses()
                    .create(slow, RequestOptions.withCancellation(cancel))) {
                cancel.cancel();
                var error = assertThrows(ThinkAIException.class, () -> events(result));
                assertInstanceOf(CancellationException.class, error.getCause());
            }
        }
    }

    @Test
    void avatarUsesOriginalIdReturnsFailAndStopsImmediatelyOnHttpError() throws Exception {
        control("__reset", true);
        try (var client = client()) {
            // @formatter:off
            try (var result = client.avatar()
                    .video(params("wait-success"))) {
                assertEquals("processing", result.json().path("status").asText());
                assertEquals(1, control("__requests", false).size());
            }
            try (var result = client.avatar()
                    .video(params("wait-success"), true)) {
                assertEquals("success", result.json().path("status").asText());
            }
            try (var result = client.avatar()
                    .video(params("wait-fail"), true)) {
                assertEquals("fail", result.json().path("status").asText());
            }
            assertEquals(403, assertThrows(ThinkAIException.class, () -> client.avatar().video(params("wait-error"), true)).statusCode());
            assertThrows(ThinkAIException.class, () -> client.avatar().video(params("wait-timeout"), true, Duration.ofMillis(40), Duration.ofMillis(2), null));
            for (JsonNode request : control("__requests", false)) {
                if (request.path("path")
                        .asText()
                        .equals("/avatar/query")) {
                    assertTrue(request.at("/body/id").asText().startsWith("offline-task-"));
                }
            }
            // @formatter:on
        }
    }

    @Test
    void endpointPrefixEscapedPathAndNestedPhpStyleQueries() {
        var injected = HttpClient.newHttpClient();
        // @formatter:off
        try (var client = ThinkAIClient.builder("offline-token")
                .endpoint(endpoint.resolve("prefix"))
                .httpClient(injected)
                .build()) {
            try (var result = client.model()
                    .show("chat", "code/a b")) {
                assertEquals("/prefix/model/chat/code%2Fa%20b", result.json().path("path").asText());
            }
            try (var result = client.model()
                    .list(ThinkAIClient.object("enabled", false, "tags", List.of("a", "b"), "filter", Map.of("q", "你好"), "skip", null))) {
                var query = result.json()
                        .path("query");
                assertEquals("0", query.path("enabled").asText());
                assertEquals("a", query.path("tags[0]").asText());
                assertEquals("b", query.path("tags[1]").asText());
                assertEquals("你好", query.path("filter[q]").asText());
                assertFalse(query.has("skip"));
            }
        }
        assertDoesNotThrow(() -> injected.send(HttpRequest.newBuilder(endpoint.resolve("__health")).build(), HttpResponse.BodyHandlers.ofString()));
        // @formatter:on
    }

    @Test
    void downloadedJsonRetainsExactBytes() throws Exception {
        try (var client = client();
                var result = client.sandbox()
                        .downloadFile("box", "fixture.json")) {
            var binary = assertInstanceOf(ApiResult.Binary.class, result);
            // @formatter:off
            assertEquals("{ \"file\": true }\n", new String(binary.stream().readAllBytes(), StandardCharsets.UTF_8));
            // @formatter:on
        }
    }

    @Test
    void bufferedEventsStillObserveDeadlineAndCancellation() throws Exception {
        try (var client = client(); var cancel = new CancellationToken()) {
            try (var result = client.responses()
                    .create(params(null), new RequestOptions(Duration.ofMillis(150), cancel))) {
                var stream = ((ApiResult.Events) result).stream();
                assertNotNull(stream.next());
                Thread.sleep(200);
                assertThrows(ThinkAIException.class, stream::next);
            }
            try (var result = client.responses()
                    .create(params(null), RequestOptions.withCancellation(cancel))) {
                var stream = ((ApiResult.Events) result).stream();
                assertNotNull(stream.next());
                cancel.cancel();
                assertThrows(ThinkAIException.class, stream::next);
            }
        }
    }

    @Test
    void userAgentReportsPublicRuntimeVersion() throws Exception {
        var local = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        // @formatter:off
        local.createContext("/model", exchange -> {
            byte[] bytes = JSON.writeValueAsBytes(Map.of("user_agent", exchange.getRequestHeaders().getFirst("User-Agent")));
            exchange.getResponseHeaders()
                    .set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            try (var output = exchange.getResponseBody()) {
                output.write(bytes);
            }
        });
        local.start();
        try (var client = ThinkAIClient.builder("offline-token")
                .endpoint(URI.create("http://127.0.0.1:" + local.getAddress().getPort() + "/"))
                .build();
                var result = client.model()
                        .list()) {
            assertEquals("ThinkAI-java/" + ThinkAIClient.VERSION, result.json().path("user_agent").asText());
        } finally {
            local.stop(0);
        }
        // @formatter:on
    }
}
