import asyncio
import io
import json
from pathlib import Path
import re
import time
import tomllib

import httpx
import pytest
from thinkai import Client, AsyncClient, APIError, TransportError, ProtocolError, EventStream, AsyncEventStream, BinaryStream, AsyncBinaryStream, OperationTimeout, __version__

MANIFEST = json.loads((Path(__file__).parents[2] / "tests/contracts/operations.json").read_text(encoding="utf-8"))


def args(operation):
    resource, name = operation["resource"], operation["operation"]
    if resource == "model" and name == "show":
        return ["chat", "fixture-model"]
    if resource == "skill" and name == "categories":
        return []
    if resource == "skill" and name == "download":
        return ["skill.zip"]
    if resource != "sandbox":
        return [{"model": "fixture-model", "unknown": {"nested": [1, False, None]}}]
    return {"create": ["test"], "get": ["test"], "delete": ["test"], "listFile": ["test", "/tmp"], "readFile": ["test", "/tmp/a"], "writeFile": ["test", "/tmp/a", "hello"], "editFile": ["test", "/tmp/a", "hello", "world"], "uploadFile": ["test", "/tmp/a", io.BytesIO(b"upload")], "downloadFile": ["test", "/tmp/a"], "runCode": ["test", "print(1)", [{"url": "https://example.test/a", "name": "a.txt"}]], "runCommand": ["test", "pwd"]}[name]


def method(client, operation):
    snake = (
        re
        .sub(r"(?<!^)(?=[A-Z])", "_", operation["operation"])
        .lower()
    )  # fmt: skip
    return getattr(getattr(client, operation["resource"]), snake)


@pytest.mark.parametrize("operation", MANIFEST, ids=lambda op: op["resource"] + "." + op["operation"])
def test_all_sync_routes(endpoint, operation):
    with Client("offline-token", endpoint=endpoint + "prefix/") as client:
        result = method(client, operation)(*args(operation))
        if isinstance(result, EventStream):
            assert list(result)
        elif isinstance(result, BinaryStream):
            assert result.read()
    entry = (
        httpx
        .get(endpoint + "__requests")
        .json()
    )[-1]  # fmt: skip
    expected = (
        operation["path"]
        .replace("{id}", "test")
        .replace("{type}", "chat")
        .replace("{code}", "fixture-model")
    )  # fmt: skip
    assert entry["method"] == operation["http_method"]
    assert entry["path"] == "/prefix/" + expected
    assert entry["authorization"] == "Bearer offline-token"
    if operation["resource"] == "sandbox" and operation["operation"] == "uploadFile":
        assert entry["content_type"].startswith("multipart/form-data; boundary=")
    if entry["body"] and "unknown" in entry["body"]:
        assert entry["body"]["unknown"] == {"nested": [1, False, None]}
    if operation["operation"] == "runCode":
        assert entry["body"]["files"] == [{"url": "https://example.test/a", "name": "a.txt"}]


@pytest.mark.parametrize("operation", MANIFEST, ids=lambda op: op["resource"] + "." + op["operation"])
def test_all_async_routes(endpoint, operation):
    async def run():
        async with AsyncClient("offline-token", endpoint=endpoint) as client:
            result = await method(client, operation)(*args(operation))
            if isinstance(result, AsyncEventStream):
                assert [event async for event in result]
            elif isinstance(result, AsyncBinaryStream):
                assert await result.read()

    asyncio.run(run())


def test_mock_forwards_json_auth_and_preserves_injected_client():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    injected = httpx.Client(transport=httpx.MockTransport(handler))
    with Client("secret", http_client=injected) as client:
        assert client.chat.completions({"model": "test", "stream": False, "x": [1, None]}) == {"ok": True}
    assert not injected.is_closed
    assert json.loads(seen[0].content) == {"model": "test", "stream": False, "x": [1, None]}
    assert seen[0].headers["Authorization"] == "Bearer secret"
    assert seen[0].headers["User-Agent"] == f"ThinkAI-Python/{__version__}"
    injected.close()


def test_runtime_version_and_async_user_agent_follow_metadata():
    metadata = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    assert __version__ == metadata["version"]

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, json={"agent": request.headers["User-Agent"]}))) as injected:
            async with AsyncClient("test", http_client=injected) as client:
                assert (await client.model.list())["agent"] == f"ThinkAI-Python/{__version__}"

    asyncio.run(run())


def test_mock_error_keeps_status_body_and_does_not_retry():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(429, json={"message": "rate limit", "details": 1})

    with httpx.Client(transport=httpx.MockTransport(handler)) as injected:
        with Client("test", http_client=injected) as client:
            with pytest.raises(APIError) as failure:
                client.images.generations({"model": "test"})
    assert failure.value.status_code == 429
    assert json.loads(failure.value.raw_response)["details"] == 1
    assert len(seen) == 1


def test_recursive_get_query(endpoint):
    payload = {"enabled": False, "tags": ["a", "b"], "filter": {"q": "你好"}, "skip": None}
    expected = {"enabled": "0", "tags[0]": "a", "tags[1]": "b", "filter[q]": "你好"}
    with Client("test", endpoint=endpoint) as client:
        assert client.model.list(payload)["query"] == expected

    async def run():
        async with AsyncClient("test", endpoint=endpoint) as client:
            assert (await client.model.list(payload))["query"] == expected

    asyncio.run(run())


