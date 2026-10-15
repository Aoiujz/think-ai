"""HTTP, deadlines and closeable incremental response readers."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any, AsyncIterator, Iterator

import httpx


class APIError(Exception):
    def __init__(self, message: str, status_code: int, raw_response: bytes):
        super().__init__(message)
        self.status_code = status_code
        self.raw_response = raw_response


class TransportError(Exception):
    pass


class OperationTimeout(TransportError):
    pass


class ProtocolError(Exception):
    pass


def _api_error(response: httpx.Response, body: bytes) -> APIError:
    message = body.decode("utf-8", errors="replace") or f"HTTP {response.status_code}"
    try:
        value = json.loads(body)
        if isinstance(value, dict):
            message = str(value.get("message", value.get("error", message)))
    except (ValueError, UnicodeError):
        pass
    return APIError(message, response.status_code, body)


def _decode(body: bytes) -> Any:
    if not body:
        return None
    try:
        return json.loads(body)
    except (ValueError, UnicodeError) as exc:
        raise ProtocolError("Invalid JSON response") from exc


def _event(data: list[str]) -> Any:
    try:
        return json.loads("\n".join(data))
    except (ValueError, UnicodeError) as exc:
        raise ProtocolError("Invalid JSON in SSE event") from exc


def _sse(lines: Iterator[str]) -> Iterator[Any]:
    data: list[str] = []
    for line in lines:
        if line == "":
            if data:
                if "\n".join(data) == "[DONE]":
                    return
                yield _event(data)
                data = []
        elif line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
    if data and "\n".join(data) == "[DONE]":
        return
    if data:
        yield _event(data)
    raise ProtocolError("SSE stream ended before [DONE]")


async def _async_sse(lines: AsyncIterator[str]) -> AsyncIterator[Any]:
    data: list[str] = []
    async for line in lines:
        if line == "":
            if data:
                if "\n".join(data) == "[DONE]":
                    return
                yield _event(data)
                data = []
        elif line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
    if data and "\n".join(data) == "[DONE]":
        return
    if data:
        yield _event(data)
    raise ProtocolError("SSE stream ended before [DONE]")


class _Guard:
    """The watchdog also closes an idle response when its total lifetime expires."""

    def __init__(self, timeout: float):
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self.deadline = time.monotonic() + timeout
        self.response: httpx.Response | None = None
        self.expired = False
        self.timer = threading.Timer(timeout, self._expire)
        self.timer.daemon = True
        self.timer.start()

    def _expire(self) -> None:
        self.expired = True
        if self.response is not None:
            self.response.close()

    def check(self) -> None:
        if self.expired or time.monotonic() >= self.deadline:
            raise OperationTimeout("ThinkAI operation timed out")

    def close(self) -> None:
        self.timer.cancel()


class BinaryStream:
    def __init__(self, response: httpx.Response, guard: _Guard):
        self.response = response
        self._guard = guard
        self._closed = False

    def __iter__(self) -> Iterator[bytes]:
        try:
            self._guard.check()
            for chunk in self.response.iter_bytes():
                self._guard.check()
                yield chunk
            self._guard.check()
        except Exception as exc:
            self._guard.check()
            if isinstance(exc, (OperationTimeout, ProtocolError)):
                raise
            raise TransportError(str(exc)) from exc
        finally:
            self.close()

    def read(self) -> bytes:
        return b"".join(self)

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._guard.close()
            self.response.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class EventStream(BinaryStream):
    def __iter__(self) -> Iterator[Any]:
        try:
            self._guard.check()
            for event in _sse(self.response.iter_lines()):
                self._guard.check()
                yield event
            self._guard.check()
        except Exception as exc:
            self._guard.check()
            if isinstance(exc, (OperationTimeout, ProtocolError)):
                raise
            raise TransportError(str(exc)) from exc
        finally:
            self.close()


class AsyncBinaryStream:
    def __init__(self, response: httpx.Response, deadline: float):
        self.response = response
        self.deadline = deadline
        self._closed = False
        self._timer = (
            asyncio
            .get_running_loop()
            .call_at(deadline, self._expire)
        )  # fmt: skip
        self._close_task: asyncio.Task | None = None

    def _expire(self):
        self._close_task = asyncio.create_task(self.response.aclose())

    async def _timed(self, iterator):
        # Keep timeout contexts around an individual read, never across a yield:
        # user code processing an event must not inherit our task cancellation.
        iterator = iterator.__aiter__()
        while True:
            remaining = self.deadline - (
                asyncio
                .get_running_loop()
                .time()
            )  # fmt: skip
            if remaining <= 0:
                raise OperationTimeout("ThinkAI operation timed out")
            try:
                async with asyncio.timeout(remaining):
                    value = await anext(iterator)
            except StopAsyncIteration:
                return
            yield value

    async def __aiter__(self) -> AsyncIterator[bytes]:
        try:
            if (
                asyncio
                .get_running_loop()
                .time()
            ) >= self.deadline:  # fmt: skip
                raise OperationTimeout("ThinkAI operation timed out")
            async for chunk in self._timed(self.response.aiter_bytes()):
                yield chunk
        except TimeoutError as exc:
            raise OperationTimeout("ThinkAI operation timed out") from exc
        except httpx.HTTPError as exc:
            if (
                asyncio
                .get_running_loop()
                .time()
            ) >= self.deadline:  # fmt: skip
                raise OperationTimeout("ThinkAI operation timed out") from exc
            raise TransportError(str(exc)) from exc
        finally:
            await self.aclose()

    async def read(self) -> bytes:
        return b"".join([chunk async for chunk in self])

    async def aclose(self) -> None:
        if not self._closed:
            self._closed = True
            self._timer.cancel()
            await self.response.aclose()
            if self._close_task is not None:
                await self._close_task

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.aclose()


class AsyncEventStream(AsyncBinaryStream):
    async def __aiter__(self) -> AsyncIterator[Any]:
        try:
            if (
                asyncio
                .get_running_loop()
                .time()
            ) >= self.deadline:  # fmt: skip
                raise OperationTimeout("ThinkAI operation timed out")
            async for event in _async_sse(self._timed(self.response.aiter_lines())):
                yield event
        except TimeoutError as exc:
            raise OperationTimeout("ThinkAI operation timed out") from exc
        except httpx.HTTPError as exc:
            if (
                asyncio
                .get_running_loop()
                .time()
            ) >= self.deadline:  # fmt: skip
                raise OperationTimeout("ThinkAI operation timed out") from exc
            raise TransportError(str(exc)) from exc
        finally:
            await self.aclose()


def request(client: httpx.Client, timeout: float, method: str, url: str, *, force_binary=False, **kwargs):
    guard = _Guard(timeout)
    response = None
    retained = False
    try:
        request = client.build_request(method, url, timeout=timeout, **kwargs)
        response = client.send(request, stream=True)
        guard.response = response
        guard.check()
        if not response.is_success:
            body = response.read()
            guard.check()
            raise _api_error(response, body)
        if force_binary:
            retained = True
            return BinaryStream(response, guard)
        content_type = (
            response.headers
            .get("content-type", "")
            .lower()
        )  # fmt: skip
        if "text/event-stream" in content_type:
            retained = True
            return EventStream(response, guard)
        if "application/json" in content_type or "+json" in content_type:
            body = response.read()
            guard.check()
            return _decode(body)
        # Empty successful responses have no JSON to decode and no stream to own.
        if response.status_code in (204, 205) or response.headers.get("content-length") == "0":
            return None
        retained = True
        return BinaryStream(response, guard)
    except httpx.TimeoutException as exc:
        raise OperationTimeout("ThinkAI operation timed out") from exc
    except httpx.HTTPError as exc:
        guard.check()
        raise TransportError(str(exc)) from exc
    finally:
        if not retained:
            guard.close()
            if response is not None:
                response.close()


async def async_request(client: httpx.AsyncClient, timeout: float, method: str, url: str, *, force_binary=False, **kwargs):
    deadline = (
        asyncio
        .get_running_loop()
        .time()
    ) + timeout  # fmt: skip
    response = None
    retained = False
    try:
        async with asyncio.timeout_at(deadline):
            request = client.build_request(method, url, timeout=timeout, **kwargs)
            response = await client.send(request, stream=True)
            if not response.is_success:
                raise _api_error(response, await response.aread())
            if force_binary:
                retained = True
                return AsyncBinaryStream(response, deadline)
            content_type = (
                response.headers
                .get("content-type", "")
                .lower()
            )  # fmt: skip
            if "text/event-stream" in content_type:
                retained = True
                return AsyncEventStream(response, deadline)
            if "application/json" in content_type or "+json" in content_type:
                return _decode(await response.aread())
            if response.status_code in (204, 205) or response.headers.get("content-length") == "0":
                return None
            retained = True
            return AsyncBinaryStream(response, deadline)
    except TimeoutError as exc:
        raise OperationTimeout("ThinkAI operation timed out") from exc
    except httpx.TimeoutException as exc:
        raise OperationTimeout("ThinkAI operation timed out") from exc
    except httpx.HTTPError as exc:
        raise TransportError(str(exc)) from exc
    finally:
        if response is not None and not retained:
            await response.aclose()
