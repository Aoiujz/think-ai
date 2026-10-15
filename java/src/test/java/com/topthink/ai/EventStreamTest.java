package com.topthink.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import static org.junit.jupiter.api.Assertions.*;

class EventStreamTest {
    static final class TrackedInput extends ByteArrayInputStream {
        boolean closed;
        TrackedInput(byte[] bytes) { super(bytes); }
        @Override public void close() { closed = true; }
    }
    @Test void metadataNullFieldsAndRepeatedHasNextArePreserved() {
        var source = new TrackedInput(("\ufeff: comment\r\nid: task-1\r\nevent: custom\r\nretry: 5000\r\ndata: {\"new_field\":null,\r\ndata: \"nested\":{\"future\":true}}\r\n\r\ndata: [DONE]\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        try (var stream = new EventStream(source, new ObjectMapper(), 200)) {
            assertTrue(stream.hasNext()); assertTrue(stream.hasNext()); var event = stream.next();
            assertEquals("custom", event.event()); assertEquals("task-1", event.id()); assertEquals("5000", event.retry()); assertTrue(event.data().get("new_field").isNull()); assertTrue(event.data().at("/nested/future").asBoolean());
            assertFalse(stream.hasNext()); assertTrue(source.closed);
        }
    }
    @Test void missingDoneIsAnErrorEvenAfterCompleteEvent() {
        var source = new TrackedInput("data: {\"content\":\"ok\"}\n\n".getBytes(StandardCharsets.UTF_8));
        try (var stream = new EventStream(source, new ObjectMapper(), 200)) {
            assertTrue(stream.hasNext()); stream.next(); var error = assertThrows(ThinkAIException.class, stream::hasNext); assertEquals(200, error.statusCode()); assertNotNull(error.getCause()); assertTrue(source.closed);
        }
    }
    @Test void invalidUtf8FailsAndClosesResponse() {
        var source = new TrackedInput(new byte[] {'d','a','t','a',':',' ',(byte)0xff,'\n','\n'});
        try (var stream = new EventStream(source, new ObjectMapper(), 200)) { assertThrows(ThinkAIException.class, stream::hasNext); assertTrue(source.closed); }
    }
    @Test void earlyCloseReleasesStreamAndDisallowsSecondIteration() {
        var source = new TrackedInput("data: {}\n\ndata: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
        var stream = new EventStream(source, new ObjectMapper(), 200); stream.iterator(); assertThrows(IllegalStateException.class, stream::iterator); stream.close(); assertTrue(source.closed); assertFalse(stream.hasNext());
    }
}
