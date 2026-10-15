# ThinkAI Python SDK

Python 3.11+，版本 1.0.1。安装名 `topthink-think-ai`，导入名 `thinkai`。遵循包内 [Apache-2.0 许可证](LICENSE)。

```bash
pip install topthink-think-ai
```

包发布后可使用上述安装命令；开发时在仓库根目录执行 `pip install -e './python[dev]'`。SDK 只连接 ThinkAI 的原生接口，14 个资源、37 个方法与现有 PHP SDK 对齐；Python 方法采用 snake_case。请求参数使用字典，未知字段不会被 SDK 过滤，实际可用字段由服务端决定。

```python
from thinkai import Client, EventStream

with Client("YOUR_TOKEN", endpoint="https://ai.topthink.com/", timeout=300) as client:
    # Chat 缺省 stream=True；根据实际响应 Content-Type 返回字典或 EventStream。
    result = client.chat.completions(
        {"model": "YOUR_CHAT_MODEL", "messages": [{"role": "user", "content": "你好"}]}
    )
    if isinstance(result, EventStream):
        with result:
            for event in result:
                print(event)
    else:
        print(result)

    result = client.chat.completions(
        {
            "model": "YOUR_CHAT_MODEL",
            "messages": [{"role": "user", "content": "你好"}],
            "stream": False,
        }
    )
```

异步客户端使用 HTTPX AsyncClient。取消请求或流读取可取消其 asyncio Task；提前结束事件消费时使用 `async with` 或 `await stream.aclose()`。

```python
import asyncio
from thinkai import AsyncClient, AsyncEventStream

async def main():
    async with AsyncClient("YOUR_TOKEN") as client:
        result = await client.responses.create(
            {"model": "YOUR_CHAT_MODEL", "input": "你好"}
        )
        if isinstance(result, AsyncEventStream):
            async with result:
                async for event in result:
                    print(event)

asyncio.run(main())
```

Responses 使用 ThinkAI 的事件结构，原样交付 `chunks`、`stats`、`id` 等 JSON；事件中的 error 和异步任务 `status=fail` 也原样交付。SSE `[DONE]` 只用于结束迭代。音频流的事件包含 base64 音频数据，不会自动拼接或转为文件。下载返回 `BinaryStream`/`AsyncBinaryStream`，支持 `read()` 和分块迭代，使用完需关闭；无响应体的成功请求返回 `None`。

以下列出全部方法。模型、图片和文件地址为占位值，请替换为自己的可用参数；不要批量运行这些会生成内容的示例。

