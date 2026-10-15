"""Synchronous and asynchronous ThinkAI clients."""

from __future__ import annotations

import httpx
import weakref
from . import resources
from ._version import __version__
from .transport import request, async_request, BinaryStream, AsyncBinaryStream

_RESOURCES = (
    "chat",
    "responses",
    "images",
    "videos",
    "audio",
    "avatar",
    "music",
    "embeddings",
    "rerank",
    "decision",
    "plugin",
    "model",
    "sandbox",
    "skill",
)


def _query(params):
    result = []

    def append(key, value):
        if value is None:
            return
        if isinstance(value, dict):
            for child, item in value.items():
                append(f"{key}[{child}]", item)
        elif isinstance(value, (list, tuple)):
            for index, item in enumerate(value):
                append(f"{key}[{index}]", item)
        else:
            result.append((key, "1" if value is True else "0" if value is False else str(value)))

    for key, value in params.items():
        append(key, value)
    return result


class Client:
    chat: resources.Chat
    responses: resources.Responses
    images: resources.Images
    videos: resources.Videos
    audio: resources.Audio
    avatar: resources.Avatar
    music: resources.Music
    embeddings: resources.Embeddings
    rerank: resources.Rerank
    decision: resources.Decision
    plugin: resources.Plugin
    model: resources.Model
    sandbox: resources.Sandbox
    skill: resources.Skill

    def __init__(
        self,
        token: str,
        *,
        endpoint: str = "https://ai.topthink.com/",
        timeout: float = 300,
        poll_interval: float = 5,
        http_client: httpx.Client | None = None,
    ):
        if timeout <= 0 or poll_interval < 0:
            raise ValueError("timeout must be positive and poll_interval non-negative")
        self.endpoint = endpoint.rstrip("/") + "/"
        self.timeout = timeout
        self.poll_interval = poll_interval
        self._http = http_client or httpx.Client()
        self._owned = http_client is None
        self._headers = {
            "Authorization": f"Bearer {token}",
            "User-Agent": f"ThinkAI-Python/{__version__}",
            "Accept": "application/json",
        }
        self._streams: weakref.WeakSet[BinaryStream] = weakref.WeakSet()
        for name in _RESOURCES:
            setattr(self, name, getattr(resources, name.capitalize())(self))

    def _request(
        self, method, path, *, body=None, query=None, timeout=None, binary=False, **kwargs
    ):
        if body is not None:
            kwargs["json"] = body
        if query is not None:
            kwargs["params"] = _query(query)
        result = request(
            self._http,
            self.timeout if timeout is None else timeout,
            method,
            self.endpoint + path,
            force_binary=binary,
            headers=self._headers,
            **kwargs,
        )
        if isinstance(result, BinaryStream):
            self._streams.add(result)
        return result

    def close(self):
        for stream in self._streams:
            stream.close()
        self._streams.clear()
        if self._owned:
            self._http.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


class AsyncClient:
    chat: resources.AsyncChat
    responses: resources.AsyncResponses
    images: resources.AsyncImages
    videos: resources.AsyncVideos
    audio: resources.AsyncAudio
    avatar: resources.AsyncAvatar
    music: resources.AsyncMusic
    embeddings: resources.AsyncEmbeddings
    rerank: resources.AsyncRerank
    decision: resources.AsyncDecision
    plugin: resources.AsyncPlugin
    model: resources.AsyncModel
    sandbox: resources.AsyncSandbox
    skill: resources.AsyncSkill

    def __init__(
        self,
        token: str,
        *,
        endpoint: str = "https://ai.topthink.com/",
        timeout: float = 300,
        poll_interval: float = 5,
        http_client: httpx.AsyncClient | None = None,
    ):
        if timeout <= 0 or poll_interval < 0:
            raise ValueError("timeout must be positive and poll_interval non-negative")
        self.endpoint = endpoint.rstrip("/") + "/"
        self.timeout = timeout
        self.poll_interval = poll_interval
        self._http = http_client or httpx.AsyncClient()
        self._owned = http_client is None
        self._headers = {
            "Authorization": f"Bearer {token}",
            "User-Agent": f"ThinkAI-Python/{__version__}",
            "Accept": "application/json",
        }
        self._streams: weakref.WeakSet[AsyncBinaryStream] = weakref.WeakSet()
        for name in _RESOURCES:
            setattr(self, name, getattr(resources, "Async" + name.capitalize())(self))

    async def _request(
        self, method, path, *, body=None, query=None, timeout=None, binary=False, **kwargs
    ):
        if body is not None:
            kwargs["json"] = body
        if query is not None:
            kwargs["params"] = _query(query)
        result = await async_request(
            self._http,
            self.timeout if timeout is None else timeout,
            method,
            self.endpoint + path,
            force_binary=binary,
            headers=self._headers,
            **kwargs,
        )
        if isinstance(result, AsyncBinaryStream):
            self._streams.add(result)
        return result

    async def aclose(self):
        for stream in self._streams:
            await stream.aclose()
        self._streams.clear()
        if self._owned:
            await self._http.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.aclose()
