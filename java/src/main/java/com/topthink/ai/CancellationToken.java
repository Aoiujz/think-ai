package com.topthink.ai;

import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.CancellationException;

/** 可跨线程取消请求、等待和尚未读完的响应流。 */
public final class CancellationToken implements AutoCloseable {
    @FunctionalInterface
    public interface Registration extends AutoCloseable {
        @Override
        void close();
    }

    private final Set<Runnable> callbacks = new HashSet<>();
    private boolean cancelled;

    public synchronized boolean isCancelled() {
        return cancelled;
    }

    public void cancel() {
        ArrayList<Runnable> pending;
        synchronized (this) {
            if (cancelled) {
                return;
            }
            cancelled = true;
            pending = new ArrayList<>(callbacks);
            callbacks.clear();
            notifyAll();
        }
        for (Runnable callback : pending) {
            callback.run();
        }
    }

    public Registration register(Runnable callback) {
        synchronized (this) {
            if (!cancelled) {
                callbacks.add(callback);
                return () -> {
                    synchronized (this) {
                        callbacks.remove(callback);
                    }
                };
            }
        }
        callback.run();
        return () -> {};
    }

    public void throwIfCancelled() {
        if (isCancelled()) {
            throw new ThinkAIException("操作已取消。", null, "", new CancellationException());
        }
    }

    void pause(Duration duration) {
        synchronized (this) {
            throwIfCancelled();
            try {
                wait(Math.max(1, duration.toMillis()));
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                throw new ThinkAIException("操作已中断。", null, "", error);
            }
            throwIfCancelled();
        }
    }

    @Override
    public void close() {
        cancel();
    }
}
