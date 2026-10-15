# ThinkAI Java SDK

Java 17+；Maven 坐标 `com.topthink:think-ai:1.0.1`，包名 `com.topthink.ai`。HTTP 使用 JDK `HttpClient`，JSON 使用 Jackson。SDK 覆盖 PHP 当前的 14 类资源、37 个操作。此仓库提供可打包代码，包是否公开发布以仓库发布记录为准。

```xml
<dependency>
  <groupId>com.topthink</groupId>
  <artifactId>think-ai</artifactId>
  <version>1.0.1</version>
</dependency>
```

从源码使用时先在 `java/` 执行 `mvn install`，消费者即可从本地 Maven 仓库解析以上坐标。SDK 不包含其他语言源码。

## 客户端和响应

```java
import com.topthink.ai.*;
import java.net.URI;
import java.net.http.HttpClient;
import java.time.Duration;
import java.util.*;

try (var client = ThinkAIClient.builder(System.getenv("THINKAI_TOKEN"))
        .endpoint(URI.create("https://ai.topthink.com/"))
        .timeout(Duration.ofSeconds(300))
        .pollInterval(Duration.ofSeconds(5))
        .httpClient(HttpClient.newHttpClient()) // 可选；SDK 不改变注入客户端配置
        .build()) {
    try (var result = client.chat().completions(Map.of("model", "你的模型", "stream", false, "messages", List.of(Map.of("role", "user", "content", "你好"))))) {
        if (result instanceof ApiResult.Json json) {
            System.out.println(json.value());
        }
    }
}
```

参数为 `Map<String, ?>`，可嵌套 Map、List、JsonNode；字段名和未知字段保留，SDK 不筛选模型参数。显式 JSON `null` 请用 `HashMap`/`LinkedHashMap`，因为 `Map.of` 禁止 null。GET 查询递归编码为 PHP 风格的 `filter[q]`、`tags[0]`，布尔值为 `1/0`，null 查询值省略。路径中的 ID/type/code 按单个路径段转义。

所有请求返回封闭类型 `ApiResult`：`Json`（Jackson `JsonNode`）、`Events`、`Binary` 或 `Empty`。按服务器实际 Content-Type 判别，包括 Chat/Audio/Command；下载操作始终返回原始 Binary，JSON 文件也不会被重写。HTTP 204/205 返回 Empty。`Json.value()` 可为 JSON null，不应当作 Empty。

```java
try (var result = client.chat().completions(Map.of("model", "你的模型", "messages", List.of(Map.of("role", "user", "content", "你好"))))) {
    if (result instanceof ApiResult.Events events) {
        for (var event : events.stream()) {
            System.out.println(event.data()); // 保留原始事件数据
            // event.event(), event.id(), event.rawData(), event.retry()
        }
    } else if (result instanceof ApiResult.Json json) {
        System.out.println(json.value());
    }
}
```

Chat 未传 `stream` 时发送 `true`，显式 false 请求 JSON。Responses 是 ThinkAI 自有 `chunks`、`stats`、`id` 事件，不能按其他厂商事件模型解析。SSE 支持 UTF-8 分块、多行 data、CRLF 和注释，`[DONE]` 结束；格式错误或在 DONE 前断开会抛异常。合法 JSON 事件内的 `error` 原样交付。

## 全部资源操作

以下是独立调用片段，`p` 是按所用模型填写的动态参数；流式/二进制结果须像上文一样关闭。参数示例仅说明 SDK 用法。

```java
Map<String, Object> p = new LinkedHashMap<>();
p.put("model", "你的模型");
p.put("prompt", "示例输入");

client.responses().create(p);
client.chat().completions(p);
client.images().generations(p);
client.images().inpainting(p);
client.images().outpainting(p);
client.images().upscale(p);
client.images().poster(p);
client.images().edit(p);
client.videos().generations(p);
client.videos().query(Map.of("model", "你的模型", "id", "创建时返回的任务ID"));
client.audio().speech(p); // 可能为 JSON、SSE 或二进制
client.audio().transcriptions(p);
client.avatar().video(p); // 默认立即返回任务
client.avatar().query(Map.of("model", "你的模型", "id", "创建时返回的任务ID"));
client.music().song(p);
client.music().bgm(p);
client.music().query(Map.of("model", "你的模型", "id", "任务ID"));
client.embeddings().create(p);
client.rerank().create(p);
client.decision().evaluate(p);
client.plugin().list(Map.of());
client.model().list(Map.of("type", "chat"));
client.model().show("chat", "模型代码");
client.sandbox().create("demo"); // 也可 create()，name 为 null
client.sandbox().get("sandbox-id");
client.sandbox().listFile("sandbox-id", "/workspace");
client.sandbox().readFile("sandbox-id", "/workspace/main.py");
client.sandbox().writeFile("sandbox-id", "/workspace/main.py", "print('hello')");
client.sandbox().editFile("sandbox-id", "/workspace/main.py", "hello", "你好");
client.sandbox().uploadFile("sandbox-id", "/workspace/input.txt", java.nio.file.Path.of("input.txt"));
client.sandbox().downloadFile("sandbox-id", "/workspace/output.bin");
client.sandbox().runCode("sandbox-id", "print('hello')", List.of(Map.of("url", "https://example.com/input.txt", "name", "input.txt")));
client.sandbox().runCommand("sandbox-id", "echo hello", true);
client.sandbox().delete("sandbox-id");
client.skill().list(Map.of("category_id", 1));
client.skill().categories();
client.skill().download("列表返回的技能包路径");
```

