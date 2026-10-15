package com.topthink.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.NoSuchElementException;

/** 单次读取、可关闭的 SSE 迭代器，保留 ThinkAI 自有事件的数据及元数据。 */
public final class EventStream
        implements Iterable<EventStream.Event>, Iterator<EventStream.Event>, AutoCloseable {
    public record Event(String event, String id, String rawData, JsonNode data, String retry) {}

    private final BufferedReader reader;
    private final InputStream stream;
    private final ObjectMapper mapper;
    private final int status;
    private Event pending;
    private String lastId;
    private boolean finished, iterated;

    EventStream(InputStream stream, ObjectMapper mapper, int status) {
        this.stream = stream;
        this.reader =
                new BufferedReader(
                        new InputStreamReader(
                                stream,
                                StandardCharsets.UTF_8
                                        .newDecoder()
                                        .onMalformedInput(
                                                java.nio.charset.CodingErrorAction.REPORT)));
        this.mapper = mapper;
        this.status = status;
    }

    private void checkActive() {
        if (stream instanceof DeadlineInputStream deadline) {
            deadline.check();
        }
    }

    @Override
    public Iterator<Event> iterator() {
        if (iterated) {
            throw new IllegalStateException("事件流只能读取一次。");
        }
        iterated = true;
        return this;
    }

    @Override
    public boolean hasNext() {
        checkActive();
        if (pending != null) {
            return true;
        }
        if (finished) {
            return false;
        }
        var data = new ArrayList<String>();
        String eventName = null, retry = null;
        try {
            while (true) {
                checkActive();
                String line = reader.readLine();
                if (line == null) {
                    throw new ThinkAIException(
                            "事件流在 [DONE] 前截断。",
                            status,
                            String.join("\n", data),
                            new java.io.EOFException());
                }
                if (line == null || line.isEmpty()) {
                    if (!data.isEmpty()) {
                        String raw = String.join("\n", data);
                        if (raw.trim().equals("[DONE]")) {
                            close();
                            return false;
                        }
                        JsonNode parsed;
                        try {
                            parsed = mapper.readTree(raw);
                        } catch (java.io.IOException error) {
                            throw new ThinkAIException("无效 SSE JSON。", status, raw, error);
                        }
                        if (parsed == null) {
                            throw new ThinkAIException("无效 SSE JSON。", status, raw);
                        }
                        checkActive();
                        pending = new Event(eventName, lastId, raw, parsed, retry);
                        if (line == null) {
                            close();
                        }
                        return true;
                    }
                    if (line == null) {
                        close();
                        return false;
                    }
                    eventName = null;
                    retry = null;
                    continue;
                }
                if (line.charAt(0) == '\ufeff') {
                    line = line.substring(1);
                }
                if (line.startsWith(":")) {
                    continue;
                }
                int colon = line.indexOf(':');
                String field = colon < 0 ? line : line.substring(0, colon);
                String value = colon < 0 ? "" : line.substring(colon + 1);
                if (value.startsWith(" ")) {
                    value = value.substring(1);
                }
                switch (field) {
                    case "data" -> data.add(value);
                    case "event" -> eventName = value;
                    case "id" -> {
                        if (value.indexOf('\0') < 0) {
                            lastId = value;
                        }
                    }
                    case "retry" -> retry = value;
                    default -> {}
                }
            }
        } catch (RuntimeException error) {
            close();
            throw error;
        } catch (java.io.IOException error) {
            close();
            throw new ThinkAIException("读取事件流失败。", status, "", error);
        }
    }

    @Override
    public Event next() {
        if (!hasNext()) {
            throw new NoSuchElementException();
        }
        Event result = pending;
        pending = null;
        return result;
    }

    @Override
    public void close() {
        if (finished) {
            return;
        }
        finished = true;
        try {
            reader.close();
        } catch (java.io.IOException error) {
            throw new ThinkAIException("关闭事件流失败。", status, "", error);
        }
    }
}