def test_json_file_download_keeps_exact_bytes(endpoint):
    expected = b'{ "file": true }\n'
    with Client("test", endpoint=endpoint) as client:
        with client.sandbox.download_file("test", "fixture.json") as stream:
            assert stream.read() == expected

    async def run():
        async with AsyncClient("test", endpoint=endpoint) as client:
            async with await client.sandbox.download_file("test", "fixture.json") as stream:
                assert await stream.read() == expected

    asyncio.run(run())


@pytest.mark.parametrize("case", ["fragmented-sse", "audio-sse", "responses-error"])
def test_http_sse_variants(endpoint, case):
    with Client("test", endpoint=endpoint) as client:
        events = list(client.responses.create({"model": "test", "input": "hello", "__case": case}))
    assert events
    if case == "responses-error":
        assert any("error" in event.get("chunks", {}) for event in events)


def test_chat_audio_command_types_and_close(endpoint):
    with Client("test", endpoint=endpoint) as client:
        stream = client.chat.completions({"model": "test"})
        assert isinstance(stream, EventStream)
        stream.close()
        assert stream.response.is_closed
        assert isinstance(client.chat.completions({"model": "test", "stream": False}), dict)
        assert list(client.audio.speech({"model": "test", "input": "hello", "voice": "a", "stream": True}))
        assert list(client.sandbox.run_command("test", "pwd", True))
        assert client.sandbox.write_file("test", "a", "hello") is None


@pytest.mark.parametrize("case", ["invalid-json", "invalid-sse", "disconnect"])
def test_invalid_responses(endpoint, case):
    with Client("test", endpoint=endpoint) as client:
        with pytest.raises((ProtocolError, TransportError)):
            result = client.responses.create({"model": "test", "input": "x", "__case": case})
            if isinstance(result, EventStream):
                list(result)


def test_avatar_wait_keeps_original_task_and_surfaces_error(endpoint):
    with Client("test", endpoint=endpoint, poll_interval=0.001) as client:
        assert client.avatar.video({"model": "fixture:wait-success"}, True)["status"] == "success"
        assert client.avatar.video({"model": "fixture:wait-fail"}, True)["status"] == "fail"
        with pytest.raises(APIError) as error:
            client.avatar.video({"model": "fixture:wait-error"}, True)
        assert error.value.status_code == 403
        with pytest.raises(OperationTimeout):
            client.avatar.video({"model": "fixture:wait-timeout"}, 0.02)


def test_sync_total_deadline(endpoint):
    with Client("test", endpoint=endpoint, timeout=0.02) as client:
        with pytest.raises(OperationTimeout):
            list(client.model.list({"__case": "slow", "__delay_ms": 100}))


def test_async_deadline_cancellation_and_stream_errors(endpoint):
    async def run():
        async with AsyncClient("test", endpoint=endpoint, timeout=0.02) as client:
            with pytest.raises(OperationTimeout):
                stream = await client.model.list({"__case": "slow", "__delay_ms": 100})
                [event async for event in stream]
        # Cancel only after the transport is awaiting a body read. A timer-based
        # sleep on the 20 ms client can lose to its deadline on a busy runner.
        entered = asyncio.Event()

        class PendingBody(httpx.AsyncByteStream):
            closed = False

            async def __aiter__(self):
                entered.set()
                await asyncio.Future()
                yield b""

            async def aclose(self):
                self.closed = True

        body = PendingBody()
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=body))) as injected:
            async with AsyncClient("test", http_client=injected) as client:
                assert client.timeout == 300
                stream = await client.model.list()

                async def consume_pending():
                    return [event async for event in stream]

                task = asyncio.create_task(consume_pending())
                try:
                    await asyncio.wait_for(entered.wait(), timeout=5)
                    task.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await task
                    assert stream.response.is_closed
                    assert body.closed
                finally:
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
        async with AsyncClient("test", endpoint=endpoint) as client:
            stream = await client.responses.create({"model": "test", "input": "x", "__case": "invalid-sse"})
            with pytest.raises(ProtocolError):
                [event async for event in stream]
            assert stream.response.is_closed
            events = [event async for event in await client.responses.create({"model": "test", "input": "x", "__case": "fragmented-sse"})]
            assert events

    asyncio.run(run())


def test_async_stream_deadline_does_not_cancel_consumer_work():
    class Waiting(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'data: {"value":1}\n\n'
            await asyncio.sleep(1)
            yield b"data: [DONE]\n\n"

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=Waiting()))) as injected:
            async with AsyncClient("test", timeout=0.02, http_client=injected) as client:
                stream = await client.responses.create({"model": "test"})
                iterator = stream.__aiter__()
                assert await anext(iterator) == {"value": 1}
                # This is application work outside the SDK iterator.
                await asyncio.sleep(0.04)
                with pytest.raises(OperationTimeout):
                    await anext(iterator)

    asyncio.run(run())