上传同时接受 `Path` 或 `InputStream`，multipart 字段固定为 `path` 和 `file`，文件名取远端 path 的 basename。调用者传入的流由调用者关闭。下载保存例：

```java
try (var result = client.sandbox().downloadFile("sandbox-id", "/workspace/output.bin")) {
    if (result instanceof ApiResult.Binary binary) {
        java.nio.file.Files.copy(binary.stream(), java.nio.file.Path.of("output.bin"), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
    }
}
```

## 等待、取消和错误

```java
try (var cancellation = new CancellationToken()) {
    var options = new RequestOptions(Duration.ofSeconds(60), cancellation);
    // 另一线程可以调用 cancellation.cancel()。
    try (var result = client.avatar().video(p, true, Duration.ofSeconds(300), Duration.ofSeconds(5), options)) {
        System.out.println(result.json());
    }
    // 其他方法以最后一个参数传 options，例如 client.images().generations(p, options)。
}
```

Avatar 等待从收到创建结果后计时，只轮询原始 ID/model。`processing` 继续，`success`/`fail` 原样返回；HTTP/协议错误立即抛出，未知或缺少 status 报协议错误。默认等待 300 秒、间隔 5 秒，可分别配置。创建请求单独受客户端操作时限约束。

客户端默认操作总时限 300 秒，覆盖等待响应头和读取完整 JSON/SSE/二进制响应；请求级 `RequestOptions.timeout` 可覆盖。调用者取消、线程中断和关闭客户端会终止活动请求；流式读取也受取消与同一时限约束。注入客户端由调用者持有，JDK17 没有 HttpClient.close，SDK 通过自身取消源终止它发起的请求。

```java
try { client.images().generations(p); }
catch (ThinkAIException error) {
    System.err.println(error.statusCode()); // 传输错误可为 null
    System.err.println(error.rawBody());
    System.err.println(error.getCause());   // 存在底层异常时保留
}
```

SDK 不自动重试，避免生成/上传任务被重复创建。默认启用 JDK 的 TLS 验证；自定义 HttpClient 的 TLS/代理配置由调用者负责。

## 代码格式

在仓库根使用 JDK 17 执行：

```sh
mvn -f java/pom.xml -B spotless:apply
mvn -f java/pom.xml -B spotless:check
```

配置固定为 Spotless Maven 3.10.4 与 Eclipse JDT 4.26，Java 主源码和测试使用 `eclipse-formatter.xml` 的 4 空格缩进。普通方法签名和调用的参数保持单行，合并已有参数换行，不强制按 100 列拆分，也不重新切分字符串；匿名函数和匿名类的块内容仍可分行。控制语句使用大括号，非空方法体、条件和循环体展开为多行。POM 使用 Eclipse WTP 4.21.0 与 `xml-format.properties` 的 2 空格 XML 排版，保留元素顺序。格式化不绑定 `verify`，CI 在 JDK 17 上单独执行 `spotless:check`。Maven 接入见 [Spotless 文档](https://github.com/diffplug/spotless/tree/main/plugin-maven#eclipse-jdt)，参数换行、合并和代码块选项见 [Eclipse 官方格式配置](https://help.eclipse.org/latest/topic/org.eclipse.jdt.doc.isv/reference/api/org/eclipse/jdt/core/formatter/DefaultCodeFormatterConstants.html)。

## 离线验证与打包

在仓库根运行：

```sh
mvn -f java/pom.xml -B verify
python java/scripts/verify_package.py
```

JUnit 测试自动启动共享 Node.js loopback 服务，逐项调用 37 个操作并验证流式、异常、取消、轮询、multipart 和下载字节。消费者脚本实际安装 JAR 到隔离 Maven 本地仓库，再创建仅依赖发布坐标的消费者编译运行。产物位于 `java/target/`，包含主 JAR、sources、javadoc 和 Apache LICENSE。测试不会访问 ThinkAI 真 API，也不发布包。

## 发布到 Maven Central

Java 版本独立维护，正式 tag 为 `java/v版本号`。仓库统一发布入口负责版本、检查和发布；Java 的账号、namespace、GPG 与 Maven settings 准备见 [发布说明](PUBLISHING.md)。普通 `mvn verify`/`mvn install` 不签名、不上传。只有显式启用 `release` profile 才会加载签名及 Central 发布插件。
