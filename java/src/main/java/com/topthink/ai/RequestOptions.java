package com.topthink.ai;

import java.time.Duration;

/** null 字段使用客户端默认值；超时覆盖包含响应体和流式读取的操作总时限。 */
public record RequestOptions(Duration timeout, CancellationToken cancellationToken) {
    public RequestOptions {
        if (timeout != null && (timeout.isZero() || timeout.isNegative())) {
            throw new IllegalArgumentException("timeout 必须大于零。");
        }
    }

    public static RequestOptions withCancellation(CancellationToken token) {
        return new RequestOptions(null, token);
    }
}
