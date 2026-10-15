package com.topthink.ai;

/** HTTP、传输和协议异常；业务事件中的 error/fail 仍作为数据返回。 */
public final class ThinkAIException extends RuntimeException {
    private final Integer statusCode;
    private final String rawBody;
    public ThinkAIException(String message, Integer statusCode, String rawBody, Throwable cause) {
        super(message, cause); this.statusCode = statusCode; this.rawBody = rawBody;
    }
    public ThinkAIException(String message, Integer statusCode, String rawBody) { this(message, statusCode, rawBody, null); }
    public Integer statusCode() { return statusCode; }
    public String rawBody() { return rawBody; }
}
