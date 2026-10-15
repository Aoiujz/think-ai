# SDK 协议与一致性约定

本次以 PHP SDK 的 14 类资源、37 个公开方法为功能基线，使用附加 ThinkAI 服务端的公开控制器核对 HTTP 协议。SDK 不依赖、复制或修改服务端项目；后台接口、第三方兼容入口、音色列表及 Sandbox language 参数不属于此次新增方法范围。

## 客户端与返回值

- 默认 API 根地址 `https://ai.topthink.com/`；相对路径不添加 `/api` 或 `/v1`。自定义 Endpoint 的路径前缀应保留。
- 鉴权为 `Authorization: Bearer <token>`。JSON 字段按原名传输，保留未知扩展字段、false、空数组和显式 null；SDK 不按模型或渠道筛参数。
- GET 查询沿用 PHP 的括号编码：嵌套字段用 key[field]、数组用 key[0]，布尔值为 1/0，null 不写入查询。共用 query-parameters.json 提供一致性样例。
- 成功 JSON 直接返回，不添加统一 data 外壳。列表、分页、任务结果保留各接口原始结构；空成功响应是有效结果。
- Python/TS 返回 JSON 或可关闭事件/二进制流；Go/Java/C# 使用可判别结果类型，区分 JSON、SSE、binary、empty。
- Chat 缺省流式，显式 `stream=false` 请求 JSON；最终根据响应 Content-Type 判别，不能仅依请求参数断言返回类型。Responses 使用 ThinkAI 自有 chunks/stats/id 事件，不套用 OpenAI Responses 数据模型。
- Audio speech 的 SSE 是含 Base64 数据的 JSON 事件。需要保存音频时逐块 Base64 解码，再按顺序拼接字节；Sandbox 与 Skill 下载是真正的二进制流。
- 下载操作的成功响应始终按原始文件字节读取，包括 Content-Type 为 application/json 的 JSON 文件；HTTP 错误仍按客户端错误规则处理。
- SSE 支持 UTF-8 跨块、CRLF、多行 data、注释，`[DONE]` 结束且不作为事件返回。合法 JSON 事件中的业务错误原样交付；网络和解析失败通过异常/错误报告。提前停止消费需要关闭流。
- 未收到 `[DONE]` 就断流时，新 SDK 报告不完整事件流；用户主动关闭不作为正常完整响应记录。
- 新 SDK 默认 TLS 验证、无自动重试；总操作时限默认 300 秒且可配置，覆盖读取响应，调用方可取消。注入的 HTTP 客户端由调用方持有。
- HTTP 非成功错误保留状态、原始响应及原因。异步任务 `status=fail` 与 Responses 事件内错误属于正常解码结果，不混为 HTTP 失败。
- Videos/Music 使用生成与 query 分离；Avatar 默认不等待，启用后默认 300 秒、5 秒间隔，仅查询原生成 ID。HTTP/网络查询异常不吞掉，超时和取消释放请求。
- Avatar 的等待计时从创建结果返回后开始，与创建请求自身超时独立。仅 processing 继续查询，success/fail 返回原结果；缺失或未知状态报告协议错误。

PHP 本次仅迁移目录，源码运行行为保持原样，包括原有返回值与传输配置。新增 SDK 提供完整 SSE 分帧和现代客户端配置，文档明确这些行为差异；不为 PHP 迁移引入顺手修复。

## 方法矩阵

方法名以 PHP 基线记录；Python 使用 snake_case，Go/C# 使用各自惯用大小写。Sandbox 路径 id 对应 PHP 某些方法中命名为 name 的位置参数。

| 资源.方法 | HTTP | 相对路径 | 响应类别 |
| --- | --- | --- | --- |
| `chat.completions` | POST | `chat/completions` | auto |
| `responses.create` | POST | `responses` | sse |
| `images.generations` | POST | `images/generations` | json |
| `images.inpainting` | POST | `images/inpainting` | json |
| `images.outpainting` | POST | `images/outpainting` | json |
| `images.upscale` | POST | `images/upscale` | json |
| `images.poster` | POST | `images/poster` | json |
| `images.edit` | POST | `images/edit` | json |
| `videos.generations` | POST | `videos/generations` | json |
| `videos.query` | POST | `videos/query` | json |
| `audio.speech` | POST | `audio/speech` | auto |
| `audio.transcriptions` | POST | `audio/transcriptions` | json |
| `avatar.video` | POST | `avatar/video` | json |
| `avatar.query` | POST | `avatar/query` | json |
| `music.song` | POST | `music/song` | json |
| `music.bgm` | POST | `music/bgm` | json |
| `music.query` | POST | `music/query` | json |
| `embeddings.create` | POST | `embeddings` | json |
| `rerank.create` | POST | `rerank` | json |
| `decision.evaluate` | POST | `decisions` | json |
| `plugin.list` | GET | `plugin` | json |
| `model.list` | GET | `model` | json |
| `model.show` | GET | `model/{type}/{code}` | json |
| `sandbox.create` | POST | `sandbox` | json |
| `sandbox.get` | GET | `sandbox/{id}` | json |
| `sandbox.delete` | DELETE | `sandbox/{id}` | empty |
| `sandbox.listFile` | GET | `sandbox/{id}/list` | json |
| `sandbox.readFile` | GET | `sandbox/{id}/read` | json |
| `sandbox.writeFile` | POST | `sandbox/{id}/write` | empty |
| `sandbox.editFile` | POST | `sandbox/{id}/edit` | empty |
| `sandbox.uploadFile` | POST | `sandbox/{id}/upload` | empty |
| `sandbox.downloadFile` | GET | `sandbox/{id}/download` | binary |
| `sandbox.runCode` | POST | `sandbox/{id}/code` | json |
| `sandbox.runCommand` | POST | `sandbox/{id}/command` | auto |
| `skill.list` | GET | `skill` | json |
| `skill.categories` | GET | `skill/category` | json |
| `skill.download` | GET | `skill/download` | binary |

## 开发与发布边界

各语言独立构建，六种 SDK 当前版本统一为 1.0.1，全部支持手动显式发布。prepare/publish 默认只预演；只有 --execute 才正式执行。PHP 使用根 v*、Go 子模块使用 go/v*：正式发布推送精确版本标签并查询 Packagist/Go 索引，不上传包文件。Python、TypeScript、Java、C# 正式发布推送各自 python/v*、typescript/v*、java/v*、dotnet/v* 标签并上传平台。

PHP/Go 索引尚未可见时记录 index-pending，可再次手动执行或只读 verify；新的 Go 稳定版本需要公开版本标签。CI 只测试、打包和保留构建产物，不自动发布任何 SDK，也不推送任何标签。

根 Composer 指向 php/src；Git export-ignore 保证 PHP dist 包不包含其他 SDK。Git source 安装含完整仓库。其他语言由自身打包清单控制内容，Go 模块使用 Go 自身模块归档流程。

本轮只构建、离线测试和本地消费者安装，不登录注册 npm/PyPI/Maven/NuGet、不创建公开版本、不调用真实付费 API。包名可用性、发布权限、真实模型支持和线上响应需分别验证。
