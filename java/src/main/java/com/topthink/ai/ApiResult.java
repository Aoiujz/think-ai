package com.topthink.ai;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.InputStream;

/** 按实际 Content-Type 判别的结果；Binary 与 Events 必须在 try-with-resources 中消费。 */
public sealed interface ApiResult extends AutoCloseable permits ApiResult.Json, ApiResult.Events, ApiResult.Binary, ApiResult.Empty {
    int statusCode();
    @Override default void close() { }
    default JsonNode json() {
        if (this instanceof Json result) return result.value();
        throw new IllegalStateException("响应不是 JSON。");
    }
    record Json(int statusCode, JsonNode value) implements ApiResult { }
    record Empty(int statusCode) implements ApiResult { }
    record Events(int statusCode, EventStream stream) implements ApiResult { @Override public void close() { stream.close(); } }
    record Binary(int statusCode, InputStream stream) implements ApiResult {
        @Override public void close() {
            try { stream.close(); } catch (java.io.IOException error) { throw new ThinkAIException("关闭响应失败。", statusCode, "", error); }
        }
    }
}
