package com.topthink.ai;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.ObjectMapper;

import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

class EventStreamTest {
    static final class TrackedInput extends ByteArrayInputStream {
        boolean closed;

        TrackedInput(byte[] bytes) {
            super(bytes);
        }

        @Override
        public void close() {
            closed = true;
        }
    }

    @Test
    void metadataNullFieldsAndRepeatedHasNextArePreserved() {
        var source = new TrackedInput(("\ufeff: comment\r\n" + "id: task-1\r\n" + "event: custom\r\n" + "retry: 5000\r\n" + "data: {\"new_field\":null,\r\n" + "data: \"nested\":{\"future\":true}}\r\n\r\n" + "data: [DONE]\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        try (var stream = new EventStream(source, new ObjectMapper(), 200)) {
            assertTrue(stream.hasNext());
            assertTrue(stream.hasNext());
            var event = stream.next();
            assertEquals("custom", event.event());
            assertEquals("task-1", event.id());
            assertEquals("5000", event.retry());
            // @formatter:off
            assertTrue(event.data().get("new_field").isNull());
            assertTrue(event.data().at("/nested/future").asBoolean());
            // @formatter:on
            assertFalse(stream.hasNext());
            assertTrue(source.closed);
        }
    }

    @Test
    void missingDoneIsAnErrorEvenAfterCompleteEvent() {
        var source = new TrackedInput("data: {\"content\":\"ok\"}\n\n".getBytes(StandardCharsets.UTF_8));
        try (var stream = new EventStream(source, new ObjectMapper(), 200)) {
            assertTrue(stream.hasNext());
            stream.next();
            var error = assertThrows(ThinkAIException.class, stream::hasNext);
            assertEquals(200, error.statusCode());
            assertNotNull(error.getCause());
            assertTrue(source.closed);
        }
    }

    @Test
    void invalidUtf8FailsAndClosesResponse() {
        var source = new TrackedInput(new byte[]{'d', 'a', 't', 'a', ':', ' ', (byte) 0xff, '\n', '\n'});
        try (var stream = new EventStream(source, new ObjectMapper(), 200)) {
            assertThrows(ThinkAIException.class, stream::hasNext);
            assertTrue(source.closed);
        }
    }

    @Test
    void earlyCloseReleasesStreamAndDisallowsSecondIteration() {
        var source = new TrackedInput("data: {}\n\ndata: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
        var stream = new EventStream(source, new ObjectMapper(), 200);
        stream.iterator();
        assertThrows(IllegalStateException.class, stream::iterator);
        stream.close();
        assertTrue(source.closed);
        assertFalse(stream.hasNext());
    }
}
