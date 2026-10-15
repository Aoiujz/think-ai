# 离线 HTTP 契约

`operations.json` 固定当前 PHP SDK 的 14 类资源、37 个方法。以 SDK 方法清单为覆盖基线，以附加 ThinkAI 源码的公开控制器为协议依据；不含后台 API、兼容协议入口及服务端尚未封装的新方法。

运行 `node tests/contracts/server.mjs` 会监听随机本地端口，并在第一行输出 `endpoint`。也可设置 `PORT`。导入 `createContractServer()` 可在测试中管理生命周期。所有业务接口要求 Bearer header，任意离线 Token 均可。

默认 JSON 回显 HTTP 方法、路径、查询参数、JSON body、鉴权及 multipart 原始内容（base64）。Chat 缺省 SSE、显式 `stream=false` 返回 JSON；Responses 为 ThinkAI chunks/stats/id 事件；Audio speech 和 Sandbox command 根据 stream 参数返回 SSE；下载返回固定二进制字节，Sandbox 写入/上传/删除返回空成功响应。

下载路径参数 `path=fixture.json` 返回带 `application/json` Content-Type 的文件，原始内容为 `{ "file": true }` 加换行；新 SDK 应保持下载流和字节，不能按普通 API JSON 解析或重写。

可在 JSON body 或查询参数加入 `__case`（仅此测试服务支持）：

| 值 | 响应 |
| --- | --- |
| json | 强制 Chat 返回 JSON，用于验证实际 Content-Type 判别 |
| sse / fragmented-sse | SSE / 按字节分块，含 UTF-8、多行 data、CRLF、注释和 DONE |
| audio-sse | 两块音频 Base64 JSON 事件 |
| responses-error | Responses chunks.error，HTTP 仍为 200 |
| error / http-error | HTTP 错误；可用 `__status` 指定状态码，默认 400 |
| invalid-json / invalid-sse | 格式错误 |
| empty / binary | 空成功响应 / 固定二进制 |
| slow | 延迟 SSE，可用 `__delay_ms` 指定延迟 |
| disconnect | 中途断开 SSE |
| wait-success / wait-fail / wait-error / wait-timeout | Avatar 创建及原任务 ID 轮询场景 |

`GET /__requests` 查看捕获请求，`POST /__reset` 清空状态，`GET /__health` 检查服务。测试样例证明的是 SDK 对离线 HTTP 协议的处理，不能作为线上模型输出或计费验收。