```python
with Client("YOUR_TOKEN") as client:
    client.chat.completions({"model": "CHAT", "messages": [], "stream": False})
    # responses.create 返回事件流，按上文示例关闭。
    # client.responses.create({"model": "CHAT", "input": "你好"})

    client.images.generations({"model": "IMAGE", "prompt": "山水"})
    client.images.inpainting({"model": "IMAGE", "image": "IMAGE_URL", "mask": "MASK_URL", "prompt": "树"})
    client.images.outpainting({"model": "IMAGE", "image": "IMAGE_URL", "top": 100})
    client.images.upscale({"model": "IMAGE", "image": "IMAGE_URL"})
    client.images.poster({"model": "IMAGE", "title": "海报", "prompt": "极简"})
    client.images.edit({"model": "IMAGE", "image": "IMAGE_URL", "prompt": "修改背景"})

    video = client.videos.generations({"model": "VIDEO", "prompt": "海浪"})
    client.videos.query({"model": "VIDEO", "id": video["id"]})
    client.audio.speech({"model": "AUDIO", "input": "你好", "voice": "VOICE"})
    client.audio.transcriptions({"model": "ASR", "url": "AUDIO_URL"})
    avatar = client.avatar.video({"model": "AVATAR", "anchor": "ANCHOR", "text": "你好", "voice": "VOICE"})
    client.avatar.query({"model": "AVATAR", "id": avatar["id"]})
    song = client.music.song({"model": "MUSIC", "prompt": "春天"})
    client.music.bgm({"model": "MUSIC", "prompt": "轻松"})
    client.music.query({"model": "MUSIC", "id": song["id"]})
    client.embeddings.create({"model": "EMBEDDING", "input": "你好"})
    client.rerank.create({"model": "RERANK", "query": "问题", "documents": ["文档"]})
    client.decision.evaluate({"model": "DECISION", "state": {}, "questions": []})
    client.plugin.list()
    client.model.list({"type": "chat"})
    client.model.show("chat", "MODEL_CODE")

    client.sandbox.create("demo")
    client.sandbox.get("SANDBOX_ID")
    client.sandbox.list_file("SANDBOX_ID", "/tmp")
    client.sandbox.read_file("SANDBOX_ID", "/tmp/a.txt")
    client.sandbox.write_file("SANDBOX_ID", "/tmp/a.txt", "hello")
    client.sandbox.edit_file("SANDBOX_ID", "/tmp/a.txt", "hello", "world")
    client.sandbox.upload_file("SANDBOX_ID", "/tmp/a.txt", "./a.txt")
    with client.sandbox.download_file("SANDBOX_ID", "/tmp/a.txt") as download:
        data = download.read()
    client.sandbox.run_code("SANDBOX_ID", "print(1)", [])
    client.sandbox.run_command("SANDBOX_ID", "pwd")  # 默认非流式；第三个参数 True 开启 SSE。
    client.sandbox.delete("SANDBOX_ID")
    client.skill.list({"category_id": 1})
    client.skill.categories()
    with client.skill.download("SKILL_PATH_FROM_LIST") as download:
        data = download.read()
```

`AsyncClient` 提供完全相同的资源和参数，方法调用加 `await`；下载用 `async with`、`await download.read()`。上传支持本地路径、二进制文件对象或 bytes，multipart 字段为 path/file，不会替调用方关闭传入文件对象。

Avatar `video(params, wait=False)` 默认立即返回。`wait=True` 等待至多 300 秒；正数指定秒数。每 5 秒查询同一任务 ID，可通过 `poll_interval` 配置。只有 `processing` 继续轮询；`success/fail` 返回原结果；查询异常立即抛出，取消/超时不会重新发起生成。

默认启用 TLS 校验、不自动重试、操作总时限 300 秒（从发请求至读取完整响应，包括 SSE/下载，可配置 `timeout`）。同步流通过 `close()` 取消读取，异步通过 `aclose()` 或 Task 取消；客户端上下文结束时关闭其流。`APIError.status_code/raw_response` 保存失败 HTTP 状态及原始 bytes；网络失败为 `TransportError`，超时为 `OperationTimeout`，无效 JSON/不完整 SSE 为 `ProtocolError`。

可注入 `http_client=httpx.Client(...)` 或 `httpx.AsyncClient(...)` 用于代理、测试或连接配置；SDK 不负责关闭调用方传入的 HTTP 客户端。自定义 transport 必须正确响应 HTTPX 的关闭和超时机制。

```bash
# 仓库根目录；测试只使用 MockTransport 和 localhost，不调用真实 ThinkAI。
python -m pytest python/tests -q
python -m build python
python python/scripts/check_package.py
```

代码格式使用开发依赖中的固定版本 Ruff 0.17.0，统一配置位于 `python/pyproject.toml`，行宽 100，目标 Python 3.11。以下命令在仓库根目录运行，覆盖 Python SDK 和跨目录 Python 开发脚本；只运行 formatter，嵌入的其他语言代码字符串保持原样。

```bash
python -m ruff format --config python/pyproject.toml python java/scripts dotnet/scripts tests/php tests/packaging scripts/central-bundle.py
python -m ruff format --check --config python/pyproject.toml python java/scripts dotnet/scripts tests/php tests/packaging scripts/central-bundle.py
```
