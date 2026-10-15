package com.topthink.ai;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.*;

final class DeadlineInputStream extends FilterInputStream {
    private static final ScheduledExecutorService TIMER =
            Executors.newSingleThreadScheduledExecutor(
                    task -> {
                        var thread = new Thread(task, "thinkai-deadlines");
                        thread.setDaemon(true);
                        return thread;
                    });
    private final int status;
    private volatile boolean timedOut, cancelled;
    private final ScheduledFuture<?> timer;
    private final CancellationToken.Registration cancellation, shutdown;

    DeadlineInputStream(
            InputStream stream,
            int status,
            long remainingNanos,
            CancellationToken token,
            CancellationToken clientClosed) {
        super(stream);
        this.status = status;
        cancellation =
                token.register(
                        () -> {
                            cancelled = true;
                            closeQuietly();
                        });
        shutdown =
                clientClosed.register(
                        () -> {
                            cancelled = true;
                            closeQuietly();
                        });
        timer =
                TIMER.schedule(
                        () -> {
                            timedOut = true;
                            closeQuietly();
                        },
                        Math.max(0, remainingNanos),
                        TimeUnit.NANOSECONDS);
    }

    private void closeQuietly() {
        try {
            in.close();
        } catch (IOException ignored) {
        }
    }

    void check() {
        if (timedOut) {
            throw new ThinkAIException("操作总时限已到。", status, "", new TimeoutException());
        }
        if (cancelled) {
            throw new ThinkAIException("操作已取消。", status, "", new CancellationException());
        }
    }

    @Override
    public int read() throws IOException {
        check();
        try {
            int value = in.read();
            check();
            return value;
        } catch (IOException error) {
            check();
            throw error;
        }
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
        check();
        try {
            int value = in.read(buffer, offset, length);
            check();
            return value;
        } catch (IOException error) {
            check();
            throw error;
        }
    }

    @Override
    public void close() throws IOException {
        timer.cancel(false);
        cancellation.close();
        shutdown.close();
        super.close();
    }
}
